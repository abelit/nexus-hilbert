package store

import (
	"context"
	"testing"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
)

// The Phase 2 cleanup is an explicit operator action: dry-run counts, a real
// run soft-deletes, and a second run finds nothing. The categories are
// non-overlapping — a self-loop is not also counted as an orphan — so the
// report's total is the number of rows the run would touch.
func TestCleanupRelationsDryRunThenSoftDeletesNoise(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := db.AutoMigrate(&citypemodel.CIType{}, &citypemodel.CITypeRelation{}); err != nil {
		t.Fatalf("migrate dictionary: %v", err)
	}

	host := citypemodel.CIType{Name: "host", Alias: "host", UniqueID: 1, Enabled: true}
	host.ID = 1
	database := citypemodel.CIType{Name: "db", Alias: "db", UniqueID: 2, Enabled: true}
	database.ID = 2
	if err := db.Create(&host).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&database).Error; err != nil {
		t.Fatal(err)
	}
	constraint := "2"
	if err := db.Create(&citypemodel.CITypeRelation{
		ParentID: host.ID, ChildID: database.ID, RelationTypeID: 10, Constraint: &constraint,
	}).Error; err != nil {
		t.Fatal(err)
	}

	for id, typeID := range map[model.ID]model.ID{
		1: 1, 2: 1, 3: 2, 4: 2, 5: 1, 6: 1, 7: 2,
	} {
		ci := cimodel.CI{TypeID: typeID, PropsJSON: "{}"}
		ci.ID = id
		if err := db.Create(&ci).Error; err != nil {
			t.Fatalf("seed ci %d: %v", id, err)
		}
	}

	edges := []cimodel.Relation{
		{FirstCIID: 1, SecondCIID: 1, RelationTypeID: 10}, // self-loop; also has no rule
		{FirstCIID: 2, SecondCIID: 3, RelationTypeID: 10}, // valid
		{FirstCIID: 4, SecondCIID: 5, RelationTypeID: 10}, // orphan: db -> host has no rule
		{FirstCIID: 6, SecondCIID: 7, RelationTypeID: 10}, // valid
		{FirstCIID: 6, SecondCIID: 7, RelationTypeID: 10}, // duplicate of the row above
	}
	for i := range edges {
		if err := db.Create(&edges[i]).Error; err != nil {
			t.Fatalf("seed edge %d: %v", i, err)
		}
	}

	ctx := context.Background()
	dry, err := CleanupRelations(ctx, db, true)
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if !dry.DryRun || dry.SelfLoops != 1 || dry.OrphanEdges != 1 || dry.DuplicateEdges != 1 || dry.Total != 3 {
		t.Fatalf("dry report = %+v, want self=1 orphan=1 duplicate=1 total=3", dry)
	}
	var live int64
	if err := db.Model(&cimodel.Relation{}).Count(&live).Error; err != nil {
		t.Fatal(err)
	}
	if live != 5 {
		t.Fatalf("dry run changed the table: %d live rows, want 5", live)
	}

	report, err := CleanupRelations(ctx, db, false)
	if err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if report.Total != 3 || report.SelfLoops != 1 || report.OrphanEdges != 1 || report.DuplicateEdges != 1 {
		t.Fatalf("report = %+v, want self=1 orphan=1 duplicate=1 total=3", report)
	}

	var remaining []cimodel.Relation
	if err := db.Order("id").Find(&remaining).Error; err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 2 {
		t.Fatalf("remaining = %+v, want the valid edge and one duplicate survivor", remaining)
	}
	if remaining[0].FirstCIID != 2 || remaining[1].FirstCIID != 6 {
		t.Fatalf("remaining = %+v, want edges 2->3 and 6->7", remaining)
	}

	var deleted int64
	if err := db.Unscoped().Model(&cimodel.Relation{}).Where("delete_marker <> 0").Count(&deleted).Error; err != nil {
		t.Fatal(err)
	}
	if deleted != 3 {
		t.Fatalf("soft-deleted rows = %d, want 3", deleted)
	}

	again, err := CleanupRelations(ctx, db, false)
	if err != nil {
		t.Fatalf("second cleanup: %v", err)
	}
	if again.Total != 0 {
		t.Fatalf("second cleanup = %+v, want an idempotent no-op", again)
	}
}
