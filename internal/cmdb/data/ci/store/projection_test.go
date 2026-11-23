package store

import (
	"context"
	"testing"

	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
)

func TestPlanOntologyProjection(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate CI: %v", err)
	}
	if err := db.AutoMigrate(&citypemodel.CIType{}, &citypemodel.CITypeRelation{}); err != nil {
		t.Fatalf("migrate model tables: %v", err)
	}

	room := citypemodel.CIType{Name: "room", Alias: "room", UniqueID: 1, Enabled: true}
	rack := citypemodel.CIType{Name: "rack", Alias: "rack", UniqueID: 2, Enabled: true}
	if err := db.Create(&room).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&rack).Error; err != nil {
		t.Fatal(err)
	}

	contains := citypemodel.RelationType{
		Name: "CONTAINS", Color: "#1890ff", Category: "structure",
		TopocortexCategory: "association", Direction: "src_to_dst",
		Traits:     citypemodel.StringList{"structural_rollup"},
		InverseOf:  "PART_OF",
		Transitive: true, Revision: 1,
	}
	if err := db.Create(&contains).Error; err != nil {
		t.Fatal(err)
	}
	constraint := "0"
	if err := db.Create(&citypemodel.CITypeRelation{
		ParentID: room.ID, ChildID: rack.ID, RelationTypeID: contains.ID,
		Constraint: &constraint,
	}).Error; err != nil {
		t.Fatal(err)
	}

	roomCI := cimodel.CI{TypeID: room.ID, PropsJSON: ""}
	rackOne := cimodel.CI{TypeID: rack.ID, PropsJSON: ""}
	rackTwo := cimodel.CI{TypeID: rack.ID, PropsJSON: ""}
	for _, ci := range []*cimodel.CI{&roomCI, &rackOne, &rackTwo} {
		if err := db.Create(ci).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, rackCI := range []*cimodel.CI{&rackOne, &rackTwo} {
		if err := db.Create(&cimodel.Relation{
			FirstCIID: roomCI.ID, SecondCIID: rackCI.ID, RelationTypeID: contains.ID,
		}).Error; err != nil {
			t.Fatal(err)
		}
	}

	report, err := PlanOntologyProjection(context.Background(), db)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if report.Rules != 1 || report.Edges != 2 || report.ResolvedRules != 1 ||
		report.ResolvedEdges != 2 || report.InvertedRules != 1 || report.InvertedEdges != 2 ||
		report.Blocked {
		t.Fatalf("report = %+v", report)
	}
	m := report.Mappings[0]
	if m.SourceType != "CONTAINS" || m.TargetType != "PART_OF" || !m.Invert ||
		m.Cardinality != "N:1" || !m.Transitive || m.Sample != "rack -PART_OF-> room" {
		t.Fatalf("mapping = %+v", m)
	}
	if len(report.Samples) != 1 || report.Samples[0] != "rack -PART_OF-> room" {
		t.Fatalf("samples = %v", report.Samples)
	}
}
