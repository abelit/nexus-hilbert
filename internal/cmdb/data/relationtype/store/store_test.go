package store

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

func newTestRepo(t *testing.T) (*Repo, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(testDSN(t)), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(
		&citypemodel.RelationType{},
		&citypemodel.CITypeRelation{},
		&cimodel.Relation{},
		&cimodel.RelationHistory{},
	); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return NewRepo(db), db
}

// Usage is the delete guard's read model: live model rules and live instance
// edges block deletion; history rows are reported but do not block, because
// they are audit evidence rather than live references.
func TestUsageCountsLiveReferences(t *testing.T) {
	repo, db := newTestRepo(t)
	ctx := context.Background()
	rt := &citypemodel.RelationType{Name: "MANAGES"}
	if err := repo.Create(ctx, rt); err != nil {
		t.Fatal(err)
	}

	rule := citypemodel.CITypeRelation{ParentID: 1, ChildID: 2, RelationTypeID: rt.ID}
	edge := cimodel.Relation{FirstCIID: 1, SecondCIID: 2, RelationTypeID: rt.ID}
	history := cimodel.RelationHistory{RelationID: 1, RelationTypeID: &rt.ID}
	for _, row := range []any{&rule, &edge, &history} {
		if err := db.Create(row).Error; err != nil {
			t.Fatalf("seed usage row: %v", err)
		}
	}
	usage, err := repo.Usage(ctx, rt.ID)
	if err != nil {
		t.Fatalf("Usage() error = %v", err)
	}
	if usage.ModelRules != 1 || usage.InstanceEdges != 1 || usage.HistoryRows != 1 {
		t.Fatalf("usage = %+v", usage)
	}

	// Soft-deleted rules/edges are not live references.
	if err := db.Delete(&rule).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Delete(&edge).Error; err != nil {
		t.Fatal(err)
	}
	usage, err = repo.Usage(ctx, rt.ID)
	if err != nil {
		t.Fatalf("Usage() after delete error = %v", err)
	}
	if usage.ModelRules != 0 || usage.InstanceEdges != 0 || usage.HistoryRows != 1 {
		t.Fatalf("usage after soft delete = %+v", usage)
	}
}

// The default colour is a database default in cantor, so it must survive a
// write that does not set it explicitly.
func TestCreateAppliesDatabaseDefaultColour(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	rt := &citypemodel.RelationType{Name: "runs_on"}
	if err := repo.Create(ctx, rt); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if rt.ID == 0 {
		t.Fatal("Create() did not fill in the assigned id")
	}

	got, err := repo.Get(ctx, rt.ID)
	if err != nil || got == nil {
		t.Fatalf("Get() = %+v, %v", got, err)
	}
	if got.Color != citypemodelDefaultColor {
		t.Fatalf("color = %q, want the database default %q", got.Color, citypemodelDefaultColor)
	}
}

// The default must match cantor's server_default exactly, otherwise a row
// created here and a row created by cantor would render differently.
const citypemodelDefaultColor = "#1890ff"

func TestCreateAndUpdateAliases(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	rt := &citypemodel.RelationType{Name: "runs_on", Aliases: citypemodel.StringList{"run_on"}}
	if err := repo.Create(ctx, rt); err != nil {
		t.Fatal(err)
	}
	got, err := repo.Get(ctx, rt.ID)
	if err != nil || got == nil {
		t.Fatalf("Get() = %+v, %v", got, err)
	}
	if len(got.Aliases) != 1 || got.Aliases[0] != "run_on" {
		t.Fatalf("aliases = %v", got.Aliases)
	}

	got.Aliases = citypemodel.StringList{"running", "executes_on"}
	if err := repo.Update(ctx, got); err != nil {
		t.Fatal(err)
	}
	got, err = repo.Get(ctx, rt.ID)
	if err != nil || got == nil {
		t.Fatalf("Get() after update = %+v, %v", got, err)
	}
	if len(got.Aliases) != 2 || got.Aliases[0] != "running" || got.Aliases[1] != "executes_on" {
		t.Fatalf("aliases after update = %v", got.Aliases)
	}

	got.Aliases = nil
	if err := repo.Update(ctx, got); err != nil {
		t.Fatal(err)
	}
	got, err = repo.Get(ctx, rt.ID)
	if err != nil || got == nil {
		t.Fatalf("Get() after clear = %+v, %v", got, err)
	}
	if len(got.Aliases) != 0 {
		t.Fatalf("aliases after clear = %v", got.Aliases)
	}
}

func TestListOrdersByID(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	for _, name := range []string{"c_third", "a_first", "b_second"} {
		if err := repo.Create(ctx, &citypemodel.RelationType{Name: name}); err != nil {
			t.Fatal(err)
		}
	}

	got, err := repo.List(ctx)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("List() = %d rows, want 3", len(got))
	}
	// Ordered by id (insertion order), NOT by name — the dictionary is stable
	// in creation order, matching cantor.
	if got[0].Name != "c_third" || got[1].Name != "a_first" || got[2].Name != "b_second" {
		t.Fatalf("List() order = %s,%s,%s; want insertion order",
			got[0].Name, got[1].Name, got[2].Name)
	}
}

func TestGetMissingReturnsNilNotError(t *testing.T) {
	repo, _ := newTestRepo(t)

	got, err := repo.Get(context.Background(), 999)
	if err != nil {
		t.Fatalf("Get() error = %v, want nil for a missing row", err)
	}
	if got != nil {
		t.Fatalf("Get() = %+v, want nil", got)
	}
}

// A soft-deleted row must vanish from List, Get and FindByName — otherwise a
// deleted dictionary entry would still be offered to the UI.
func TestSoftDeleteHidesTheRowEverywhere(t *testing.T) {
	repo, db := newTestRepo(t)
	ctx := context.Background()

	rt := &citypemodel.RelationType{Name: "runs_on"}
	if err := repo.Create(ctx, rt); err != nil {
		t.Fatal(err)
	}
	if err := repo.SoftDelete(ctx, rt.ID); err != nil {
		t.Fatalf("SoftDelete() error = %v", err)
	}

	if rows, err := repo.List(ctx); err != nil || len(rows) != 0 {
		t.Fatalf("List() after delete = %+v, %v; want empty", rows, err)
	}
	if got, err := repo.Get(ctx, rt.ID); err != nil || got != nil {
		t.Fatalf("Get() after delete = %+v, %v; want nil", got, err)
	}
	if got, err := repo.FindByName(ctx, "runs_on"); err != nil || got != nil {
		t.Fatalf("FindByName() after delete = %+v, %v; want nil (the name is free again)", got, err)
	}

	// The row itself must still exist unscoped: CMDB soft-deletes, and an audit
	// trail that referenced the dictionary entry must not dangle.
	var unscoped int64
	if err := db.Unscoped().Model(&citypemodel.RelationType{}).Count(&unscoped).Error; err != nil {
		t.Fatal(err)
	}
	if unscoped != 1 {
		t.Fatalf("unscoped rows = %d, want 1 (soft delete, not hard)", unscoped)
	}
}

// A name freed by a soft delete can be reused, which is what makes the
// dictionary operable after a rename-away-and-back.
func TestNameIsReusableAfterDelete(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	first := &citypemodel.RelationType{Name: "runs_on"}
	if err := repo.Create(ctx, first); err != nil {
		t.Fatal(err)
	}
	if err := repo.SoftDelete(ctx, first.ID); err != nil {
		t.Fatal(err)
	}
	second := &citypemodel.RelationType{Name: "runs_on"}
	if err := repo.Create(ctx, second); err != nil {
		t.Fatalf("reusing a freed name: %v", err)
	}
	if second.ID == first.ID {
		t.Fatal("reuse produced the same id as the deleted row")
	}
}

func TestFindByNameIsExact(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	if err := repo.Create(ctx, &citypemodel.RelationType{Name: "runs_on"}); err != nil {
		t.Fatal(err)
	}
	if got, err := repo.FindByName(ctx, "runs"); err != nil || got != nil {
		t.Fatalf("FindByName(prefix) = %+v, %v; want nil (exact match only)", got, err)
	}
	if got, err := repo.FindByName(ctx, "RUNS_ON"); err != nil || got != nil {
		t.Fatalf("FindByName(uppercase) = %+v, %v; want nil (case-sensitive, matching cantor)", got, err)
	}
	if got, err := repo.FindByName(ctx, "runs_on"); err != nil || got == nil {
		t.Fatalf("FindByName(exact) = %+v, %v; want the row", got, err)
	}
}

func TestUpdateWritesNameAndColour(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	rt := &citypemodel.RelationType{Name: "runs_on", Color: "#1890ff"}
	if err := repo.Create(ctx, rt); err != nil {
		t.Fatal(err)
	}
	rt.Name = "hosted_on"
	rt.Color = "#ff0000"
	if err := repo.Update(ctx, rt); err != nil {
		t.Fatalf("Update() error = %v", err)
	}

	got, err := repo.Get(ctx, rt.ID)
	if err != nil || got == nil {
		t.Fatalf("Get() = %+v, %v", got, err)
	}
	if got.Name != "hosted_on" || got.Color != "#ff0000" {
		t.Fatalf("row = %+v, want the updated name and colour", got)
	}
}

func TestUpdateWritesPresentationFields(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	rt := &citypemodel.RelationType{Name: "RUNS_ON"}
	if err := repo.Create(ctx, rt); err != nil {
		t.Fatal(err)
	}
	rt.DisplayNameZH = "运行于"
	rt.DisplayNameEN = "Runs on"
	rt.Description = "工作负载运行在宿主上。"
	if err := repo.Update(ctx, rt); err != nil {
		t.Fatalf("Update() error = %v", err)
	}

	got, err := repo.Get(ctx, rt.ID)
	if err != nil || got == nil {
		t.Fatalf("Get() = %+v, %v", got, err)
	}
	if got.DisplayNameZH != "运行于" || got.DisplayNameEN != "Runs on" ||
		got.Description != "工作负载运行在宿主上。" {
		t.Fatalf("presentation = %+v, want it written to the row", got)
	}

	// Empty values clear the row: the API replaces the whole writable set.
	rt.DisplayNameZH, rt.DisplayNameEN, rt.Description = "", "", ""
	if err := repo.Update(ctx, rt); err != nil {
		t.Fatalf("clear presentation error = %v", err)
	}
	got, err = repo.Get(ctx, rt.ID)
	if err != nil || got == nil {
		t.Fatalf("Get() after clear = %+v, %v", got, err)
	}
	if got.DisplayNameZH != "" || got.DisplayNameEN != "" || got.Description != "" {
		t.Fatalf("presentation after clear = %+v", got)
	}
}

// The semantic mirror is owned by nexus-topocortex. A CMDB update must change
// only the local name/colour, even if the caller loaded a row, mutated a
// semantic field in memory, and wrote it back.
func TestUpdateDoesNotWriteSemanticMirror(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	rt := &citypemodel.RelationType{
		Name: "CALLS", Color: "#1890ff",
		Category: "dependency", Direction: "src_to_dst",
		PropagatesDefault: true, WeightDefault: 0.8, Revision: 3,
		DisplayNameZH: "调用",
	}
	if err := repo.Create(ctx, rt); err != nil {
		t.Fatal(err)
	}

	rt.Name = "CALLS_V2"
	rt.Color = "#ff0000"
	rt.Category = "association"
	rt.Direction = "bidirectional"
	rt.WeightDefault = 0.1
	if err := repo.Update(ctx, rt); err != nil {
		t.Fatalf("Update() error = %v", err)
	}

	got, err := repo.Get(ctx, rt.ID)
	if err != nil || got == nil {
		t.Fatalf("Get() = %+v, %v", got, err)
	}
	if got.Name != "CALLS_V2" || got.Color != "#ff0000" {
		t.Fatalf("local fields = %+v, want the updated name and colour", got)
	}
	if got.Category != "dependency" || got.Direction != "src_to_dst" ||
		!got.PropagatesDefault || got.WeightDefault != 0.8 || got.Revision != 3 {
		t.Fatalf("semantic mirror was overwritten by a local update: %+v", got)
	}
}

// A repository miss must surface as errs.ErrNotFound, not as GORM's own
// sentinel: the data layer is where storage vocabulary stops.
func TestUpdateAndDeleteMissingReturnErrsNotFound(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	if err := repo.Update(ctx, &citypemodel.RelationType{Name: "ghost"}); !errors.Is(err, errs.ErrNotFound) {
		t.Fatalf("Update() missing row error = %v, want errs.ErrNotFound", err)
	}
	// A row with a real id but which has since been deleted.
	rt := &citypemodel.RelationType{Name: "runs_on"}
	if err := repo.Create(ctx, rt); err != nil {
		t.Fatal(err)
	}
	if err := repo.SoftDelete(ctx, rt.ID); err != nil {
		t.Fatal(err)
	}
	if err := repo.SoftDelete(ctx, rt.ID); !errors.Is(err, errs.ErrNotFound) {
		t.Fatalf("second SoftDelete() error = %v, want errs.ErrNotFound", err)
	}
}

func TestCreateRejectsNilRow(t *testing.T) {
	repo, _ := newTestRepo(t)

	if err := repo.Create(context.Background(), nil); err == nil {
		t.Fatal("Create(nil) = nil error, want error")
	}
}

// testDSN names an in-memory database that EVERY connection in this test
// shares.
//
// A BARE `:memory:` IS NOT ENOUGH, and the difference is not academic. With
// `:memory:` each CONNECTION gets its own private, empty database, and
// database/sql may open a second connection at any moment — for instance while
// a transaction holds the first one. A test that then asserts "nothing was
// written" reads through whichever connection it is handed and can pass because
// it is looking at an empty database rather than because the write was rolled
// back. Measured on glebarez/sqlite: a CREATE on one connection followed by a
// read from inside a transaction reported "no such table: probe", and the pool
// had grown from one connection to two.
//
// The unique name keeps this test's database to itself, so tests cannot bleed
// into each other through a shared cache. It is dropped when the last
// connection closes.
func testDSN(t *testing.T) string {
	t.Helper()
	name := strings.NewReplacer("/", "_", " ", "_", "?", "_", "#", "_").Replace(t.Name())
	return "file:cmdb-" + name + "?mode=memory&cache=shared"
}
