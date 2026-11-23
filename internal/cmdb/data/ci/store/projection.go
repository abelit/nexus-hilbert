package store

import (
	"context"
	"fmt"

	"gorm.io/gorm"

	"github.com/ongridio/ongrid/internal/cmdb/biz/relationmap"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
)

// projectionRuleRow is the flat result of the rule/edge-count query.
type projectionRuleRow struct {
	RelationType string `gorm:"column:relation_type"`
	ParentModel  string `gorm:"column:parent_model"`
	ChildModel   string `gorm:"column:child_model"`
	Constraint   string `gorm:"column:constraint"`
	EdgeCount    int64  `gorm:"column:edge_count"`
}

const projectionRulesQuery = `
SELECT rt.name AS relation_type, p.name AS parent_model, c.name AS child_model,
       COALESCE(tr.` + "`constraint`" + `, '') AS ` + "`constraint`" + `,
       (SELECT COUNT(*)
        FROM c_ci_relations cr
        JOIN c_cis ca ON ca.id = cr.first_ci_id AND ca.delete_marker = 0 AND ca.deleted_at IS NULL
        JOIN c_cis cb ON cb.id = cr.second_ci_id AND cb.delete_marker = 0 AND cb.deleted_at IS NULL
        WHERE cr.delete_marker = 0 AND cr.deleted_at IS NULL
          AND cr.relation_type_id = tr.relation_type_id
          AND ca.type_id = tr.parent_id
          AND cb.type_id = tr.child_id) AS edge_count
FROM c_ci_type_relations tr
JOIN c_relation_types rt ON rt.id = tr.relation_type_id
JOIN c_ci_types p ON p.id = tr.parent_id
JOIN c_ci_types c ON c.id = tr.child_id
WHERE tr.delete_marker = 0 AND tr.deleted_at IS NULL
  AND rt.delete_marker = 0 AND rt.deleted_at IS NULL
ORDER BY rt.name, p.name, c.name`

// PlanOntologyProjection is the read-only dry run for projecting CMDB model
// rules into topocortex declarations. It writes nothing and does not call the
// ontology API. The caller must refuse to apply while Report.Blocked is true.
func PlanOntologyProjection(ctx context.Context, db *gorm.DB) (*relationmap.Report, error) {
	if db == nil {
		return nil, errNilDB
	}
	var rows []projectionRuleRow
	if err := db.WithContext(ctx).Raw(projectionRulesQuery).Scan(&rows).Error; err != nil {
		return nil, fmt.Errorf("cmdb ci: plan ontology projection: rules: %w", err)
	}
	rules := make([]relationmap.Rule, 0, len(rows))
	for _, row := range rows {
		rules = append(rules, relationmap.Rule{
			RelationType: row.RelationType,
			ParentModel:  row.ParentModel,
			ChildModel:   row.ChildModel,
			Constraint:   row.Constraint,
			EdgeCount:    row.EdgeCount,
		})
	}

	var relationTypes []citypemodel.RelationType
	if err := db.WithContext(ctx).
		Where("delete_marker = 0 AND deleted_at IS NULL").
		Find(&relationTypes).Error; err != nil {
		return nil, fmt.Errorf("cmdb ci: plan ontology projection: relation types: %w", err)
	}
	types := make(map[string]relationmap.TypeSemantics, len(relationTypes))
	for _, rt := range relationTypes {
		types[rt.Name] = relationmap.TypeSemantics{
			Name:               rt.Name,
			OntologyReady:      rt.OntologyReady(),
			TopocortexCategory: rt.TopocortexCategory,
			Traits:             append([]string(nil), rt.Traits...),
			InverseOf:          rt.InverseOf,
			Transitive:         rt.Transitive,
			SubPropertyOf:      append([]string(nil), rt.SubPropertyOf...),
			PropagatesDefault:  rt.PropagatesDefault,
			WeightDefault:      rt.WeightDefault,
			Deprecated:         rt.Deprecated,
			Replacement:        rt.Replacement,
		}
	}

	report := relationmap.Plan(rules, types, nil)
	return &report, nil
}
