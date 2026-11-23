package connector

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/ongridio/ongrid/internal/cmdb/biz/relationmap"
)

type fakeTarget struct {
	declarations []Declaration
	types        []RelationType
	created      bool
	failAt       int
	declCalls    int
	typeCalls    int
}

func (f *fakeTarget) EnsureRelationDeclaration(_ context.Context, decl Declaration) (bool, error) {
	f.declCalls++
	if f.failAt > 0 && f.declCalls == f.failAt {
		return false, errors.New("target rejected declaration")
	}
	f.declarations = append(f.declarations, decl)
	return f.created, nil
}

func (f *fakeTarget) EnsureRelationType(_ context.Context, typ RelationType) error {
	f.typeCalls++
	f.types = append(f.types, typ)
	return nil
}

func containmentPlan() relationmap.Report {
	return relationmap.Report{
		Rules: 1, Edges: 2, ResolvedRules: 1, ResolvedEdges: 2,
		InvertedRules: 1, InvertedEdges: 2,
		Mappings: []relationmap.Mapping{{
			SourceType: "CONTAINS", ParentModel: "room", ChildModel: "rack",
			TargetType: "PART_OF", Invert: true, Cardinality: "N:1",
			Propagates: false, Weight: 0, Category: "association",
			Traits: []string{"structural_rollup"}, Transitive: true,
			Sample: "rack -PART_OF-> room",
		}},
	}
}

func TestApplyInvertsContainment(t *testing.T) {
	target := &fakeTarget{created: true}
	report, err := Apply(context.Background(), containmentPlan(), Options{Target: target})
	if err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if report.DeclarationsCreated != 1 || report.RelationTypes != 1 {
		t.Fatalf("report = %+v", report)
	}
	if len(target.declarations) != 1 {
		t.Fatalf("declarations = %+v", target.declarations)
	}
	decl := target.declarations[0]
	if decl.RelationType != "PART_OF" || decl.SourceClass != "rack" ||
		decl.TargetClass != "room" || decl.Cardinality != "N:1" || decl.Propagates {
		t.Fatalf("declaration = %+v", decl)
	}
	if len(target.types) != 1 {
		t.Fatalf("types = %+v", target.types)
	}
	typ := target.types[0]
	if typ.Name != "PART_OF" || typ.Category != "association" || !typ.Transitive ||
		len(typ.Traits) != 1 || typ.Traits[0] != "structural_rollup" {
		t.Fatalf("type = %+v", typ)
	}
}

func TestApplyUsesClassMapping(t *testing.T) {
	target := &fakeTarget{created: true}
	_, err := Apply(context.Background(), containmentPlan(), Options{
		Target: target,
		ClassMapping: map[string]string{
			"room": "DataCenter",
			"rack": "Rack",
		},
	})
	if err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	decl := target.declarations[0]
	if decl.SourceClass != "Rack" || decl.TargetClass != "DataCenter" {
		t.Fatalf("declaration = %+v", decl)
	}
}

func TestApplyRejectsBlockedPlanBeforeWriting(t *testing.T) {
	plan := containmentPlan()
	plan.Blocked = true
	plan.UnresolvedRules = 1
	target := &fakeTarget{created: true}

	_, err := Apply(context.Background(), plan, Options{Target: target})
	if !errors.Is(err, ErrPlanBlocked) {
		t.Fatalf("error = %v, want ErrPlanBlocked", err)
	}
	if target.declCalls != 0 || target.typeCalls != 0 {
		t.Fatalf("target was called for a blocked plan: %+v", target)
	}
}

func TestApplyRejectsMissingClassMappingBeforeWriting(t *testing.T) {
	target := &fakeTarget{created: true}
	_, err := Apply(context.Background(), containmentPlan(), Options{
		Target:       target,
		ClassMapping: map[string]string{"room": "DataCenter"},
	})
	if !errors.Is(err, ErrClassMappingMissing) {
		t.Fatalf("error = %v, want ErrClassMappingMissing", err)
	}
	if target.declCalls != 0 {
		t.Fatalf("target was called before class preflight: %+v", target)
	}
}

func TestApplyGroupsRelationTypes(t *testing.T) {
	plan := containmentPlan()
	plan.Mappings = append(plan.Mappings, relationmap.Mapping{
		SourceType: "CONTAINS", ParentModel: "dc", ChildModel: "room",
		TargetType: "PART_OF", Invert: true, Cardinality: "N:1",
		Category: "association", Traits: []string{"structural_rollup"}, Transitive: true,
	})
	target := &fakeTarget{created: true}

	report, err := Apply(context.Background(), plan, Options{Target: target})
	if err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if report.DeclarationsCreated != 2 || report.RelationTypes != 1 {
		t.Fatalf("report = %+v", report)
	}
	if target.declCalls != 2 || target.typeCalls != 1 {
		t.Fatalf("calls: declarations=%d types=%d", target.declCalls, target.typeCalls)
	}
}

func TestApplyReportsPartialFailure(t *testing.T) {
	plan := containmentPlan()
	plan.Mappings = append(plan.Mappings, relationmap.Mapping{
		SourceType: "CONTAINS", ParentModel: "dc", ChildModel: "room",
		TargetType: "PART_OF", Invert: true, Cardinality: "N:1",
		Category: "association", Traits: []string{"structural_rollup"}, Transitive: true,
	})
	target := &fakeTarget{created: true, failAt: 2}

	report, err := Apply(context.Background(), plan, Options{Target: target})
	if err == nil || !strings.Contains(err.Error(), "dc") {
		t.Fatalf("error = %v, want a contextual failure", err)
	}
	if report == nil || report.DeclarationsCreated != 1 {
		t.Fatalf("report = %+v", report)
	}
}

func TestApplyRejectsConflictingTypeMetadata(t *testing.T) {
	plan := containmentPlan()
	plan.Mappings = append(plan.Mappings, relationmap.Mapping{
		SourceType: "CONTAINS", ParentModel: "dc", ChildModel: "room",
		TargetType: "PART_OF", Invert: true, Cardinality: "N:1",
		Category: "dependency", Traits: []string{"structural_rollup"}, Transitive: true,
	})
	_, err := Apply(context.Background(), plan, Options{Target: &fakeTarget{created: true}})
	if !errors.Is(err, ErrConflictingTypeMetadata) {
		t.Fatalf("error = %v, want ErrConflictingTypeMetadata", err)
	}
}
