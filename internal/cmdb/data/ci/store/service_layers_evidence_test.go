package store

import (
	"context"
	"testing"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
	"github.com/ongridio/ongrid/internal/cmdb/model/value"
)

// The service classification reads live relation and attribute evidence, not
// names: distinct application targets, the three governance anchors,
// directional service connections, and the three gate attributes.
func TestServiceLayerEvidenceCountsRelations(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := db.AutoMigrate(&citypemodel.CIType{}, &citypemodel.Attribute{}); err != nil {
		t.Fatalf("migrate types: %v", err)
	}
	for id, name := range map[model.ID]string{
		30: "service", 31: "application", 32: "product", 33: "sla", 34: "members",
	} {
		ct := citypemodel.CIType{Name: name, Alias: name, Enabled: true}
		ct.ID = id
		if err := db.Create(&ct).Error; err != nil {
			t.Fatalf("seed type %s: %v", name, err)
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
		{3101, 31}, {3102, 31}, {3201, 32}, {3301, 33}, {3401, 34},
	} {
		row := cimodel.CI{TypeID: ci.typeID, PropsJSON: "{}"}
		row.ID = ci.id
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed ci %d: %v", ci.id, err)
		}
	}
	for _, v := range []struct {
		ciID, attrID model.ID
		text         string
	}{
		{3001, 60, "business"}, {3001, 61, "prod"}, {3001, 62, "important"},
	} {
		row := value.ValueIndexText{CIID: v.ciID, AttrID: v.attrID, Value: v.text}
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed value %v: %v", v, err)
		}
	}

	for _, rel := range []struct {
		first, second, typeID model.ID
	}{
		{3001, 3101, 50}, // service depends on application one
		{3001, 3102, 50}, // and application two; the count is distinct targets
		{3201, 3002, 51}, // product contains the service
		{3301, 3002, 53}, // SLA covers the service
		{3401, 3002, 54}, // members manage the service
		{3003, 3004, 52}, // service connects to a service
	} {
		row := cimodel.Relation{FirstCIID: rel.first, SecondCIID: rel.second, RelationTypeID: rel.typeID}
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed relation %v: %v", rel, err)
		}
	}

	evidence, err := NewRepo(db).ServiceLayerEvidence(context.Background(), 30)
	if err != nil {
		t.Fatalf("evidence: %v", err)
	}
	if ev := evidence[3001]; ev.ApplicationTargets != 2 ||
		ev.AssetUseType != "business" || ev.Environment != "prod" || ev.Level != "important" {
		t.Fatalf("service 3001 = %+v", ev)
	}
	if ev := evidence[3002]; ev.BelongsToProduct != 1 || ev.CoveredBySLA != 1 || ev.ManagedByMembers != 1 {
		t.Fatalf("service 3002 anchors = %+v", ev)
	}
	if ev := evidence[3003]; ev.ConnectsToOutbound != 1 || ev.ConnectsToInbound != 0 {
		t.Fatalf("service 3003 connections = %+v", ev)
	}
	if ev := evidence[3004]; ev.ConnectsToOutbound != 0 || ev.ConnectsToInbound != 1 {
		t.Fatalf("service 3004 connections = %+v", ev)
	}
	if _, ok := evidence[3101]; ok {
		t.Fatalf("the application end was reported as a source: %+v", evidence)
	}
}
