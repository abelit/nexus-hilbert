package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
)

// The Phase 2 split for the vocabulary that can be reclassified without
// flipping a one2many endpoint.
//
// deploy/run, depend and connect are direction-compatible (the power chain is
// many2many/one2one and is safely flipped). contain is structural: its targets
// read part -> whole while CMDB stores whole -> part, so it is split into
// inverse CMDB names (CONTAINS, HAS_MEMBER, ...) that declare inverse_of. bind
// stores contract -> resource (sla -> service) while topocortex UNDER_CONTRACT
// reads resource -> contract, so it becomes COVERS with inverse_of. No contain
// or bind edge is flipped; the one2many rules stay one2many.
type SplitApplyReport struct {
	DryRun            bool            `json:"dry_run"`
	CreatedTypes      []string        `json:"created_types,omitempty"`
	DeprecatedTypes   []string        `json:"deprecated_types,omitempty"`
	ReclassifiedRules int             `json:"reclassified_rules"`
	ReclassifiedEdges int64           `json:"reclassified_edges"`
	FlippedEdges      int64           `json:"flipped_edges"`
	RemovedDemoRules  int             `json:"removed_demo_rules"`
	RemovedDemoEdges  int64           `json:"removed_demo_edges"`
	Rows              []SplitApplyRow `json:"rows"`
	Unresolved        []string        `json:"unresolved,omitempty"`
}

type SplitApplyRow struct {
	SourceType  string `json:"source_type"`
	ParentModel string `json:"parent_model"`
	ChildModel  string `json:"child_model"`
	Target      string `json:"target"`
	InverseOf   string `json:"inverse_of,omitempty"`
	Rules       int    `json:"rules"`
	Edges       int64  `json:"edges"`
	Flip        bool   `json:"flip,omitempty"`
	Delete      bool   `json:"delete,omitempty"`
}

type splitTypeSpec struct {
	Name, Category, Direction string
	DisplayZH, DisplayEN      string
	Description               string
	InverseOf                 string
	Propagates                bool
	Transitive                bool
	Weight                    float64
}

var splitTypeSpecs = map[string]splitTypeSpec{
	"RUNS_ON": {
		Name: "RUNS_ON", Category: "runtime", Direction: "dst_to_src",
		DisplayZH: "运行于", DisplayEN: "Runs on",
		Description: "运行于：工作负载运行在宿主上，宿主故障影响工作负载。",
		Propagates:  true, Weight: 1.0,
	},
	"DEPENDS_ON": {
		Name: "DEPENDS_ON", Category: "dependency", Direction: "dst_to_src",
		DisplayZH: "依赖", DisplayEN: "Depends on",
		Description: "依赖：源依赖目标，目标故障影响源。",
		Propagates:  true, Weight: 0.8,
	},
	"POWERED_BY": {
		Name: "POWERED_BY", Category: "failure-domain", Direction: "dst_to_src",
		DisplayZH: "供电于", DisplayEN: "Powered by",
		Description: "供电依赖：消费者由供电方供电，供电故障影响消费者。",
		Propagates:  true, Weight: 1.0,
	},
	"CONNECTS_TO": {
		Name: "CONNECTS_TO", Category: "dependency", Direction: "dst_to_src",
		DisplayZH: "连接", DisplayEN: "Connects to",
		Description: "逻辑连接：协议与调用语义待 APM 证据补充。",
		Propagates:  true, Weight: 0.6,
	},
	// Structural types are the CMDB-side inverse of the topocortex target:
	// CMDB stores whole -> part, topocortex PART_OF reads part -> whole.
	"CONTAINS": {
		Name: "CONTAINS", Category: "structure", Direction: "src_to_dst",
		DisplayZH: "包含", DisplayEN: "Contains",
		Description: "结构包含：整体由部分组成，不传播故障。",
		InverseOf:   "PART_OF", Transitive: true, Weight: 0,
	},
	"HAS_MEMBER": {
		Name: "HAS_MEMBER", Category: "structure", Direction: "src_to_dst",
		DisplayZH: "含有成员", DisplayEN: "Has member",
		Description: "成员聚合：聚合体含有成员，不传播故障。",
		InverseOf:   "MEMBER_OF", Weight: 0,
	},
	"HAS_BELONGING": {
		Name: "HAS_BELONGING", Category: "structure", Direction: "src_to_dst",
		DisplayZH: "含有归属", DisplayEN: "Has belonging",
		Description: "业务归属：分组含有归属资源，不传播故障。",
		InverseOf:   "BELONGS_TO", Weight: 0,
	},
	"HAS_LOCATION": {
		Name: "HAS_LOCATION", Category: "structure", Direction: "src_to_dst",
		DisplayZH: "含有位置", DisplayEN: "Has location",
		Description: "物理位置：位置含有设备，不传播故障。",
		InverseOf:   "LOCATED_IN", Weight: 0,
	},
	"ALLOCATES": {
		Name: "ALLOCATES", Category: "structure", Direction: "src_to_dst",
		DisplayZH: "分配", DisplayEN: "Allocates",
		Description: "地址分配：子网分配地址，不传播故障。",
		InverseOf:   "ALLOCATED_TO", Weight: 0,
	},
	"COVERS": {
		Name: "COVERS", Category: "ownership", Direction: "src_to_dst",
		DisplayZH: "合同覆盖", DisplayEN: "Covers",
		Description: "合同覆盖：SLA/合同覆盖资源，不传播故障。",
		InverseOf:   "UNDER_CONTRACT", Weight: 0,
	},
}

var splitSourceTypes = []string{"bind", "deploy", "run", "depend", "connect", "contain"}

var splitReplacements = map[string]string{
	"bind": "COVERS", "deploy": "RUNS_ON", "run": "RUNS_ON", "depend": "DEPENDS_ON",
	"connect": "CONNECTS_TO", "contain": "CONTAINS",
}

// ApplyRelationSplit reclassifies the overloaded vocabulary. A dry run reports
// the same rows and counts without writing.
func ApplyRelationSplit(ctx context.Context, db *gorm.DB, dryRun bool) (*SplitApplyReport, error) {
	if db == nil {
		return nil, errNilDB
	}
	if dryRun {
		report, err := inspectSplitApply(ctx, db)
		if err != nil {
			return nil, err
		}
		report.DryRun = true
		return report, nil
	}
	var report *SplitApplyReport
	err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		got, err := applySplitTx(ctx, tx)
		if err != nil {
			return err
		}
		report = got
		return nil
	})
	if err != nil {
		return nil, err
	}
	return report, nil
}

type splitRuleRow struct {
	Rule         citypemodel.CITypeRelation
	SourceType   string
	SourceTypeID model.ID
	ParentModel  string
	ChildModel   string
	Target       string
	// InverseOf is set for structural targets: the CMDB-side name keeps the
	// whole -> part direction and declares the topocortex name it mirrors.
	InverseOf string
	Flip      bool
	Delete    bool
	EdgeCount int64
}

func loadSplitRules(ctx context.Context, db *gorm.DB) ([]splitRuleRow, error) {
	var sourceTypes []citypemodel.RelationType
	if err := db.WithContext(ctx).Where("name IN ?", splitSourceTypes).Find(&sourceTypes).Error; err != nil {
		return nil, fmt.Errorf("cmdb ci: split: load source types: %w", err)
	}
	sourceByID := make(map[model.ID]string, len(sourceTypes))
	ids := make([]model.ID, 0, len(sourceTypes))
	for _, rt := range sourceTypes {
		sourceByID[rt.ID] = rt.Name
		ids = append(ids, rt.ID)
	}
	if len(ids) == 0 {
		return nil, nil
	}
	var rules []citypemodel.CITypeRelation
	if err := db.WithContext(ctx).Where("relation_type_id IN ?", ids).Order("id").Find(&rules).Error; err != nil {
		return nil, fmt.Errorf("cmdb ci: split: load rules: %w", err)
	}
	typeNames, err := loadCITypeNames(db.WithContext(ctx), rules)
	if err != nil {
		return nil, err
	}
	out := make([]splitRuleRow, 0, len(rules))
	for _, rule := range rules {
		row := splitRuleRow{
			Rule: rule, SourceType: sourceByID[rule.RelationTypeID],
			SourceTypeID: rule.RelationTypeID,
			ParentModel:  typeNames[rule.ParentID], ChildModel: typeNames[rule.ChildID],
		}
		row.Target, row.InverseOf, row.Flip, row.Delete = splitApplyTarget(row.SourceType, row.ParentModel, row.ChildModel)
		out = append(out, row)
	}
	return out, nil
}

func loadCITypeNames(db *gorm.DB, rules []citypemodel.CITypeRelation) (map[model.ID]string, error) {
	ids := make([]model.ID, 0, len(rules)*2)
	seen := map[model.ID]bool{}
	for _, rule := range rules {
		for _, id := range []model.ID{rule.ParentID, rule.ChildID} {
			if !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
	}
	out := map[model.ID]string{}
	if len(ids) == 0 {
		return out, nil
	}
	var types []citypemodel.CIType
	if err := db.Where("id IN ?", ids).Find(&types).Error; err != nil {
		return nil, fmt.Errorf("cmdb ci: split: load model names: %w", err)
	}
	for _, ct := range types {
		out[ct.ID] = ct.Name
	}
	return out, nil
}

func splitApplyTarget(source, parent, child string) (target, inverseOf string, flip, delete bool) {
	if source == "connect" && (parent == "demo111" || parent == "hello1111") {
		return "", "", false, true
	}
	target, _, inverted := splitTarget(splitRow{
		RelationType: source, ParentModel: parent, ChildModel: child,
	})
	if source == "contain" {
		// CMDB stores whole -> part. The split keeps the stored direction and
		// creates the inverse CMDB name, so nothing is flipped and the 36
		// one2many rules stay one2many.
		target, inverseOf = containMirror(target)
		return target, inverseOf, false, false
	}
	if source == "bind" {
		// CMDB stores contract -> resource (sla -> service). COVERS reads the
		// same way and declares UNDER_CONTRACT as its inverse; the one2many
		// rule is never flipped.
		target, inverseOf = contractMirror(target)
		return target, inverseOf, false, false
	}
	return target, "", inverted, false
}

func inspectSplitApply(ctx context.Context, db *gorm.DB) (*SplitApplyReport, error) {
	rules, err := loadSplitRules(ctx, db)
	if err != nil {
		return nil, err
	}
	report := &SplitApplyReport{Rows: make([]SplitApplyRow, 0, len(rules))}
	for _, row := range rules {
		if row.Target == "" && !row.Delete {
			report.Unresolved = append(report.Unresolved, row.SourceType+" "+row.ParentModel+"->"+row.ChildModel)
			continue
		}
		count, err := countSplitEdges(db.WithContext(ctx), row)
		if err != nil {
			return nil, err
		}
		row.EdgeCount = count
		report.Rows = append(report.Rows, applyRow(row))
		if row.Delete {
			report.RemovedDemoRules++
			report.RemovedDemoEdges += count
		} else {
			report.ReclassifiedRules++
			report.ReclassifiedEdges += count
			if row.Flip {
				report.FlippedEdges += count
			}
		}
	}
	return report, nil
}

func applyRow(row splitRuleRow) SplitApplyRow {
	target := row.Target
	if row.Delete {
		target = "DELETE"
	}
	return SplitApplyRow{
		SourceType: row.SourceType, ParentModel: row.ParentModel, ChildModel: row.ChildModel,
		Target: target, InverseOf: row.InverseOf, Rules: 1, Edges: row.EdgeCount,
		Flip: row.Flip, Delete: row.Delete,
	}
}

func applySplitTx(ctx context.Context, tx *gorm.DB) (*SplitApplyReport, error) {
	rules, err := loadSplitRules(ctx, tx)
	if err != nil {
		return nil, err
	}
	report := &SplitApplyReport{Rows: make([]SplitApplyRow, 0, len(rules))}
	needed := map[string]bool{}
	for _, row := range rules {
		if row.Target != "" && !row.Delete {
			needed[row.Target] = true
		}
	}
	typeIDs := map[string]model.ID{}
	for name, spec := range splitTypeSpecs {
		if !needed[name] {
			continue
		}
		id, created, err := ensureSplitType(tx, spec)
		if err != nil {
			return nil, err
		}
		typeIDs[name] = id
		if created {
			report.CreatedTypes = append(report.CreatedTypes, name)
		}
	}
	for _, row := range rules {
		if row.Target == "" && !row.Delete {
			report.Unresolved = append(report.Unresolved, row.SourceType+" "+row.ParentModel+"->"+row.ChildModel)
			continue
		}
		count, err := countSplitEdges(tx, row)
		if err != nil {
			return nil, err
		}
		row.EdgeCount = count
		report.Rows = append(report.Rows, applyRow(row))
		if row.Delete {
			removed, err := deleteSplitRuleEdges(tx, row)
			if err != nil {
				return nil, err
			}
			report.RemovedDemoRules++
			report.RemovedDemoEdges += removed
			continue
		}
		targetID := typeIDs[row.Target]
		if targetID == 0 {
			return nil, fmt.Errorf("cmdb ci: split: no target type %s", row.Target)
		}
		reassigned, flipped, err := reclassifySplitRule(tx, row, targetID)
		if err != nil {
			return nil, err
		}
		report.ReclassifiedRules++
		report.ReclassifiedEdges += reassigned
		report.FlippedEdges += flipped
	}
	report.DeprecatedTypes = deprecateSourceTypes(tx, rules)
	return report, nil
}

func ensureSplitType(tx *gorm.DB, spec splitTypeSpec) (model.ID, bool, error) {
	var existing citypemodel.RelationType
	err := tx.Where("name = ?", spec.Name).First(&existing).Error
	switch {
	case err == nil:
		return existing.ID, false, nil
	case !errors.Is(err, gorm.ErrRecordNotFound):
		return 0, false, fmt.Errorf("cmdb ci: split: find type %s: %w", spec.Name, err)
	}
	row := citypemodel.RelationType{
		Name: spec.Name, Color: "#1890ff",
		Category: spec.Category, Direction: spec.Direction,
		PropagatesDefault: spec.Propagates, WeightDefault: spec.Weight,
		InverseOf: spec.InverseOf, Transitive: spec.Transitive,
		DisplayNameZH: spec.DisplayZH, DisplayNameEN: spec.DisplayEN,
		Description: spec.Description, Revision: 1,
	}
	if err := tx.Create(&row).Error; err != nil {
		return 0, false, fmt.Errorf("cmdb ci: split: create type %s: %w", spec.Name, err)
	}
	// GORM substitutes the column default (1) for a zero WeightDefault, so a
	// structural type's explicit 0 has to be written back.
	if spec.Weight == 0 {
		if err := tx.Model(&row).Update("weight_default", spec.Weight).Error; err != nil {
			return 0, false, fmt.Errorf("cmdb ci: split: set weight for %s: %w", spec.Name, err)
		}
	}
	return row.ID, true, nil
}

func countSplitEdges(db *gorm.DB, row splitRuleRow) (int64, error) {
	var n int64
	q := db.Model(&cimodel.Relation{}).
		Where("relation_type_id = ?", row.SourceTypeID).
		Where("first_ci_id IN (?)", db.Model(&cimodel.CI{}).Select("id").Where("type_id = ?", row.Rule.ParentID)).
		Where("second_ci_id IN (?)", db.Model(&cimodel.CI{}).Select("id").Where("type_id = ?", row.Rule.ChildID))
	if err := q.Count(&n).Error; err != nil {
		return 0, fmt.Errorf("cmdb ci: split: count edges %s %s->%s: %w",
			row.SourceType, row.ParentModel, row.ChildModel, err)
	}
	return n, nil
}

func deleteSplitRuleEdges(tx *gorm.DB, row splitRuleRow) (int64, error) {
	var edges []cimodel.Relation
	q := tx.Model(&cimodel.Relation{}).
		Where("relation_type_id = ?", row.SourceTypeID).
		Where("first_ci_id IN (?)", tx.Model(&cimodel.CI{}).Select("id").Where("type_id = ?", row.Rule.ParentID)).
		Where("second_ci_id IN (?)", tx.Model(&cimodel.CI{}).Select("id").Where("type_id = ?", row.Rule.ChildID))
	if err := q.Select("id").Find(&edges).Error; err != nil {
		return 0, fmt.Errorf("cmdb ci: split: load demo edges: %w", err)
	}
	if len(edges) > 0 {
		ids := make([]model.ID, 0, len(edges))
		for _, edge := range edges {
			ids = append(ids, edge.ID)
		}
		if err := tx.Model(&cimodel.Relation{}).Where("id IN ?", ids).
			Updates(map[string]any{"deleted_at": time.Now().UTC(), "delete_marker": int64(1)}).Error; err != nil {
			return 0, fmt.Errorf("cmdb ci: split: delete demo edges: %w", err)
		}
	}
	if err := tx.Model(&citypemodel.CITypeRelation{}).Where("id = ?", row.Rule.ID).
		Updates(map[string]any{"deleted_at": time.Now().UTC(), "delete_marker": int64(1)}).Error; err != nil {
		return 0, fmt.Errorf("cmdb ci: split: delete demo rule: %w", err)
	}
	return int64(len(edges)), nil
}

func reclassifySplitRule(tx *gorm.DB, row splitRuleRow, targetID model.ID) (edges, flipped int64, err error) {
	newParent, newChild := row.Rule.ParentID, row.Rule.ChildID
	newParentAttrs, newChildAttrs := row.Rule.ParentAttrIDs, row.Rule.ChildAttrIDs
	if row.Flip {
		newParent, newChild = newChild, newParent
		newParentAttrs, newChildAttrs = newChildAttrs, newParentAttrs
	}

	var existing citypemodel.CITypeRelation
	findErr := tx.Where("relation_type_id = ? AND parent_id = ? AND child_id = ?",
		targetID, newParent, newChild).First(&existing).Error
	switch {
	case findErr == nil && existing.ID != row.Rule.ID:
		// A target rule already exists; keep it and retire the source rule.
		if err := tx.Model(&citypemodel.CITypeRelation{}).Where("id = ?", row.Rule.ID).
			Updates(map[string]any{"deleted_at": time.Now().UTC(), "delete_marker": int64(1)}).Error; err != nil {
			return 0, 0, fmt.Errorf("cmdb ci: split: retire duplicate rule: %w", err)
		}
	case findErr == nil || errors.Is(findErr, gorm.ErrRecordNotFound):
		// Update the source rule in place, preserving its id and attribute mapping.
		patch := citypemodel.CITypeRelation{
			RelationTypeID: targetID, ParentID: newParent, ChildID: newChild,
			ParentAttrIDs: newParentAttrs, ChildAttrIDs: newChildAttrs,
		}
		if err := tx.Model(&citypemodel.CITypeRelation{}).Where("id = ?", row.Rule.ID).
			Select("relation_type_id", "parent_id", "child_id", "parent_attr_ids", "child_attr_ids").
			Updates(&patch).Error; err != nil {
			return 0, 0, fmt.Errorf("cmdb ci: split: reclassify rule: %w", err)
		}
	default:
		return 0, 0, fmt.Errorf("cmdb ci: split: find target rule: %w", findErr)
	}

	edges, flipped, err = reassignSplitEdges(tx, row, targetID)
	if err != nil {
		return 0, 0, err
	}
	return edges, flipped, nil
}

func reassignSplitEdges(tx *gorm.DB, row splitRuleRow, targetID model.ID) (int64, int64, error) {
	if row.Flip {
		var edges []cimodel.Relation
		q := tx.Model(&cimodel.Relation{}).
			Where("relation_type_id = ?", row.SourceTypeID).
			Where("first_ci_id IN (?)", tx.Model(&cimodel.CI{}).Select("id").Where("type_id = ?", row.Rule.ParentID)).
			Where("second_ci_id IN (?)", tx.Model(&cimodel.CI{}).Select("id").Where("type_id = ?", row.Rule.ChildID)).
			Select("id", "first_ci_id", "second_ci_id")
		if err := q.Find(&edges).Error; err != nil {
			return 0, 0, fmt.Errorf("cmdb ci: split: load flip edges: %w", err)
		}
		for _, edge := range edges {
			if err := tx.Model(&cimodel.Relation{}).Where("id = ?", edge.ID).
				Updates(map[string]any{
					"relation_type_id": targetID,
					"first_ci_id":      edge.SecondCIID,
					"second_ci_id":     edge.FirstCIID,
				}).Error; err != nil {
				return 0, 0, fmt.Errorf("cmdb ci: split: flip edge %d: %w", edge.ID, err)
			}
		}
		return int64(len(edges)), int64(len(edges)), nil
	}

	res := tx.Model(&cimodel.Relation{}).
		Where("relation_type_id = ?", row.SourceTypeID).
		Where("first_ci_id IN (?)", tx.Model(&cimodel.CI{}).Select("id").Where("type_id = ?", row.Rule.ParentID)).
		Where("second_ci_id IN (?)", tx.Model(&cimodel.CI{}).Select("id").Where("type_id = ?", row.Rule.ChildID)).
		Update("relation_type_id", targetID)
	if res.Error != nil {
		return 0, 0, fmt.Errorf("cmdb ci: split: reassign edges: %w", res.Error)
	}
	return res.RowsAffected, 0, nil
}

func deprecateSourceTypes(tx *gorm.DB, rows []splitRuleRow) []string {
	seen := map[string]bool{}
	var out []string
	for _, row := range rows {
		if seen[row.SourceType] {
			continue
		}
		seen[row.SourceType] = true
		replacement, ok := splitReplacements[row.SourceType]
		if !ok {
			continue
		}
		var liveRules int64
		if err := tx.Model(&citypemodel.CITypeRelation{}).
			Where("relation_type_id = ?", row.SourceTypeID).Count(&liveRules).Error; err != nil {
			continue
		}
		var liveEdges int64
		if err := tx.Model(&cimodel.Relation{}).
			Where("relation_type_id = ?", row.SourceTypeID).Count(&liveEdges).Error; err != nil {
			continue
		}
		if liveRules > 0 || liveEdges > 0 {
			continue
		}
		var rt citypemodel.RelationType
		if err := tx.First(&rt, row.SourceTypeID).Error; err != nil {
			continue
		}
		if err := tx.Model(&rt).Updates(map[string]any{
			"deprecated": true, "replacement": replacement, "revision": rt.Revision + 1,
		}).Error; err == nil {
			out = append(out, row.SourceType)
		}
	}
	return out
}
