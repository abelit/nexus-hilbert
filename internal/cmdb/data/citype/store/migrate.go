// Package store implements CMDB persistence for model definitions: CI types,
// attributes, their bindings and groupings, model-level relations, and the
// relation-type dictionary.
package store

import (
	"errors"
	"fmt"

	"gorm.io/gorm"

	cibiz "github.com/ongridio/ongrid/internal/cmdb/biz/ci"
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
	if err := backfillTargetRelationTypeSemantics(db); err != nil {
		return err
	}
	if err := backfillHasInstanceInverse(db); err != nil {
		return err
	}
	if err := backfillInverseRelationTypes(db); err != nil {
		return err
	}
	return renameLegacyManage(db)
}

// The vocabulary words whose CMDB storage direction is the INVERSE of the
// topocortex relation they map to.
//
// DO NOT FLIP THE EDGES. MANAGES (legacy manage) has 6 one2many rules and contain has 36; a flip
// would turn them into many2one, which the CMDB constraint model does not have.
// The ontology connector reverses the endpoints using this field instead.
func backfillInverseRelationTypes(db *gorm.DB) error {
	inverses := []struct{ name, inverse string }{
		{"contain", "PART_OF"},
		{"manage", "OWNED_BY"},
		{"MANAGES", "OWNED_BY"},
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
		name, category, topocortexCategory, direction string
		replacement                                   string
		traits                                        []string
		propagates, transitive, deprecated            bool
		weight                                        float64
	}
	seeds := []seed{
		{
			name: "contain", category: "structure", topocortexCategory: "association",
			direction: "src_to_dst",
			traits:    []string{cibiz.TraitStructuralRollup}, transitive: true,
		},
		{
			name: "deploy", category: "runtime", topocortexCategory: "dependency",
			direction:  "dst_to_src",
			traits:     []string{cibiz.TraitHosting, cibiz.TraitFailureDomain},
			propagates: true, weight: 1.0,
		},
		{
			name: "install", category: "runtime", topocortexCategory: "dependency",
			direction: "dst_to_src", replacement: "RUNS_ON",
			traits:     []string{cibiz.TraitHosting, cibiz.TraitFailureDomain},
			propagates: true, weight: 0.8, deprecated: true,
		},
		{
			name: "connect", category: "dependency", topocortexCategory: "dependency",
			direction:  "bidirectional",
			traits:     []string{cibiz.TraitDependency},
			propagates: true, weight: 0.6,
		},
		{
			name: "manage", category: "ownership", topocortexCategory: "ownership",
			direction: "src_to_dst",
			traits:    []string{cibiz.TraitOwnership},
		},
		{
			name: "MANAGES", category: "ownership", topocortexCategory: "ownership",
			direction: "src_to_dst",
			traits:    []string{cibiz.TraitOwnership},
		},
		{
			name: "bind", category: "ownership", topocortexCategory: "ownership",
			direction: "src_to_dst",
			traits:    []string{cibiz.TraitOwnership},
		},
		{
			name: "depend", category: "dependency", topocortexCategory: "dependency",
			direction:  "dst_to_src",
			traits:     []string{cibiz.TraitDependency},
			propagates: true, weight: 0.8,
		},
		{
			name: "run", category: "runtime", topocortexCategory: "dependency",
			direction:  "dst_to_src",
			traits:     []string{cibiz.TraitHosting, cibiz.TraitFailureDomain},
			propagates: true, weight: 1.0,
		},
	}
	for _, s := range seeds {
		patch := citypemodel.RelationType{
			Category:           s.category,
			TopocortexCategory: s.topocortexCategory,
			Direction:          s.direction,
			PropagatesDefault:  s.propagates,
			WeightDefault:      s.weight,
			Transitive:         s.transitive,
			Traits:             citypemodel.StringList(s.traits),
			Deprecated:         s.deprecated,
			Replacement:        s.replacement,
			Revision:           1,
		}
		if err := db.Model(&citypemodel.RelationType{}).
			Where("name = ? AND category = '' AND revision = 0", s.name).
			Select(
				"category", "topocortex_category", "direction",
				"propagates_default", "weight_default", "transitive", "traits",
				"deprecated", "replacement", "revision",
			).
			Updates(&patch).Error; err != nil {
			return fmt.Errorf("cmdb citype: backfill relation type %q: %w", s.name, err)
		}
	}
	return nil
}

// renameLegacyManage renames the legacy active word manage to MANAGES when the
// target row does not exist. Both spellings are the CMDB-side inverse of
// topocortex OWNED_BY; the row is renamed in place, so model rules and instance
// edges (which reference the id) do not move.
//
// If both rows exist, the active MANAGES wins and manage becomes a deprecated
// alias instead of being deleted: existing rules and edges still reference it.
func renameLegacyManage(db *gorm.DB) error {
	var manages int64
	if err := db.Model(&citypemodel.RelationType{}).
		Where("name = ?", "MANAGES").Count(&manages).Error; err != nil {
		return fmt.Errorf("cmdb citype: check MANAGES: %w", err)
	}
	if manages == 0 {
		if err := db.Model(&citypemodel.RelationType{}).
			Where("name = ?", "manage").
			Update("name", "MANAGES").Error; err != nil {
			return fmt.Errorf("cmdb citype: rename manage to MANAGES: %w", err)
		}
		return nil
	}
	if err := db.Model(&citypemodel.RelationType{}).
		Where("name = ? AND deprecated = ? AND replacement = ?", "manage", false, "").
		Updates(map[string]any{"deprecated": true, "replacement": "MANAGES"}).Error; err != nil {
		return fmt.Errorf("cmdb citype: deprecate legacy manage: %w", err)
	}
	return nil
}

// backfillHasInstanceInverse corrects the one inverse target that changed
// meaning: topocortex's runtime seed uses REPLICA_OF, not the removed
// INSTANCE_OF. Only the old value is rewritten, so a later ontology sync keeps
// whatever target it chose.
func backfillHasInstanceInverse(db *gorm.DB) error {
	if err := db.Model(&citypemodel.RelationType{}).
		Where("name = ? AND inverse_of = ?", "HAS_INSTANCE", "INSTANCE_OF").
		Update("inverse_of", "REPLICA_OF").Error; err != nil {
		return fmt.Errorf("cmdb citype: backfill HAS_INSTANCE inverse: %w", err)
	}
	if err := db.Model(&citypemodel.RelationType{}).
		Where("name = ? AND inverse_of = ? AND revision < 2", "HAS_INSTANCE", "REPLICA_OF").
		Update("revision", 2).Error; err != nil {
		return fmt.Errorf("cmdb citype: bump HAS_INSTANCE revision: %w", err)
	}
	return nil
}

// backfillTargetRelationTypeSemantics fills the topocortex mirror on rows that
// an earlier version of the target-vocabulary command created before the
// mirror columns existed. Those rows already carry Category/Direction/Revision,
// so backfillRelationTypeSemantics deliberately skips them.
//
// ONLY AN EMPTY topocortex_category IS TOUCHED. A value written by a later
// ontology sync — even one an operator is reviewing — is never overwritten.
func backfillTargetRelationTypeSemantics(db *gorm.DB) error {
	for _, spec := range cibiz.TargetRelationTypes() {
		patch := citypemodel.RelationType{
			TopocortexCategory: spec.TopocortexCategory,
			Traits:             citypemodel.StringList(spec.Traits),
			SubPropertyOf:      citypemodel.StringList(spec.SubPropertyOf),
		}
		if err := db.Model(&citypemodel.RelationType{}).
			Where("name = ? AND topocortex_category = ''", spec.Name).
			Select("topocortex_category", "traits", "sub_property_of").
			Updates(&patch).Error; err != nil {
			return fmt.Errorf("cmdb citype: backfill topocortex semantics for %q: %w", spec.Name, err)
		}
	}
	return nil
}
