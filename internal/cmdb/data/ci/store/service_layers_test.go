package store

import (
	"context"
	"strings"
	"testing"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
	"github.com/ongridio/ongrid/internal/cmdb/model/value"
)

// The service-layer planner is read-only: it maps the conventional source
// models to the three layers and reports the review queue.
func TestPlanServiceLayersClassifiesAndReviews(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := db.AutoMigrate(&citypemodel.CIType{}); err != nil {
		t.Fatalf("migrate types: %v", err)
	}

	typeSeed := []struct {
		id, unique, show model.ID
		name             string
	}{
		{10, 1, 2, "application"},
		{11, 3, 4, "app_instance"},
		{12, 5, 6, "service"},
		{20, 0, 0, "business_service"},
		{21, 0, 0, "application_service"},
		{22, 0, 0, "service_instance"},
	}
	for _, seed := range typeSeed {
		ct := citypemodel.CIType{Name: seed.name, Alias: seed.name, UniqueID: seed.unique, Enabled: true}
		ct.ID = seed.id
		if seed.show != 0 {
			show := seed.show
			ct.ShowID = &show
		}
		if err := db.Create(&ct).Error; err != nil {
			t.Fatalf("seed type %s: %v", seed.name, err)
		}
	}

	cis := []struct {
		id, typeID model.ID
	}{
		{1001, 10}, {1002, 10}, {1003, 10},
		{1101, 11},
		{1201, 12}, {1202, 12},
	}
	for _, ci := range cis {
		row := cimodel.CI{TypeID: ci.typeID, PropsJSON: "{}"}
		row.ID = ci.id
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed ci %d: %v", ci.id, err)
		}
	}

	values := []struct {
		ciID, attrID model.ID
		text         string
	}{
		{1001, 1, "app-a"}, {1001, 2, "App A"},
		{1002, 1, "app-a"}, {1002, 2, "App A2"},
		{1003, 2, "App A3"},
		{1101, 3, "inst-a"}, {1101, 4, "Instance A"},
		{1201, 5, "svc-a"}, {1201, 6, "Service A"},
		{1202, 5, "svc-b"}, {1202, 6, "Service B"},
	}
	for _, v := range values {
		row := value.ValueIndexText{CIID: v.ciID, AttrID: v.attrID, Value: v.text}
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed value %v: %v", v, err)
		}
	}

	plan, err := PlanServiceLayers(context.Background(), db)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if len(plan.MissingTargets) != 0 || len(plan.MissingSources) != 0 {
		t.Fatalf("unexpected missing sets: %+v / %+v", plan.MissingTargets, plan.MissingSources)
	}
	if plan.TotalInstances != 6 || plan.Confident != 1 || plan.ReviewCount != 5 {
		t.Fatalf("totals = %d/%d/%d, want 6/1/5", plan.TotalInstances, plan.Confident, plan.ReviewCount)
	}
	rows := map[string]ServiceLayerPlanRow{}
	for _, row := range plan.Rows {
		rows[row.SourceModel] = row
	}
	if rows["application"].Instances != 3 || rows["application"].Confident != 0 || rows["application"].Review != 3 {
		t.Fatalf("application row = %+v", rows["application"])
	}
	if rows["app_instance"].Instances != 1 || rows["app_instance"].Confident != 1 {
		t.Fatalf("app_instance row = %+v", rows["app_instance"])
	}
	if rows["service"].Instances != 2 || rows["service"].Review != 2 ||
		!strings.Contains(rows["service"].Reason, "business") {
		t.Fatalf("service row = %+v", rows["service"])
	}

	reasons := map[model.ID]string{}
	for _, review := range plan.Review {
		reasons[review.CIID] = review.Reason
	}
	if !strings.Contains(reasons[1002], "duplicate") {
		t.Fatalf("duplicate reason = %q", reasons[1002])
	}
	if !strings.Contains(reasons[1003], "missing") {
		t.Fatalf("missing reason = %q", reasons[1003])
	}
	if !strings.Contains(reasons[1201], "business") || !strings.Contains(reasons[1202], "business") {
		t.Fatalf("service review reasons = %+v", reasons)
	}
}

func TestPlanServiceLayersReportsMissingTargets(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := db.AutoMigrate(&citypemodel.CIType{}); err != nil {
		t.Fatalf("migrate types: %v", err)
	}
	ct := citypemodel.CIType{Name: "application", Alias: "application", UniqueID: 1, Enabled: true}
	ct.ID = 10
	if err := db.Create(&ct).Error; err != nil {
		t.Fatal(err)
	}

	plan, err := PlanServiceLayers(context.Background(), db)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if len(plan.MissingTargets) != 3 {
		t.Fatalf("missing targets = %v, want all three", plan.MissingTargets)
	}
	if len(plan.MissingSources) != 2 {
		t.Fatalf("missing sources = %v, want app_instance and service", plan.MissingSources)
	}
}

func TestPlanServiceLayersRejectsNilDB(t *testing.T) {
	if _, err := PlanServiceLayers(context.Background(), nil); err == nil {
		t.Fatal("PlanServiceLayers(nil) = nil error, want error")
	}
}
