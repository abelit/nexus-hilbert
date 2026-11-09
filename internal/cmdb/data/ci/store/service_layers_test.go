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
	if err := db.AutoMigrate(&citypemodel.CIType{}, &citypemodel.Attribute{}); err != nil {
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
	if !strings.Contains(reasons[1201], "asset_use_type") ||
		!strings.Contains(reasons[1202], "asset_use_type") {
		t.Fatalf("service review reasons = %+v", reasons)
	}
}

// The planner recommends the business layer only when every conservative gate
// passes, and keeps ledger entries, service connections, test environments and
// missing governance anchors in the review queue.
func TestPlanServiceLayersRecommendsBusinessServices(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := db.AutoMigrate(&citypemodel.CIType{}, &citypemodel.Attribute{}); err != nil {
		t.Fatalf("migrate types: %v", err)
	}

	typeSeed := []struct {
		id, unique, show model.ID
		name             string
	}{
		{30, 1, 2, "service"},
		{31, 5, 6, "application"},
		{32, 7, 8, "app_instance"},
		{40, 0, 0, "business_service"},
		{41, 0, 0, "application_service"},
		{42, 0, 0, "service_instance"},
		{43, 0, 0, "product"},
		{44, 0, 0, "sla"},
		{45, 0, 0, "members"},
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
	for id, spec := range map[model.ID]struct{ name, category string }{
		50: {"DEPENDS_ON", "dependency"},
		51: {"HAS_BELONGING", "structure"},
		52: {"CONNECTS_TO", "dependency"},
		53: {"COVERS", "ownership"},
		54: {"manage", "ownership"},
	} {
		rt := citypemodel.RelationType{Name: spec.name, Category: spec.category}
		rt.ID = id
		if err := db.Create(&rt).Error; err != nil {
			t.Fatalf("seed relation type %s: %v", spec.name, err)
		}
	}
	for id, name := range map[model.ID]string{
		60: "asset_use_type", 61: "environment", 62: "level",
	} {
		attr := citypemodel.Attribute{Name: name}
		attr.ID = id
		if err := db.Create(&attr).Error; err != nil {
			t.Fatalf("seed attribute %s: %v", name, err)
		}
	}

	for _, ci := range []struct {
		id, typeID model.ID
	}{
		{3001, 30}, {3002, 30}, {3003, 30}, {3004, 30},
		{3101, 31}, {4301, 43}, {4401, 44}, {4501, 45},
	} {
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
		{3001, 1, "svc-a"}, {3001, 2, "Service A"},
		{3002, 1, "svc-b"}, {3002, 2, "Service B"},
		{3003, 1, "svc-c"}, {3003, 2, "Service C"},
		{3004, 1, "svc-d"}, {3004, 2, "Service D"},
		{3101, 5, "app-a"}, {3101, 6, "App A"},
	}
	for _, id := range []model.ID{3001, 3002, 3003, 3004} {
		values = append(values,
			struct {
				ciID, attrID model.ID
				text         string
			}{id, 60, "business"},
			struct {
				ciID, attrID model.ID
				text         string
			}{id, 61, "prod"},
			struct {
				ciID, attrID model.ID
				text         string
			}{id, 62, "important"},
		)
	}
	for _, v := range values {
		row := value.ValueIndexText{CIID: v.ciID, AttrID: v.attrID, Value: v.text}
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed value %v: %v", v, err)
		}
	}
	for _, rel := range []struct {
		first, second, typeID model.ID
	}{
		{3001, 3101, 50}, // service 3001 has one application implementation
		{4301, 3001, 51}, // and all three governance anchors
		{4401, 3001, 53},
		{4501, 3001, 54},
		{3002, 3101, 50}, // service 3002 has an application target and product
		{4301, 3002, 51}, // but no SLA or member anchor
		{3003, 3004, 52}, // service 3003 connects to service 3004
	} {
		row := cimodel.Relation{FirstCIID: rel.first, SecondCIID: rel.second, RelationTypeID: rel.typeID}
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed relation %v: %v", rel, err)
		}
	}

	plan, err := PlanServiceLayers(context.Background(), db)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.TotalInstances != 5 || plan.Confident != 1 || plan.ReviewCount != 4 || plan.Recommended != 1 {
		t.Fatalf("totals = total %d/confident %d/review %d/recommended %d, want 5/1/4/1",
			plan.TotalInstances, plan.Confident, plan.ReviewCount, plan.Recommended)
	}
	if len(plan.Recommendations) != 1 || plan.Recommendations[0].CIID != 3001 ||
		plan.Recommendations[0].TargetModel != "business_service" {
		t.Fatalf("recommendations = %+v", plan.Recommendations)
	}
	reasons := map[model.ID]string{}
	for _, review := range plan.Review {
		reasons[review.CIID] = review.Reason
	}
	if !strings.Contains(reasons[3002], "SLA COVERS") || !strings.Contains(reasons[3002], "members manage") {
		t.Fatalf("service 3002 review reason = %q", reasons[3002])
	}
	if !strings.Contains(reasons[3003], "CONNECTS_TO") || !strings.Contains(reasons[3004], "CONNECTS_TO") {
		t.Fatalf("service connection reasons = %q / %q", reasons[3003], reasons[3004])
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
