package relationmap

import (
	"strings"
	"testing"
)

func readyType(name string, inverseOf string, propagates bool, weight float64, traits ...string) TypeSemantics {
	return TypeSemantics{
		Name:               name,
		OntologyReady:      true,
		TopocortexCategory: "association",
		Traits:             traits,
		InverseOf:          inverseOf,
		PropagatesDefault:  propagates,
		WeightDefault:      weight,
	}
}

func TestPlanInvertsStructuralRule(t *testing.T) {
	rules := []Rule{{
		RelationType: "CONTAINS", ParentModel: "dcim_server_room",
		ChildModel: "dcim_rack", Constraint: "0", EdgeCount: 12,
	}}
	types := map[string]TypeSemantics{
		"CONTAINS": readyType("CONTAINS", "PART_OF", false, 0, "structural_rollup"),
	}

	report := Plan(rules, types, nil)
	if report.Rules != 1 || report.Edges != 12 || report.ResolvedRules != 1 ||
		report.ResolvedEdges != 12 || report.InvertedRules != 1 || report.InvertedEdges != 12 {
		t.Fatalf("report totals = %+v", report)
	}
	if report.UnresolvedRules != 0 || report.ReviewRules != 0 || report.Blocked {
		t.Fatalf("report unexpectedly blocked: %+v", report)
	}
	m := report.Mappings[0]
	if m.TargetType != "PART_OF" || !m.Invert || m.Cardinality != "N:1" ||
		m.Propagates || m.Review || m.Unresolved != "" {
		t.Fatalf("mapping = %+v", m)
	}
	if m.Sample != "dcim_rack -PART_OF-> dcim_server_room" {
		t.Fatalf("sample = %q", m.Sample)
	}
}

func TestPlanCopiesTypeMetadata(t *testing.T) {
	rules := []Rule{{RelationType: "USES_DATABASE", ParentModel: "service", ChildModel: "database"}}
	typ := readyType("USES_DATABASE", "", true, 0.7, "dependency")
	typ.SubPropertyOf = []string{"DEPENDS_ON"}
	report := Plan(rules, map[string]TypeSemantics{"USES_DATABASE": typ}, nil)
	m := report.Mappings[0]
	if len(m.SubPropertyOf) != 1 || m.SubPropertyOf[0] != "DEPENDS_ON" {
		t.Fatalf("sub_property_of = %v", m.SubPropertyOf)
	}
	if !m.Propagates || m.Weight != 0.7 {
		t.Fatalf("propagation = %+v", m)
	}
}

func TestPlanKeepsDirectionSafeRule(t *testing.T) {
	rules := []Rule{{
		RelationType: "RUNS_ON", ParentModel: "service_instance",
		ChildModel: "host", Constraint: "0", EdgeCount: 7,
	}}
	types := map[string]TypeSemantics{
		"RUNS_ON": readyType("RUNS_ON", "", true, 1.0, "hosting", "failure_domain"),
	}

	report := Plan(rules, types, nil)
	m := report.Mappings[0]
	if m.TargetType != "RUNS_ON" || m.Invert || m.Cardinality != "1:N" ||
		!m.Propagates || m.Weight != 1.0 {
		t.Fatalf("mapping = %+v", m)
	}
	if m.Sample != "service_instance -RUNS_ON-> host" {
		t.Fatalf("sample = %q", m.Sample)
	}
}

func TestPlanInvertsCardinalityWithRule(t *testing.T) {
	cases := []struct {
		constraint, want string
	}{
		{"0", "N:1"},
		{"1", "1:1"},
		{"2", "N:M"},
		{"", "N:1"},
	}
	for _, tc := range cases {
		t.Run(tc.constraint, func(t *testing.T) {
			rules := []Rule{{RelationType: "CONTAINS", ParentModel: "p", ChildModel: "c", Constraint: tc.constraint}}
			types := map[string]TypeSemantics{"CONTAINS": readyType("CONTAINS", "PART_OF", false, 0)}
			if got := Plan(rules, types, nil).Mappings[0].Cardinality; got != tc.want {
				t.Fatalf("cardinality = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestPlanReviewsUnknownConstraint(t *testing.T) {
	rules := []Rule{{RelationType: "CONTAINS", ParentModel: "p", ChildModel: "c", Constraint: "9"}}
	types := map[string]TypeSemantics{"CONTAINS": readyType("CONTAINS", "PART_OF", false, 0)}
	report := Plan(rules, types, nil)
	m := report.Mappings[0]
	if !m.Review || m.Cardinality != "N:1" || !report.Blocked {
		t.Fatalf("mapping = %+v report = %+v", m, report)
	}
}

func TestPlanUnresolvedForMissingLocalOnlyAndDeprecatedTypes(t *testing.T) {
	rules := []Rule{
		{RelationType: "MISSING", ParentModel: "p", ChildModel: "c", EdgeCount: 1},
		{RelationType: "LOCAL", ParentModel: "p", ChildModel: "c", EdgeCount: 2},
		{RelationType: "OLD", ParentModel: "p", ChildModel: "c", EdgeCount: 3},
	}
	types := map[string]TypeSemantics{
		"LOCAL": {Name: "LOCAL", OntologyReady: false},
		"OLD": {
			Name: "OLD", OntologyReady: true, TopocortexCategory: "dependency",
			Traits: []string{"dependency"}, Deprecated: true, Replacement: "NEW",
		},
	}
	report := Plan(rules, types, nil)
	if report.UnresolvedRules != 3 || report.UnresolvedEdges != 6 || !report.Blocked {
		t.Fatalf("report = %+v", report)
	}
	reasons := strings.Join([]string{
		report.Mappings[0].Unresolved,
		report.Mappings[1].Unresolved,
		report.Mappings[2].Unresolved,
	}, "|")
	for _, want := range []string{"not declared", "local-only", "deprecated", "NEW"} {
		if !strings.Contains(reasons, want) {
			t.Fatalf("unresolved reasons = %q, want %q", reasons, want)
		}
	}
}

func TestPlanReviewsPropagatingRuleWithMissingWeight(t *testing.T) {
	rules := []Rule{{RelationType: "CALLS", ParentModel: "caller", ChildModel: "callee", Constraint: "2"}}
	types := map[string]TypeSemantics{
		"CALLS": readyType("CALLS", "", true, 0, "dependency"),
	}
	report := Plan(rules, types, nil)
	m := report.Mappings[0]
	if !m.Review || m.Unresolved != "" || m.Weight != 1.0 || !report.Blocked {
		t.Fatalf("mapping = %+v report = %+v", m, report)
	}
}

func TestPlanAppliesPerPairOverride(t *testing.T) {
	rules := []Rule{{RelationType: "CONTAINS", ParentModel: "room", ChildModel: "rack", Constraint: "0"}}
	types := map[string]TypeSemantics{"CONTAINS": readyType("CONTAINS", "PART_OF", false, 0)}
	overrides := []Override{{
		SourceType: "CONTAINS", ParentModel: "room", ChildModel: "rack",
		TargetType: "LOCATED_IN", Invert: boolPtr(false), Cardinality: "1:N",
		Review: true, Note: "physical location is stored child->parent in this deployment",
	}}
	report := Plan(rules, types, overrides)
	m := report.Mappings[0]
	if m.TargetType != "LOCATED_IN" || m.Invert || m.Cardinality != "1:N" || !m.Review {
		t.Fatalf("mapping = %+v", m)
	}
	if m.Note != "physical location is stored child->parent in this deployment" {
		t.Fatalf("note = %q", m.Note)
	}
}

func boolPtr(v bool) *bool { return &v }
