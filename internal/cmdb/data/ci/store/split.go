package store

import (
	"context"
	"fmt"

	"gorm.io/gorm"
)

// The read-only plan for splitting the overloaded vocabulary.
//
// IT WRITES NOTHING. The split moves model rules and instance edges between
// relation types; that is a data migration with a backup and reconciliation,
// not something a page request or a boot should decide. This planner turns the
// current (relation type, parent model, child model) rows into a proposed target
// per pair so an operator can review the ambiguous cases first.
//
// REVIEW MEANS "the pair can be argued either way". A caller must not treat a
// reviewed row as approved; the direction-inverted rows need an inverse
// adapter, just like contain/manage.
type SplitPlanRow struct {
	RelationType      string `json:"relation_type"`
	ParentModel       string `json:"parent_model"`
	ChildModel        string `json:"child_model"`
	Constraint        string `json:"constraint"`
	Edges             int64  `json:"edges"`
	Target            string `json:"target"`
	Review            bool   `json:"review,omitempty"`
	DirectionInverted bool   `json:"direction_inverted,omitempty"`
}

type SplitPlanReport struct {
	Rows            []SplitPlanRow   `json:"rows"`
	Totals          map[string]int64 `json:"totals"`
	TargetRules     map[string]int   `json:"target_rules"`
	TotalEdges      int64            `json:"total_edges"`
	UnresolvedRules int              `json:"unresolved_rules"`
	UnresolvedEdges int64            `json:"unresolved_edges"`
}

type splitRow struct {
	RelationType string `gorm:"column:rel"`
	ParentModel  string `gorm:"column:parent"`
	ChildModel   string `gorm:"column:child"`
	Constraint   string `gorm:"column:cons"`
	Edges        int64  `gorm:"column:edges"`
}

var splitQuery = `
SELECT rt.name AS rel, p.name AS parent, c.name AS child,
       COALESCE(tr.` + "`constraint`" + `, '') AS cons,
       (SELECT COUNT(*)
        FROM c_ci_relations cr
        JOIN c_cis ca ON ca.id = cr.first_ci_id AND ca.delete_marker = 0 AND ca.deleted_at IS NULL
        JOIN c_cis cb ON cb.id = cr.second_ci_id AND cb.delete_marker = 0 AND cb.deleted_at IS NULL
        WHERE cr.delete_marker = 0 AND cr.deleted_at IS NULL
          AND cr.relation_type_id = tr.relation_type_id
          AND ca.type_id = tr.parent_id
          AND cb.type_id = tr.child_id) AS edges
FROM c_ci_type_relations tr
JOIN c_relation_types rt ON rt.id = tr.relation_type_id
JOIN c_ci_types p ON p.id = tr.parent_id
JOIN c_ci_types c ON c.id = tr.child_id
WHERE tr.delete_marker = 0 AND tr.deleted_at IS NULL
  AND rt.delete_marker = 0 AND rt.deleted_at IS NULL
  AND rt.name IN ('contain', 'connect', 'depend', 'deploy', 'run')
ORDER BY rt.name, edges DESC, p.name, c.name`

// PlanRelationSplit reads the active model rules and returns the proposed
// target vocabulary. It never writes.
func PlanRelationSplit(ctx context.Context, db *gorm.DB) (*SplitPlanReport, error) {
	if db == nil {
		return nil, errNilDB
	}
	var rows []splitRow
	if err := db.WithContext(ctx).Raw(splitQuery).Scan(&rows).Error; err != nil {
		return nil, fmt.Errorf("cmdb ci: plan relation split: %w", err)
	}
	report := &SplitPlanReport{
		Rows:        make([]SplitPlanRow, 0, len(rows)),
		Totals:      map[string]int64{},
		TargetRules: map[string]int{},
	}
	for _, row := range rows {
		target, review, inverted := splitTarget(row)
		if target == "" {
			target = "UNRESOLVED"
			report.UnresolvedRules++
			report.UnresolvedEdges += row.Edges
		}
		report.Rows = append(report.Rows, SplitPlanRow{
			RelationType: row.RelationType, ParentModel: row.ParentModel,
			ChildModel: row.ChildModel, Constraint: row.Constraint,
			Edges: row.Edges, Target: target, Review: review,
			DirectionInverted: inverted,
		})
		report.Totals[target] += row.Edges
		report.TargetRules[target]++
		report.TotalEdges += row.Edges
	}
	return report, nil
}

func splitTarget(row splitRow) (target string, review, inverted bool) {
	switch row.RelationType {
	case "contain":
		return containSplitTarget(row.ParentModel, row.ChildModel)
	case "connect":
		return connectSplitTarget(row.ParentModel, row.ChildModel)
	case "depend":
		return dependSplitTarget(row.ParentModel, row.ChildModel)
	case "deploy", "run":
		return "RUNS_ON", false, false
	default:
		return "", false, false
	}
}

var containSplitTargets = map[[2]string]string{
	{"ipam_subnet", "ipam_address"}:                 "ALLOCATED_TO",
	{"ipam_scope", "ipam_subnet"}:                   "PART_OF",
	{"ipam_subnet", "ipam_subnet"}:                  "PART_OF",
	{"app_cluster", "app_instance"}:                 "MEMBER_OF",
	{"aps_mw_cluster", "aps_mw_instance"}:           "MEMBER_OF",
	{"lb_cluster", "lb_instance"}:                   "MEMBER_OF",
	{"api_gateway_cluster", "api_gateway_instance"}: "MEMBER_OF",
	{"app_mw_cluster", "app_mw_instance"}:           "MEMBER_OF",
	{"cache_mw_cluster", "cache_mw_instance"}:       "MEMBER_OF",
	{"data_mw_cluster", "data_mw_instance"}:         "MEMBER_OF",
	{"application", "app_cluster"}:                  "PART_OF",
	{"application", "module"}:                       "PART_OF",
	{"application", "apple_profiles"}:               "BELONGS_TO",
	{"application", "certificate"}:                  "BELONGS_TO",
	{"application", "circuit"}:                      "BELONGS_TO",
	{"application", "env_monitor"}:                  "BELONGS_TO",
	{"application", "accounts"}:                     "BELONGS_TO",
	{"product", "service"}:                          "BELONGS_TO",
	{"product_line", "product"}:                     "BELONGS_TO",
	{"biz", "product_line"}:                         "BELONGS_TO",
	{"organization", "department"}:                  "BELONGS_TO",
	{"department", "team"}:                          "BELONGS_TO",
	{"team", "members"}:                             "MEMBER_OF",
	{"department", "members"}:                       "MEMBER_OF",
	{"db_cluster", "database"}:                      "PART_OF",
	{"dcim_region", "dcim_idc"}:                     "LOCATED_IN",
	{"dcim_idc", "dcim_server_room"}:                "LOCATED_IN",
	{"dcim_server_room", "dcim_rack"}:               "LOCATED_IN",
	{"dcim_rack", "server"}:                         "LOCATED_IN",
	{"dcim_rack", "bigip"}:                          "LOCATED_IN",
	{"dcim_rack", "fc_switch"}:                      "LOCATED_IN",
	{"dcim_rack", "firewall"}:                       "LOCATED_IN",
	{"dcim_rack", "router"}:                         "LOCATED_IN",
	{"dcim_rack", "switch"}:                         "LOCATED_IN",
	{"dcim_server_room", "breaker"}:                 "LOCATED_IN",
	{"dcim_server_room", "circuit"}:                 "LOCATED_IN",
	{"dcim_server_room", "power_source"}:            "LOCATED_IN",
	{"dcim_server_room", "ups"}:                     "LOCATED_IN",
	{"server", "harddisk"}:                          "PART_OF",
	{"server", "NIC"}:                               "PART_OF",
	{"server", "RAM"}:                               "PART_OF",
	{"domain", "dns_record"}:                        "BELONGS_TO",
}

var containReview = map[[2]string]bool{
	{"application", "circuit"}:           true,
	{"application", "env_monitor"}:       true,
	{"application", "accounts"}:          true,
	{"application", "apple_profiles"}:    true,
	{"application", "certificate"}:       true,
	{"db_cluster", "database"}:           true,
	{"dcim_server_room", "breaker"}:      true,
	{"dcim_server_room", "circuit"}:      true,
	{"dcim_server_room", "power_source"}: true,
	{"dcim_server_room", "ups"}:          true,
}

func containSplitTarget(parent, child string) (string, bool, bool) {
	key := [2]string{parent, child}
	target, ok := containSplitTargets[key]
	if !ok {
		return "", false, false
	}
	return target, containReview[key], false
}

var connectPowerPairs = map[[2]string]bool{
	{"power_source", "ups"}:     true,
	{"power_source", "breaker"}: true,
	{"ups", "breaker"}:          true,
	{"breaker", "pdu"}:          true,
	{"pdu", "dcim_rack"}:        true,
}

func connectSplitTarget(parent, child string) (string, bool, bool) {
	key := [2]string{parent, child}
	if connectPowerPairs[key] {
		// The current power chain is provider -> consumer; topocortex
		// POWERED_BY is consumer -> provider. The connector reverses it.
		return "POWERED_BY", true, true
	}
	if parent == "service" && child == "service" {
		// Could be CALLS once APM evidence exists; CONNECTS_TO is the safe
		// generic target until then.
		return "CONNECTS_TO", true, false
	}
	if parent == "application" && child == "application" {
		return "CONNECTS_TO", true, false
	}
	if parent == "demo111" || parent == "hello1111" {
		return "CONNECTS_TO", true, false
	}
	return "", false, false
}

func dependSplitTarget(parent, child string) (string, bool, bool) {
	if parent == "service" && child == "application" {
		// Business composition vs runtime dependency is not provable from the
		// data; keep DEPENDS_ON and require a decision.
		return "DEPENDS_ON", true, false
	}
	if parent == "app_instance" && child == "db_cluster" {
		return "DEPENDS_ON", false, false
	}
	return "", false, false
}
