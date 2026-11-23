package ci

import "testing"

// Every managed word must carry a topocortex category and a trait list the
// connector can hand to the ontology without guessing from the CMDB-local
// Category or Direction fields.
func TestTargetRelationTypesCarryTopocortexSemantics(t *testing.T) {
	specs := TargetRelationTypes()
	byName := make(map[string]RelationTypeSpec, len(specs))
	for _, spec := range specs {
		byName[spec.Name] = spec
		if err := ValidateTopocortexCategory(spec.TopocortexCategory); err != nil {
			t.Fatalf("%s: %v", spec.Name, err)
		}
		if err := ValidateTopocortexTraits(spec.Traits); err != nil {
			t.Fatalf("%s: %v", spec.Name, err)
		}
	}

	runsOn := byName["RUNS_ON"]
	if !hasTrait(runsOn.Traits, TraitHosting) || !hasTrait(runsOn.Traits, TraitFailureDomain) {
		t.Fatalf("RUNS_ON traits = %v, want hosting and failure_domain", runsOn.Traits)
	}
	calls := byName["CALLS"]
	if !hasTrait(calls.Traits, TraitDependency) {
		t.Fatalf("CALLS traits = %v, want dependency", calls.Traits)
	}
	contains := byName["CONTAINS"]
	if !hasTrait(contains.Traits, TraitStructuralRollup) {
		t.Fatalf("CONTAINS traits = %v, want structural_rollup from target PART_OF", contains.Traits)
	}
	hasMember := byName["HAS_MEMBER"]
	if !hasTrait(hasMember.Traits, TraitStructuralRollup) {
		t.Fatalf("HAS_MEMBER traits = %v, want structural_rollup", hasMember.Traits)
	}
	hasInstance := byName["HAS_INSTANCE"]
	if hasInstance.InverseOf != "REPLICA_OF" {
		t.Fatalf("HAS_INSTANCE inverse = %q, want REPLICA_OF", hasInstance.InverseOf)
	}
	if !hasTrait(hasInstance.Traits, TraitReplicaMembership) {
		t.Fatalf("HAS_INSTANCE traits = %v, want replica_membership", hasInstance.Traits)
	}
	manages := byName["MANAGES"]
	if manages.InverseOf != "OWNED_BY" || manages.Propagates ||
		!hasTrait(manages.Traits, TraitOwnership) {
		t.Fatalf("MANAGES semantics = %+v", manages)
	}
}

func TestValidateTargetRelationTypes(t *testing.T) {
	if err := ValidateTargetRelationTypes(); err != nil {
		t.Fatalf("target vocabulary is invalid: %v", err)
	}
}

func TestTargetRelationTypesCoverAIOpsVocabulary(t *testing.T) {
	byName := make(map[string]RelationTypeSpec)
	for _, spec := range TargetRelationTypes() {
		byName[spec.Name] = spec
	}
	for _, name := range []string{
		"MONITORING_OF", "PUBLISHES_TO", "SUBSCRIBES_TO", "READS_FROM",
		"WRITES_TO", "USES_DATABASE", "REPLICATES_FROM",
	} {
		if _, ok := byName[name]; !ok {
			t.Fatalf("target vocabulary is missing %s", name)
		}
	}
	if !hasTrait(byName["MONITORING_OF"].Traits, TraitMonitoring) {
		t.Fatalf("MONITORING_OF traits = %v, want monitoring", byName["MONITORING_OF"].Traits)
	}
	if byName["MONITORING_OF"].Propagates {
		t.Fatal("MONITORING_OF must not propagate")
	}
	for _, name := range []string{"PUBLISHES_TO", "SUBSCRIBES_TO", "READS_FROM", "WRITES_TO"} {
		if !hasTrait(byName[name].Traits, TraitDependency) || !byName[name].Propagates {
			t.Fatalf("%s must be a propagating dependency: %+v", name, byName[name])
		}
	}
	for _, name := range []string{"USES_DATABASE", "REPLICATES_FROM"} {
		if !hasTrait(byName[name].SubPropertyOf, "DEPENDS_ON") {
			t.Fatalf("%s sub_property_of = %v, want DEPENDS_ON", name, byName[name].SubPropertyOf)
		}
	}
}

func TestValidateRelationTypeSpecRejectsUnknownInverseTarget(t *testing.T) {
	spec := RelationTypeSpec{
		Name:               "BAD",
		TopocortexCategory: TopocortexCategoryAssociation,
		Traits:             []string{TraitStructuralRollup},
		InverseOf:          "NOT_A_TOPOCORTEX_TYPE",
	}
	if err := ValidateRelationTypeSpec(spec); err == nil {
		t.Fatal("an unknown inverse target was accepted")
	}
}

func TestValidateRelationTypeSpecRejectsNonPropagatingTraitWithPropagates(t *testing.T) {
	spec := RelationTypeSpec{
		Name:               "BAD",
		TopocortexCategory: TopocortexCategoryAssociation,
		Traits:             []string{TraitStructuralRollup},
		Propagates:         true,
		Weight:             1,
	}
	if err := ValidateRelationTypeSpec(spec); err == nil {
		t.Fatal("a structural_rollup type must not declare propagates=true")
	}
}

func TestValidateRelationTypeSpecRejectsPropagatingZeroWeight(t *testing.T) {
	spec := RelationTypeSpec{
		Name:               "BAD",
		TopocortexCategory: TopocortexCategoryDependency,
		Traits:             []string{TraitDependency},
		Propagates:         true,
		Weight:             0,
	}
	if err := ValidateRelationTypeSpec(spec); err == nil {
		t.Fatal("a propagating type needs a positive weight")
	}
}

// TargetRelation is the connector's type-level projection. Direction-inverted
// words name their topocortex target in InverseOf; the connector swaps endpoints
// but keeps the target type's traits.
func TestRelationTypeSpecTargetRelation(t *testing.T) {
	cases := []struct {
		name, target string
		invert       bool
	}{
		{"RUNS_ON", "RUNS_ON", false},
		{"CONTAINS", "PART_OF", true},
		{"HAS_MEMBER", "MEMBER_OF", true},
		{"HAS_INSTANCE", "REPLICA_OF", true},
		{"HAS_LOCATION", "LOCATED_IN", true},
		{"MANAGES", "OWNED_BY", true},
		{"COVERS", "UNDER_CONTRACT", true},
	}
	byName := make(map[string]RelationTypeSpec)
	for _, spec := range TargetRelationTypes() {
		byName[spec.Name] = spec
	}
	for _, tc := range cases {
		target, invert := byName[tc.name].TargetRelation()
		if target != tc.target || invert != tc.invert {
			t.Fatalf("%s target = %q invert=%v, want %q/%v", tc.name, target, invert, tc.target, tc.invert)
		}
	}
}

func TestValidateTopocortexCategoryRejectsUnknown(t *testing.T) {
	for _, valid := range []string{"dependency", "association", "monitoring", "ownership", "other"} {
		if err := ValidateTopocortexCategory(valid); err != nil {
			t.Fatalf("valid category %q rejected: %v", valid, err)
		}
	}
	if err := ValidateTopocortexCategory("runtime"); err == nil {
		t.Fatal("runtime is a CMDB-local category, not a topocortex category")
	}
	if err := ValidateTopocortexCategory(""); err == nil {
		t.Fatal("an empty topocortex category must be rejected for a managed word")
	}
}

func TestValidateTopocortexTraitsRejectsUnknownAndDuplicate(t *testing.T) {
	if err := ValidateTopocortexTraits([]string{TraitDependency, TraitHosting}); err != nil {
		t.Fatalf("valid traits rejected: %v", err)
	}
	if err := ValidateTopocortexTraits([]string{"NOT_A_TRAIT"}); err == nil {
		t.Fatal("unknown trait was accepted")
	}
	if err := ValidateTopocortexTraits([]string{TraitDependency, TraitDependency}); err == nil {
		t.Fatal("duplicate trait was accepted")
	}
}

func hasTrait(traits []string, want string) bool {
	for _, trait := range traits {
		if trait == want {
			return true
		}
	}
	return false
}
