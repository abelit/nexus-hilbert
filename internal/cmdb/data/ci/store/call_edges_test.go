package store

import (
	"context"
	"math"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"

	cibiz "github.com/ongridio/ongrid/internal/cmdb/biz/ci"
	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
)

// The CALLS ingestion contract: explicit CI pairs, collector provenance,
// observation time, confidence and the call attributes. A re-observation
// refreshes the attributes and the observation; a pair that already carries a
// different relation is reported, never retyped.
func TestIngestCallEdgesValidatesAndRefreshes(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := db.AutoMigrate(&citypemodel.CIType{}); err != nil {
		t.Fatalf("migrate types: %v", err)
	}
	for id, name := range map[model.ID]string{20: "application_service", 10: "application"} {
		ct := citypemodel.CIType{Name: name, Alias: name, Enabled: true}
		ct.ID = id
		if err := db.Create(&ct).Error; err != nil {
			t.Fatalf("seed type %s: %v", name, err)
		}
	}
	for id, name := range map[model.ID]string{60: "CALLS", 61: "DEPENDS_ON"} {
		rt := citypemodel.RelationType{Name: name, Category: "dependency"}
		rt.ID = id
		if err := db.Create(&rt).Error; err != nil {
			t.Fatalf("seed relation type %s: %v", name, err)
		}
	}
	for _, ci := range []struct {
		id, typeID model.ID
	}{
		{5001, 20}, {5002, 20}, {5101, 10},
	} {
		row := cimodel.CI{TypeID: ci.typeID, PropsJSON: "{}"}
		row.ID = ci.id
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed ci %d: %v", ci.id, err)
		}
	}

	repo := NewRepo(db)
	resolver := callEdgeResolver{serviceLayerResolver{}.withSets()}
	uc := cibiz.NewUsecase(repo, resolver, nil)
	ctx := context.Background()
	observed := "2026-11-09T10:00:00Z"
	faithful := 0.95
	sync := true
	qps := 12.5
	p95 := 45.0
	good := cibiz.CallEdgeInput{
		SourceCIID: 5001, TargetCIID: 5002,
		Protocol: "http", Endpoint: "/weather", Method: "GET", Sync: &sync,
		QPS: &qps, LatencyP95Ms: &p95, ErrorRate: func() *float64 { v := 0.01; return &v }(),
		ObservedAt: observed, Confidence: &faithful,
	}
	badConfidence := 1.5
	invalid := []cibiz.CallEdgeInput{
		{SourceCIID: 5001, TargetCIID: 5001, ObservedAt: observed},
		{SourceCIID: 5001, TargetCIID: 9999, ObservedAt: observed},
		{SourceCIID: 5001, TargetCIID: 5101, ObservedAt: observed},
		{SourceCIID: 5001, TargetCIID: 5002, ObservedAt: observed, Confidence: &badConfidence},
		{SourceCIID: 5001, TargetCIID: 5002, ObservedAt: "not-a-time"},
	}

	dry, err := uc.IngestCallEdges(ctx, cibiz.CallEdgeIngestInput{
		DryRun: true, Edges: append([]cibiz.CallEdgeInput{good}, invalid...),
	})
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if len(dry.Created) != 1 || len(dry.Skipped) != 5 {
		t.Fatalf("dry report = %+v", dry)
	}
	if got := countRelationType(t, db, 60); got != 0 {
		t.Fatalf("dry run wrote %d CALLS edges", got)
	}

	// A pair a person already related must not be retyped by the collector.
	conflict := cimodel.Relation{FirstCIID: 5001, SecondCIID: 5002, RelationTypeID: 61}
	if err := db.Create(&conflict).Error; err != nil {
		t.Fatalf("seed conflict: %v", err)
	}
	blocked, err := uc.IngestCallEdges(ctx, cibiz.CallEdgeIngestInput{Edges: []cibiz.CallEdgeInput{good}})
	if err != nil {
		t.Fatalf("conflict ingest: %v", err)
	}
	if len(blocked.Skipped) != 1 || !strings.Contains(blocked.Skipped[0].Reason, "already carries relation type") {
		t.Fatalf("conflict report = %+v", blocked)
	}
	if err := db.Where("first_ci_id = ? AND second_ci_id = ?", 5001, 5002).Delete(&cimodel.Relation{}).Error; err != nil {
		t.Fatalf("remove conflict: %v", err)
	}

	report, err := uc.IngestCallEdges(ctx, cibiz.CallEdgeIngestInput{Edges: []cibiz.CallEdgeInput{good}})
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	if len(report.Created) != 1 || len(report.Existing) != 0 || len(report.Skipped) != 0 {
		t.Fatalf("report = %+v", report)
	}
	var edge cimodel.Relation
	if err := db.Where("first_ci_id = ? AND second_ci_id = ?", 5001, 5002).First(&edge).Error; err != nil {
		t.Fatalf("load edge: %v", err)
	}
	if edge.RelationTypeID != 60 || edge.EvidenceSource != "collector:apm" {
		t.Fatalf("edge = %+v", edge)
	}
	if edge.ObservedAt == nil || edge.ObservedAt.UTC().Format(time.RFC3339) != observed {
		t.Fatalf("observed_at = %v", edge.ObservedAt)
	}
	if edge.Confidence == nil || math.Abs(*edge.Confidence-faithful) > 0.001 {
		t.Fatalf("confidence = %v", edge.Confidence)
	}
	for _, want := range []string{`"protocol":"http"`, `"endpoint":"/weather"`, `"latency_p95":45`, `"sync":true`} {
		if edge.PropsJSON == nil || !strings.Contains(*edge.PropsJSON, want) {
			t.Fatalf("props = %v, want %s", edge.PropsJSON, want)
		}
	}

	// A re-observation refreshes the attributes, the time and the confidence.
	refreshedQPS := 20.0
	refreshedConfidence := 0.8
	refreshedAt := "2026-11-09T11:00:00Z"
	again, err := uc.IngestCallEdges(ctx, cibiz.CallEdgeIngestInput{Edges: []cibiz.CallEdgeInput{{
		SourceCIID: 5001, TargetCIID: 5002,
		Protocol: "http", Endpoint: "/weather", QPS: &refreshedQPS,
		ObservedAt: refreshedAt, Confidence: &refreshedConfidence,
	}}})
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if len(again.Existing) != 1 || len(again.Created) != 0 {
		t.Fatalf("refresh report = %+v", again)
	}
	var updated cimodel.Relation
	if err := db.Where("first_ci_id = ? AND second_ci_id = ?", 5001, 5002).First(&updated).Error; err != nil {
		t.Fatal(err)
	}
	if updated.ObservedAt == nil || updated.ObservedAt.UTC().Format(time.RFC3339) != refreshedAt {
		t.Fatalf("refreshed observed_at = %v", updated.ObservedAt)
	}
	if updated.Confidence == nil || math.Abs(*updated.Confidence-refreshedConfidence) > 0.001 {
		t.Fatalf("refreshed confidence = %v", updated.Confidence)
	}
	if updated.PropsJSON == nil || !strings.Contains(*updated.PropsJSON, `"qps":20`) {
		t.Fatalf("refreshed props = %v", updated.PropsJSON)
	}

	// The opposite direction is its own edge; the second pair needs no props.
	reverse := good
	reverse.SourceCIID, reverse.TargetCIID = 5002, 5001
	reverse.Protocol, reverse.Endpoint, reverse.Method = "", "", ""
	reverse.Sync, reverse.QPS, reverse.LatencyP95Ms, reverse.ErrorRate = nil, nil, nil, nil
	reverseReport, err := uc.IngestCallEdges(ctx, cibiz.CallEdgeIngestInput{Edges: []cibiz.CallEdgeInput{reverse}})
	if err != nil {
		t.Fatalf("reverse ingest: %v", err)
	}
	if len(reverseReport.Created) != 1 {
		t.Fatalf("reverse report = %+v", reverseReport)
	}
	if got := countRelationType(t, db, 60); got != 2 {
		t.Fatalf("CALLS edges = %d, want 2", got)
	}
}

type callEdgeResolver struct {
	serviceLayerResolver
}

func (r callEdgeResolver) RelationBetween(_ context.Context, first, second model.ID) (cibiz.TypeRelationRule, bool, error) {
	if first == 20 && second == 20 {
		return cibiz.TypeRelationRule{
			RelationTypeID: 60, RelationTypeName: "CALLS", Constraint: model.ConstraintMany2Many,
		}, true, nil
	}
	return cibiz.TypeRelationRule{}, false, nil
}

func countRelationType(t *testing.T, db interface {
	Model(any) *gorm.DB
}, relationTypeID model.ID) int64 {
	t.Helper()
	var n int64
	if err := db.Model(&cimodel.Relation{}).Where("relation_type_id = ?", relationTypeID).Count(&n).Error; err != nil {
		t.Fatal(err)
	}
	return n
}
