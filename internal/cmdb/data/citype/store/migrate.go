// Package store implements CMDB persistence for model definitions: CI types,
// attributes, their bindings and groupings, model-level relations, and the
// relation-type dictionary.
package store

import (
	"errors"
	"fmt"

	"gorm.io/gorm"

	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
)

var errNilDB = errors.New("cmdb citype store: nil db")

// Migrate registers the model-definition schema.
//
// It must run BEFORE the CI-side migrator in a fresh database only by
// convention, not by constraint: CMDB declares no database-level foreign keys,
// so there is no ordering dependency for AutoMigrate to satisfy.
//
// cantor bootstraps built-in rows here too (the relation-type dictionary, the
// seven IPAM/DCIM CI models, the built-in attribute set). Seeding is
// deliberately NOT part of Migrate: seeding writes business rows, and doing it
// inside a boot-time migration makes a partially seeded database
// indistinguishable from an edited one. It belongs in an explicit command.
func Migrate(db *gorm.DB) error {
	if db == nil {
		return errNilDB
	}
	if err := db.AutoMigrate(
		&citypemodel.RelationType{},
		&citypemodel.CITypeGroup{},
		&citypemodel.CITypeGroupItem{},
		&citypemodel.CIType{},
		&citypemodel.CITypeInheritance{},
		&citypemodel.CITypeRelation{},
		&citypemodel.Attribute{},
		&citypemodel.CITypeAttribute{},
		&citypemodel.CITypeAttributeGroup{},
		&citypemodel.CITypeAttributeGroupItem{},
		&citypemodel.CITypeUniqueConstraint{},
		&citypemodel.CITypeTrigger{},
		// Per-user preferences: what one person has subscribed to and how they
		// have arranged it. They carry a uid rather than a tenant, matching the
		// rest of CMDB.
		&citypemodel.PreferenceShowAttributes{},
		&citypemodel.PreferenceCITypeOrder{},
		&citypemodel.PreferenceTreeView{},
		&citypemodel.PreferenceAutoSubscriptionConfig{},
		// The service-tree definitions and saved searches. The definitions are
		// also READ by the resource-management service tree, which is why they
		// live in this package's schema rather than the resource one's.
		&citypemodel.PreferenceRelationView{},
		&citypemodel.PreferenceSearchOption{},
	); err != nil {
		return err
	}
	if err := backfillRelationTypeSemantics(db); err != nil {
		return err
	}
	return backfillInverseRelationTypes(db)
}

// The two vocabulary words whose CMDB storage direction is the INVERSE of the
// topocortex relation they map to.
//
// DO NOT FLIP THE EDGES. manage has 6 one2many rules and contain has 36; a flip
// would turn them into many2one, which the CMDB constraint model does not have.
// The ontology connector reverses the endpoints using this field instead.
func backfillInverseRelationTypes(db *gorm.DB) error {
	inverses := []struct{ name, inverse string }{
		{"contain", "PART_OF"},
		{"manage", "OWNED_BY"},
	}
	for _, seed := range inverses {
		if err := db.Model(&citypemodel.RelationType{}).
			Where("name = ? AND inverse_of = '' AND revision >= 1", seed.name).
			Update("inverse_of", seed.inverse).Error; err != nil {
			return fmt.Errorf("cmdb citype: backfill inverse for %q: %w", seed.name, err)
		}
		// Bump the revision only forward; a later ontology sync may already
		// have a higher revision.
		if err := db.Model(&citypemodel.RelationType{}).
			Where("name = ? AND inverse_of = ? AND revision < 2", seed.name, seed.inverse).
			Update("revision", 2).Error; err != nil {
			return fmt.Errorf("cmdb citype: bump revision for %q: %w", seed.name, err)
		}
	}
	return nil
}

// The first semantic values for the eight live vocabulary words.
//
// THIS IS A BACKFILL, NOT A SEED. It runs inside Migrate because the semantics
// columns are new and every existing row predates them; unlike seeding business
// rows, filling a column that has no value yet is a migration. It only touches
// rows whose category is empty AND whose revision is zero, so an operator edit
// or a later topocortex sync is never overwritten.
func backfillRelationTypeSemantics(db *gorm.DB) error {
	type seed struct {
		name, category, direction, displayZH, displayEN, description, replacement string
		propagates, transitive, deprecated                                        bool
		weight                                                                    float64
	}
	seeds := []seed{
		{"contain", "structure", "src_to_dst", "包含", "Contains", "结构包含：整体由部分组成，不传播故障。", "", false, true, false, 0},
		{"deploy", "runtime", "dst_to_src", "部署", "Deploys", "部署：工作负载部署到宿主，宿主故障影响工作负载。", "", true, false, false, 1.0},
		{"install", "runtime", "dst_to_src", "安装", "Installs", "安装：已弃用，等价于运行于。", "RUNS_ON", true, false, true, 0.8},
		{"connect", "dependency", "bidirectional", "连接", "Connects", "连接：逻辑或物理连接，方向与语义待拆分。", "", true, false, false, 0.6},
		{"manage", "ownership", "src_to_dst", "管理", "Manages", "管理：人员或团队负责资源，不传播故障。", "", false, false, false, 0},
		{"bind", "ownership", "src_to_dst", "绑定", "Binds", "绑定：SLA/合同与服务的关联，不传播故障。", "", false, false, false, 0},
		{"depend", "dependency", "dst_to_src", "依赖", "Depends on", "依赖：源依赖目标，目标故障影响源。", "", true, false, false, 0.8},
		{"run", "runtime", "dst_to_src", "运行于", "Runs on", "运行于：工作负载运行在宿主上，宿主故障影响工作负载。", "", true, false, false, 1.0},
	}
	for _, s := range seeds {
		updates := map[string]any{
			"category":           s.category,
			"direction":          s.direction,
			"propagates_default": s.propagates,
			"weight_default":     s.weight,
			"transitive":         s.transitive,
			"display_name_zh":    s.displayZH,
			"display_name_en":    s.displayEN,
			"description":        s.description,
			"deprecated":         s.deprecated,
			"replacement":        s.replacement,
			"revision":           1,
		}
		if err := db.Model(&citypemodel.RelationType{}).
			Where("name = ? AND category = '' AND revision = 0", s.name).
			Updates(updates).Error; err != nil {
			return fmt.Errorf("cmdb citype: backfill relation type %q: %w", s.name, err)
		}
	}
	return nil
}
