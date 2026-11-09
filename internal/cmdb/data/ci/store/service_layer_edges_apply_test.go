package store

import (
	"context"
	"strings"
	"testing"

	"gorm.io/gorm"

	cibiz "github.com/ongridio/ongrid/internal/cmdb/biz/ci"
	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
)

// The M2 projection turns each mapped legacy service -> application DEPENDS_ON
// edge into a business_service -> application_service CONTAINS edge. The old
// edge is untouched, a repeated run is a no-op, and a second business service
// claiming the same application is reported instead of violating the one-to-many
// containment rule.
func TestApplyServiceEdgesProjectsContainsEdges(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := db.AutoMigrate(&citypemodel.CIType{}); err != nil {
		t.Fatalf("migrate types: %v", err)
	}
	for id, name := range map[model.ID]string{
		30: "service", 10: "application", 40: "business_service", 20: "application_service",
	} {
		ct := citypemodel.CIType{Name: name, Alias: name, Enabled: true}
		ct.ID = id
		if err := db.Create(&ct).Error; err != nil {
			t.Fatalf("seed type %s: %v", name, err)
		}
	}
	for id, spec := range map[model.ID]struct{ name, category string }{
		50: {"DEPENDS_ON", "dependency"},
		51: {"CONTAINS", "structure"},
	} {
		rt := citypemodel.RelationType{Name: spec.name, Category: spec.category}
		rt.ID = id
		if err := db.Create(&rt).Error; err != nil {
			t.Fatalf("seed relation type %s: %v", spec.name, err)
		}
	}

	for _, ci := range []struct {
		id, typeID model.ID
	}{
		{1201, 30}, {1202, 30}, {1203, 30},
		{1101, 10},
		{4001, 40}, {4002, 40},
		{4101, 20},
	} {
		row := cimodel.CI{TypeID: ci.typeID, PropsJSON: "{}"}
		row.ID = ci.id
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed ci %d: %v", ci.id, err)
		}
	}
	for _, mapping := range []struct {
		sourceModel string
		sourceCI    model.ID
		targetModel string
		targetCI    model.ID
	}{
		{"service", 1201, "business_service", 4001},
		{"service", 1202, "business_service", 4002},
		{"application", 1101, "application_service", 4101},
	} {
		row := cimodel.LayerMapping{
			Batch: "service-layers", SourceModel: mapping.sourceModel, SourceCIID: mapping.sourceCI,
			TargetModel: mapping.targetModel, TargetCIID: mapping.targetCI,
		}
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed mapping %+v: %v", mapping, err)
		}
	}
	for _, edge := range []struct{ first, second model.ID }{
		{1201, 1101}, // mapped and free to project
		{1202, 1101}, // second claimant of the same application
		{1203, 1101}, // the service has no business_service mapping
	} {
		row := cimodel.Relation{FirstCIID: edge.first, SecondCIID: edge.second, RelationTypeID: 50}
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed legacy edge %+v: %v", edge, err)
		}
	}

	repo := NewRepo(db)
	resolver := serviceLayerEdgeResolver{serviceLayerResolver{}.withSets()}
	uc := cibiz.NewUsecase(repo, resolver, nil).
		WithLayerMappings(repo).
		WithServiceLayerEdges(repo)
	ctx := context.Background()

	dry, err := uc.ApplyServiceEdges(ctx, cibiz.ServiceLayerEdgeApplyInput{DryRun: true})
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if len(dry.Created) != 1 || len(dry.Skipped) != 2 || len(dry.Existing) != 0 {
		t.Fatalf("dry report = %+v", dry)
	}
	if got := countContainsEdges(t, db); got != 0 {
		t.Fatalf("dry run wrote %d CONTAINS edges", got)
	}

	report, err := uc.ApplyServiceEdges(ctx, cibiz.ServiceLayerEdgeApplyInput{})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if len(report.Created) != 1 || len(report.Skipped) != 2 || len(report.Existing) != 0 {
		t.Fatalf("report = %+v", report)
	}
	if got := countContainsEdges(t, db); got != 1 {
		t.Fatalf("CONTAINS edges = %d, want 1", got)
	}
	var edge cimodel.Relation
	if err := db.Where("first_ci_id = ? AND second_ci_id = ? AND relation_type_id = ?", 4001, 4101, 51).
		First(&edge).Error; err != nil {
		t.Fatalf("CONTAINS edge: %v", err)
	}
	if edge.EvidenceSource != string(model.RelationEvidenceInference) {
		t.Fatalf("evidence_source = %q", edge.EvidenceSource)
	}
	reasons := map[model.ID]string{}
	for _, row := range report.Skipped {
		reasons[row.SourceCIID] = row.Reason
	}
	if !strings.Contains(reasons[1202], "already contained") {
		t.Fatalf("service 1202 reason = %q", reasons[1202])
	}
	if !strings.Contains(reasons[1203], "no business_service mapping") {
		t.Fatalf("service 1203 reason = %q", reasons[1203])
	}

	again, err := uc.ApplyServiceEdges(ctx, cibiz.ServiceLayerEdgeApplyInput{})
	if err != nil {
		t.Fatalf("second apply: %v", err)
	}
	if len(again.Created) != 0 || len(again.Existing) != 1 || len(again.Skipped) != 2 {
		t.Fatalf("second report = %+v, want an idempotent resume", again)
	}
	if got := countContainsEdges(t, db); got != 1 {
		t.Fatalf("second apply duplicated the edge: %d", got)
	}
}

type serviceLayerEdgeResolver struct {
	serviceLayerResolver
}

func (r serviceLayerEdgeResolver) RelationBetween(_ context.Context, parent, child model.ID) (cibiz.TypeRelationRule, bool, error) {
	if parent == 40 && child == 20 {
		return cibiz.TypeRelationRule{RelationTypeID: 51, Constraint: model.ConstraintOne2Many}, true, nil
	}
	return cibiz.TypeRelationRule{}, false, nil
}

func countContainsEdges(t *testing.T, db interface {
	Model(any) *gorm.DB
}) int64 {
	t.Helper()
	var n int64
	if err := db.Model(&cimodel.Relation{}).Where("relation_type_id = ?", 51).Count(&n).Error; err != nil {
		t.Fatal(err)
	}
	return n
}
