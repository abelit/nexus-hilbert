package federation

import (
	"strings"
	"testing"
)

func TestExpr(t *testing.T) {
	if got := Expr("status", "eq", "firing"); got != "status:eq:firing" {
		t.Fatalf("Expr = %q", got)
	}
	if got := Expr("alert.labels.host", "exists", ""); got != "alert.labels.host:exists" {
		t.Fatalf("exists Expr = %q", got)
	}
	if got := Expr("status", "eq", ""); got != "status:eq" {
		t.Fatalf("empty value Expr = %q", got)
	}
}

func TestValidateRuleRejectsBadShapes(t *testing.T) {
	cases := []struct {
		name string
		rule Rule
		want string
	}{
		{"bad field", Rule{Field: "a.$b", Op: "eq", ValueType: ValueTypeFixed, Values: []string{"x"}}, "field"},
		{"bad op", Rule{Field: "a", Op: "like", ValueType: ValueTypeFixed, Values: []string{"x"}}, "op"},
		{"identity with range", Rule{Field: "a", Op: "gt", ValueType: ValueTypeIdentity, Identity: "email"}, "identity"},
		{"bad identity source", Rule{Field: "a", Op: "eq", ValueType: ValueTypeIdentity, Identity: "org"}, "identity"},
		{"fixed without values", Rule{Field: "a", Op: "eq", ValueType: ValueTypeFixed}, "value"},
		{"in with comma", Rule{Field: "a", Op: "in", ValueType: ValueTypeFixed, Values: []string{"x,y"}}, "comma"},
		{"multi value on eq", Rule{Field: "a", Op: "eq", ValueType: ValueTypeFixed, Values: []string{"x", "y"}}, "single"},
		{"bad regex", Rule{Field: "a", Op: "regex", ValueType: ValueTypeFixed, Values: []string{"("}}, "regex"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ValidateRule(tc.rule)
			if err == nil {
				t.Fatalf("expected error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want substring %q", err, tc.want)
			}
		})
	}
}

func TestValidateRuleNormalizes(t *testing.T) {
	got, err := ValidateRule(Rule{Field: " alert.labels.host ", Op: "", ValueType: "", Identity: " email "})
	if err != nil {
		t.Fatalf("ValidateRule: %v", err)
	}
	if got.Field != "alert.labels.host" || got.Op != "eq" || got.ValueType != ValueTypeIdentity || got.Identity != "email" {
		t.Fatalf("normalized = %+v", got)
	}

	exists, err := ValidateRule(Rule{Field: "a", Op: "exists", ValueType: ValueTypeIdentity, Values: []string{"x"}})
	if err != nil {
		t.Fatalf("exists: %v", err)
	}
	if exists.ValueType != ValueTypeFixed || len(exists.Values) != 0 || exists.Identity != "" {
		t.Fatalf("exists rule = %+v", exists)
	}
}

func TestValidateFilterRejectsBadShapes(t *testing.T) {
	validRule := Rule{Field: "a", Op: "eq", ValueType: ValueTypeFixed, Values: []string{"x"}}
	cases := []struct {
		name   string
		filter FilterInput
		want   string
	}{
		{"reserved key", FilterInput{Key: "all", Name: "x", Usage: UsageFilter, And: []Rule{validRule}}, "reserved"},
		{"bad key", FilterInput{Key: "Bad Key", Name: "x", Usage: UsageFilter, And: []Rule{validRule}}, "key"},
		{"empty name", FilterInput{Key: "mine", Name: " ", Usage: UsageFilter, And: []Rule{validRule}}, "name"},
		{"bad usage", FilterInput{Key: "mine", Name: "x", Usage: "other", And: []Rule{validRule}}, "usage"},
		{"no rules", FilterInput{Key: "mine", Name: "x", Usage: UsageFilter}, "rule"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ValidateFilter(tc.filter, "")
			if err == nil {
				t.Fatalf("expected error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want substring %q", err, tc.want)
			}
		})
	}
}

func TestValidateFilterNormalizesKeyFromPath(t *testing.T) {
	got, err := ValidateFilter(FilterInput{
		Key:   "ignored",
		Name:  " Mine ",
		Usage: UsageBoth,
		And:   []Rule{{Field: "status", Op: "eq", ValueType: ValueTypeFixed, Values: []string{"firing"}}},
	}, "mine")
	if err != nil {
		t.Fatalf("ValidateFilter: %v", err)
	}
	if got.Key != "mine" || got.Name != "Mine" || !got.Enabled || got.Usage != UsageBoth {
		t.Fatalf("normalized = %+v", got)
	}
}

func TestBuildPredicateANDVoids(t *testing.T) {
	filter := Filter{
		And: []Rule{
			{Field: "owner", Op: "eq", ValueType: ValueTypeIdentity, Identity: "email"},
			{Field: "status", Op: "eq", ValueType: ValueTypeFixed, Values: []string{"firing"}},
		},
	}
	and, or, bound := BuildPredicate(filter, map[string][]string{"email": {"a@b"}})
	if !bound || len(and) != 2 || len(or) != 0 {
		t.Fatalf("bound predicate = %v %v %v", and, or, bound)
	}
	if and[0] != "owner:eq:a@b" || and[1] != "status:eq:firing" {
		t.Fatalf("and = %v", and)
	}

	and, or, bound = BuildPredicate(filter, map[string][]string{})
	if bound || and != nil || or != nil {
		t.Fatalf("unbound predicate must void: %v %v %v", and, or, bound)
	}
}

func TestBuildPredicateORSkippedAndMultiValues(t *testing.T) {
	filter := Filter{
		And: []Rule{{Field: "status", Op: "in", ValueType: ValueTypeFixed, Values: []string{"firing", "acked"}}},
		Or: []Rule{
			{Field: "owner", Op: "eq", ValueType: ValueTypeIdentity, Identity: "phone"},
			{Field: "team", Op: "eq", ValueType: ValueTypeIdentity, Identity: "email"},
		},
	}
	and, or, bound := BuildPredicate(filter, map[string][]string{"email": {"a@b", "c@d"}})
	if !bound || len(and) != 1 || len(or) != 2 {
		t.Fatalf("predicate = %v %v %v", and, or, bound)
	}
	if and[0] != "status:in:firing,acked" {
		t.Fatalf("and = %v", and)
	}
	if or[0] != "team:eq:a@b" || or[1] != "team:eq:c@d" {
		t.Fatalf("or = %v", or)
	}
}

func TestBuildPredicateIdentityMultiDropsCommas(t *testing.T) {
	filter := Filter{Or: []Rule{{Field: "owner", Op: "in", ValueType: ValueTypeIdentity, Identity: "email"}}}
	_, or, bound := BuildPredicate(filter, map[string][]string{"email": {"a,b", "c@d"}})
	if !bound || len(or) != 1 || or[0] != "owner:in:c@d" {
		t.Fatalf("or = %v bound=%v", or, bound)
	}
}

func TestBuildPredicateFixedOnlyIsBound(t *testing.T) {
	filter := Filter{And: []Rule{{Field: "status", Op: "eq", ValueType: ValueTypeFixed, Values: []string{"firing"}}}}
	and, _, bound := BuildPredicate(filter, nil)
	if !bound || len(and) != 1 {
		t.Fatalf("fixed-only predicate = %v bound=%v", and, bound)
	}
}
