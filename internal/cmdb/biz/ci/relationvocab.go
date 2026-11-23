package ci

import "fmt"

// Topocortex relation categories. This is the closed governance vocabulary
// nexus-topocortex validates; the CMDB cannot import that module, so the copy
// must be kept in sync with internal/ontology/taxonomy.go there.
const (
	TopocortexCategoryDependency  = "dependency"
	TopocortexCategoryAssociation = "association"
	TopocortexCategoryMonitoring  = "monitoring"
	TopocortexCategoryOwnership   = "ownership"
	TopocortexCategoryOther       = "other"
)

// Topocortex AIOps relation traits. This is the machine-readable contract
// nexus-topocortex reads (business impact uses structural_rollup, availability
// uses failure_domain, and so on). Category is display/governance metadata only;
// these traits are the semantics the connector must carry.
const (
	TraitDependency        = "dependency"
	TraitHosting           = "hosting"
	TraitStructuralRollup  = "structural_rollup"
	TraitReplicaMembership = "replica_membership"
	TraitAvailabilityGroup = "availability_group"
	TraitFailover          = "failover"
	TraitFailureDomain     = "failure_domain"
	TraitLocation          = "location"
	TraitMonitoring        = "monitoring"
	TraitOwnership         = "ownership"
	TraitLifecycle         = "lifecycle"
	TraitDataLineage       = "data_lineage"
	TraitSignalTarget      = "signal_target"
)

var topocortexCategories = map[string]struct{}{
	TopocortexCategoryDependency:  {},
	TopocortexCategoryAssociation: {},
	TopocortexCategoryMonitoring:  {},
	TopocortexCategoryOwnership:   {},
	TopocortexCategoryOther:       {},
}

var topocortexTraits = map[string]struct{}{
	TraitDependency:        {},
	TraitHosting:           {},
	TraitStructuralRollup:  {},
	TraitReplicaMembership: {},
	TraitAvailabilityGroup: {},
	TraitFailover:          {},
	TraitFailureDomain:     {},
	TraitLocation:          {},
	TraitMonitoring:        {},
	TraitOwnership:         {},
	TraitLifecycle:         {},
	TraitDataLineage:       {},
	TraitSignalTarget:      {},
}

// ValidateTopocortexCategory accepts one of the closed category values. A
// managed target word must carry one; an unclassified local word may leave it
// empty and stay out of the ontology projection.
func ValidateTopocortexCategory(value string) error {
	if _, ok := topocortexCategories[value]; ok {
		return nil
	}
	return fmt.Errorf("cmdb relation type: %q is not a topocortex category", value)
}

// ValidateTopocortexTraits checks the closed trait vocabulary. Order is
// preserved; duplicates and unknown names are refused.
func ValidateTopocortexTraits(traits []string) error {
	seen := make(map[string]struct{}, len(traits))
	for _, trait := range traits {
		if _, ok := topocortexTraits[trait]; !ok {
			return fmt.Errorf("cmdb relation type: unknown topocortex trait %q", trait)
		}
		if _, duplicate := seen[trait]; duplicate {
			return fmt.Errorf("cmdb relation type: duplicate topocortex trait %q", trait)
		}
		seen[trait] = struct{}{}
	}
	return nil
}

// nonPropagatingTopocortexTraits mirror nexus-topocortex's nonPropagatingTraits:
// a relation carrying one of them must not declare propagates=true. Otherwise
// a trait-based reader and a propagates-based reader compute different impact
// graphs.
// knownTopocortexTargets is the vocabulary a managed word may project to. It
// includes the runtime seed plus the inverse targets the CMDB-side structural
// words require; the latter are connector prerequisites documented in
// docs/design/cmdb-relation-direction-mapping.md.
var knownTopocortexTargets = map[string]struct{}{
	"CALLS": {}, "DEPENDS_ON": {}, "REPLICA_OF": {}, "MEMBER_OF": {},
	"MONITORING_OF": {}, "OWNED_BY": {}, "PART_OF": {}, "PUBLISHES_TO": {},
	"READS_FROM": {}, "REPLICATES_FROM": {}, "RUNS_ON": {}, "USES_DATABASE": {},
	"SUBSCRIBES_TO": {}, "WRITES_TO": {},
	"BELONGS_TO": {}, "LOCATED_IN": {}, "ALLOCATED_TO": {}, "UNDER_CONTRACT": {},
	"POWERED_BY": {}, "CONNECTS_TO": {}, "DEPLOYED_TO": {},
	"CONTAINS": {}, "HAS_MEMBER": {}, "HAS_INSTANCE": {}, "HAS_BELONGING": {},
	"HAS_LOCATION": {}, "ALLOCATES": {}, "COVERS": {},
}

var nonPropagatingTopocortexTraits = map[string]struct{}{
	TraitSignalTarget:      {},
	TraitMonitoring:        {},
	TraitOwnership:         {},
	TraitStructuralRollup:  {},
	TraitAvailabilityGroup: {},
	TraitFailover:          {},
	TraitLocation:          {},
}

// ValidateRelationTypeSpec checks one managed word. It is the CMDB-side twin of
// topocortex's schema validation: the category and traits must be in the closed
// vocabularies, a propagating type must have a positive weight, and a
// non-propagating trait cannot be combined with propagates=true.
func ValidateRelationTypeSpec(spec RelationTypeSpec) error {
	if err := ValidateTopocortexCategory(spec.TopocortexCategory); err != nil {
		return fmt.Errorf("%s: %w", spec.Name, err)
	}
	if err := ValidateTopocortexTraits(spec.Traits); err != nil {
		return fmt.Errorf("%s: %w", spec.Name, err)
	}
	if spec.Propagates && spec.Weight <= 0 {
		return fmt.Errorf("%s: a propagating relation type needs a positive weight", spec.Name)
	}
	if spec.Propagates {
		for _, trait := range spec.Traits {
			if _, nonPropagating := nonPropagatingTopocortexTraits[trait]; nonPropagating {
				return fmt.Errorf("%s: propagating type carries non-propagating trait %q", spec.Name, trait)
			}
		}
	}
	if spec.InverseOf != "" {
		if spec.InverseOf == spec.Name {
			return fmt.Errorf("%s: inverse_of must not name the type itself", spec.Name)
		}
		if _, known := knownTopocortexTargets[spec.InverseOf]; !known {
			return fmt.Errorf("%s: inverse target %q is not a known topocortex type", spec.Name, spec.InverseOf)
		}
	}
	return nil
}

// ValidateTargetRelationTypes checks the whole managed vocabulary. It is called
// by the vocabulary command before any row is written, so an invalid spec fails
// closed instead of creating a half-semantic type.
func ValidateTargetRelationTypes() error {
	seen := make(map[string]struct{})
	for _, spec := range TargetRelationTypes() {
		if spec.Name == "" {
			return fmt.Errorf("cmdb relation type: target vocabulary contains an empty name")
		}
		if _, duplicate := seen[spec.Name]; duplicate {
			return fmt.Errorf("cmdb relation type: duplicate target %q", spec.Name)
		}
		seen[spec.Name] = struct{}{}
		if err := ValidateRelationTypeSpec(spec); err != nil {
			return err
		}
	}
	return nil
}

// TargetRelation is the connector's type-level projection. A direction-inverted
// word names its topocortex target in InverseOf: the connector swaps endpoints
// but keeps the target type's traits. A direction-safe word projects to itself.
func (s RelationTypeSpec) TargetRelation() (targetType string, invert bool) {
	if s.InverseOf != "" {
		return s.InverseOf, true
	}
	return s.Name, false
}

// RelationTypeSpec is one word in the managed relation vocabulary: the CMDB
// mirror of a nexus-topocortex relation type.
//
// The split command creates a word when a live rule needs it, and the built-in
// bootstrap creates the words its own rules need on a fresh database. Both
// paths share this definition so the semantics cannot drift between a migrated
// database and a bootstrapped one.
type RelationTypeSpec struct {
	Name string

	// Category and Direction are CMDB-LOCAL. Category drives the console
	// grouping; Direction drives the manager topology's downstream/upstream
	// calculation. Neither is a topocortex value.
	Category  string
	Direction string

	// TopocortexCategory and Traits are the ontology-facing mirror the
	// connector reads. They are the values nexus-topocortex validation and
	// AIOps consume.
	TopocortexCategory string
	Traits             []string

	InverseOf     string
	SubPropertyOf []string
	Propagates    bool
	Transitive    bool
	Weight        float64
}

// TargetRelationTypes is the post-split vocabulary. Direction-safe words are
// created as-is; structural and contract words are the CMDB-side inverse of
// the topocortex target and declare inverse_of (CMDB stores whole -> part and
// contract -> resource; the connector reverses the endpoints).
//
// TRAITS ARE TARGET-ORIENTED. For a word with InverseOf set, Traits describes
// the type named by InverseOf, not the CMDB-side word: for example CONTAINS
// declares structural_rollup because the connector projects it to PART_OF with
// swapped endpoints. This is what lets AIOps read one trait list without
// re-deriving it from the CMDB-local Category.
//
// The slice is ordered so a migration report lists types deterministically.
func TargetRelationTypes() []RelationTypeSpec {
	return []RelationTypeSpec{
		{
			Name: "RUNS_ON", Category: "runtime", Direction: "dst_to_src",
			TopocortexCategory: TopocortexCategoryDependency,
			Traits:             []string{TraitHosting, TraitFailureDomain},
			Propagates:         true, Weight: 1.0,
		},
		{
			Name: "DEPENDS_ON", Category: "dependency", Direction: "dst_to_src",
			TopocortexCategory: TopocortexCategoryDependency,
			Traits:             []string{TraitDependency},
			Propagates:         true, Weight: 0.8,
		},
		{
			Name: "CALLS", Category: "dependency", Direction: "dst_to_src",
			TopocortexCategory: TopocortexCategoryDependency,
			Traits:             []string{TraitDependency},
			Propagates:         true, Weight: 0.9,
		},
		{
			Name: "DEPLOYED_TO", Category: "dependency", Direction: "dst_to_src",
			TopocortexCategory: TopocortexCategoryDependency,
			Traits:             []string{TraitDependency},
			Propagates:         true, Weight: 0.7,
		},
		{
			Name: "POWERED_BY", Category: "failure-domain", Direction: "dst_to_src",
			TopocortexCategory: TopocortexCategoryDependency,
			Traits:             []string{TraitFailureDomain},
			Propagates:         true, Weight: 1.0,
		},
		{
			Name: "CONNECTS_TO", Category: "dependency", Direction: "dst_to_src",
			TopocortexCategory: TopocortexCategoryDependency,
			Traits:             []string{TraitDependency},
			Propagates:         true, Weight: 0.6,
		},
		{
			Name: "MONITORING_OF", Category: "observability", Direction: "src_to_dst",
			TopocortexCategory: TopocortexCategoryMonitoring,
			Traits:             []string{TraitMonitoring},
			Propagates:         false, Weight: 0,
		},
		{
			Name: "PUBLISHES_TO", Category: "dependency", Direction: "dst_to_src",
			TopocortexCategory: TopocortexCategoryDependency,
			Traits:             []string{TraitDependency},
			Propagates:         true, Weight: 0.6,
		},
		{
			Name: "SUBSCRIBES_TO", Category: "dependency", Direction: "dst_to_src",
			TopocortexCategory: TopocortexCategoryDependency,
			Traits:             []string{TraitDependency},
			Propagates:         true, Weight: 0.4,
		},
		{
			Name: "READS_FROM", Category: "dependency", Direction: "dst_to_src",
			TopocortexCategory: TopocortexCategoryDependency,
			Traits:             []string{TraitDependency},
			Propagates:         true, Weight: 0.8,
		},
		{
			Name: "WRITES_TO", Category: "dependency", Direction: "dst_to_src",
			TopocortexCategory: TopocortexCategoryDependency,
			Traits:             []string{TraitDependency},
			Propagates:         true, Weight: 0.9,
		},
		{
			Name: "USES_DATABASE", Category: "dependency", Direction: "dst_to_src",
			TopocortexCategory: TopocortexCategoryDependency,
			Traits:             []string{TraitDependency},
			SubPropertyOf:      []string{"DEPENDS_ON"},
			Propagates:         true, Weight: 0.7,
		},
		{
			Name: "REPLICATES_FROM", Category: "dependency", Direction: "dst_to_src",
			TopocortexCategory: TopocortexCategoryDependency,
			Traits:             []string{TraitDependency},
			SubPropertyOf:      []string{"DEPENDS_ON"},
			Propagates:         true, Weight: 0.8,
		},
		// Structural types are the CMDB-side inverse of the topocortex target:
		// CMDB stores whole -> part, topocortex PART_OF reads part -> whole.
		{
			Name: "CONTAINS", Category: "structure", Direction: "src_to_dst",
			TopocortexCategory: TopocortexCategoryAssociation,
			Traits:             []string{TraitStructuralRollup},
			InverseOf:          "PART_OF", Transitive: true, Weight: 0,
		},
		{
			Name: "HAS_MEMBER", Category: "structure", Direction: "src_to_dst",
			TopocortexCategory: TopocortexCategoryAssociation,
			Traits:             []string{TraitStructuralRollup},
			InverseOf:          "MEMBER_OF", Weight: 0,
		},
		{
			Name: "HAS_INSTANCE", Category: "structure", Direction: "src_to_dst",
			TopocortexCategory: TopocortexCategoryAssociation,
			Traits:             []string{TraitReplicaMembership},
			InverseOf:          "REPLICA_OF", Weight: 0,
		},
		{
			Name: "HAS_BELONGING", Category: "structure", Direction: "src_to_dst",
			TopocortexCategory: TopocortexCategoryAssociation,
			Traits:             []string{TraitStructuralRollup},
			InverseOf:          "BELONGS_TO", Weight: 0,
		},
		{
			Name: "HAS_LOCATION", Category: "structure", Direction: "src_to_dst",
			TopocortexCategory: TopocortexCategoryAssociation,
			Traits:             []string{TraitLocation},
			InverseOf:          "LOCATED_IN", Weight: 0,
		},
		{
			Name: "ALLOCATES", Category: "structure", Direction: "src_to_dst",
			TopocortexCategory: TopocortexCategoryAssociation,
			Traits:             nil,
			InverseOf:          "ALLOCATED_TO", Weight: 0,
		},
		{
			Name: "MANAGES", Category: "ownership", Direction: "src_to_dst",
			TopocortexCategory: TopocortexCategoryOwnership,
			Traits:             []string{TraitOwnership},
			InverseOf:          "OWNED_BY", Weight: 0,
		},
		{
			Name: "COVERS", Category: "ownership", Direction: "src_to_dst",
			TopocortexCategory: TopocortexCategoryOwnership,
			Traits:             []string{TraitOwnership},
			InverseOf:          "UNDER_CONTRACT", Weight: 0,
		},
	}
}

// TargetRelationType returns one vocabulary word by name.
func TargetRelationType(name string) (RelationTypeSpec, bool) {
	for _, spec := range TargetRelationTypes() {
		if spec.Name == name {
			return spec, true
		}
	}
	return RelationTypeSpec{}, false
}
