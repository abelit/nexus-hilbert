package store

import (
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
)

func newTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(testDSN(t)), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	return db
}

func TestMigrateCreatesTheModelDefinitionTables(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	want := []string{
		"c_relation_types",
		"c_ci_type_groups", "c_ci_type_group_items",
		"c_ci_types", "c_ci_type_inheritance", "c_ci_type_relations",
		"c_attributes", "c_ci_type_attributes",
		"c_ci_type_attribute_groups", "c_ci_type_attribute_group_items",
		"c_c_t_u_c", "c_c_t_t",
	}
	for _, table := range want {
		if !db.Migrator().HasTable(table) {
			t.Errorf("table %s was not created", table)
		}
	}
}

func TestMigrateRejectsNilDB(t *testing.T) {
	if err := Migrate(nil); err == nil {
		t.Fatal("Migrate(nil) = nil error, want error")
	}
}

// The relation-type dictionary is the smallest entity and the natural first
// vertical slice, so its defaults must match cantor's exactly: a 7-character
// colour and the #1890ff fallback.
func TestRelationTypeDefaults(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	rt := citypemodel.RelationType{Name: "runs_on"}
	if err := db.Create(&rt).Error; err != nil {
		t.Fatalf("create relation type: %v", err)
	}
	var got citypemodel.RelationType
	if err := db.First(&got, rt.ID).Error; err != nil {
		t.Fatalf("read relation type: %v", err)
	}
	if got.Color != "#1890ff" {
		t.Fatalf("default colour = %q, want #1890ff", got.Color)
	}
}

// The relation-type dictionary gains the semantic fields nexus-topocortex
// already models. CMDB mirrors them read-only; the columns still have to exist
// before a sync can write them.
func TestRelationTypeCarriesSemanticMirrorColumns(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	want := []string{
		"category", "direction", "propagates_default", "weight_default",
		"inverse_of", "transitive", "sub_property_of",
		"display_name_zh", "display_name_en", "description",
		"deprecated", "replacement", "revision", "display_name_override",
	}
	for _, column := range want {
		if !db.Migrator().HasColumn(&citypemodel.RelationType{}, column) {
			t.Errorf("column %s was not created", column)
		}
	}
}

// The semantic mirror must round-trip, including the JSON vocabulary list and
// the defaults the ontology sync relies on.
func TestRelationTypeSemanticMirrorRoundTrip(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	rt := citypemodel.RelationType{
		Name:                "CALLS",
		Category:            "dependency",
		Direction:           "src_to_dst",
		PropagatesDefault:   true,
		WeightDefault:       0.8,
		InverseOf:           "CALLED_BY",
		Transitive:          false,
		SubPropertyOf:       citypemodel.StringList{"DEPENDS_ON"},
		DisplayNameZH:       "调用",
		DisplayNameEN:       "Calls",
		Description:         "caller invokes callee",
		Revision:            3,
		DisplayNameOverride: "服务调用",
	}
	if err := db.Create(&rt).Error; err != nil {
		t.Fatalf("create relation type: %v", err)
	}

	var got citypemodel.RelationType
	if err := db.First(&got, rt.ID).Error; err != nil {
		t.Fatalf("read relation type: %v", err)
	}
	if got.Category != "dependency" || got.Direction != "src_to_dst" ||
		!got.PropagatesDefault || got.WeightDefault != 0.8 ||
		got.InverseOf != "CALLED_BY" || got.Transitive ||
		len(got.SubPropertyOf) != 1 || got.SubPropertyOf[0] != "DEPENDS_ON" ||
		got.DisplayNameZH != "调用" || got.DisplayNameEN != "Calls" ||
		got.Description != "caller invokes callee" || got.Revision != 3 ||
		got.DisplayNameOverride != "服务调用" {
		t.Fatalf("semantic mirror did not round-trip: %+v", got)
	}

	defaulted := citypemodel.RelationType{Name: "DEPENDS_ON"}
	if err := db.Create(&defaulted).Error; err != nil {
		t.Fatalf("create defaulted relation type: %v", err)
	}
	var gotDefault citypemodel.RelationType
	if err := db.First(&gotDefault, defaulted.ID).Error; err != nil {
		t.Fatalf("read defaulted relation type: %v", err)
	}
	if gotDefault.WeightDefault != 1 || gotDefault.PropagatesDefault ||
		gotDefault.Transitive || gotDefault.Deprecated || gotDefault.Revision != 0 {
		t.Fatalf("semantic defaults = %+v, want weight 1 and false/zero flags", gotDefault)
	}
}

// The eight live vocabulary words get their first semantic values from the
// migration. It only fills rows that are still unconfigured (category empty,
// revision zero) and never overwrites an ontology-managed or operator-edited
// row.
func TestBackfillRelationTypeSemantics(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	for _, name := range []string{
		"contain", "deploy", "install", "connect", "manage", "bind", "depend", "run",
	} {
		if err := db.Create(&citypemodel.RelationType{Name: name}).Error; err != nil {
			t.Fatalf("seed %s: %v", name, err)
		}
	}
	custom := citypemodel.RelationType{
		Name: "CALLS", Category: "association", Direction: "src_to_dst",
		WeightDefault: 0.5, Revision: 9,
	}
	if err := db.Create(&custom).Error; err != nil {
		t.Fatal(err)
	}

	// The second migration is what runs the backfill.
	if err := Migrate(db); err != nil {
		t.Fatalf("second Migrate() error = %v", err)
	}

	type want struct {
		category, direction, replacement, zh string
		propagates, transitive, deprecated   bool
		weight                               float64
	}
	wants := map[string]want{
		"contain": {"structure", "src_to_dst", "", "包含", false, true, false, 0},
		"deploy":  {"runtime", "dst_to_src", "", "部署", true, false, false, 1.0},
		"install": {"runtime", "dst_to_src", "RUNS_ON", "安装", true, false, true, 0.8},
		"connect": {"dependency", "bidirectional", "", "连接", true, false, false, 0.6},
		"manage":  {"ownership", "src_to_dst", "", "管理", false, false, false, 0},
		"bind":    {"ownership", "src_to_dst", "", "绑定", false, false, false, 0},
		"depend":  {"dependency", "dst_to_src", "", "依赖", true, false, false, 0.8},
		"run":     {"runtime", "dst_to_src", "", "运行于", true, false, false, 1.0},
	}
	for name, w := range wants {
		var got citypemodel.RelationType
		if err := db.Where("name = ?", name).First(&got).Error; err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if got.Category != w.category || got.Direction != w.direction ||
			got.PropagatesDefault != w.propagates || got.WeightDefault != w.weight ||
			got.Transitive != w.transitive || got.Deprecated != w.deprecated ||
			got.Replacement != w.replacement || got.DisplayNameZH != w.zh ||
			got.Revision != 1 {
			t.Fatalf("%s = %+v, want %+v", name, got, w)
		}
	}

	var gotCustom citypemodel.RelationType
	if err := db.Where("name = ?", "CALLS").First(&gotCustom).Error; err != nil {
		t.Fatal(err)
	}
	if gotCustom.Category != "association" || gotCustom.WeightDefault != 0.5 || gotCustom.Revision != 9 {
		t.Fatalf("an ontology-managed row was overwritten: %+v", gotCustom)
	}

	// A second backfill pass must not touch a row that is already configured.
	if err := db.Model(&citypemodel.RelationType{}).Where("name = ?", "contain").
		Updates(map[string]any{"category": "custom", "revision": 7}).Error; err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("third Migrate() error = %v", err)
	}
	var gotContain citypemodel.RelationType
	if err := db.Where("name = ?", "contain").First(&gotContain).Error; err != nil {
		t.Fatal(err)
	}
	if gotContain.Category != "custom" || gotContain.Revision != 7 {
		t.Fatalf("the backfill overwrote a configured row: %+v", gotContain)
	}
}

// Attribute defaults matter for storage-table selection: an attribute created
// without explicit flags must be an unindexed TEXT ("2"), which is what cantor
// defaults to.
func TestAttributeDefaults(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	attr := citypemodel.Attribute{Name: "hostname", Alias: "hostname"}
	if err := db.Create(&attr).Error; err != nil {
		t.Fatalf("create attribute: %v", err)
	}
	var got citypemodel.Attribute
	if err := db.First(&got, attr.ID).Error; err != nil {
		t.Fatalf("read attribute: %v", err)
	}
	if got.ValueType != "2" {
		t.Fatalf("default value_type = %q, want \"2\" (TEXT)", got.ValueType)
	}
	if got.IsIndex || got.IsList || got.IsUnique || got.IsPassword {
		t.Fatalf("attribute flags did not default to false: %+v", got)
	}
}

// JSON-serialised columns must round-trip on the pure-Go SQLite, including an
// empty/NULL value — several of these hold encrypted ciphertext bags in
// cantor, so a silent truncation would destroy credentials.
func TestAttributeAndRelationJSONRoundTrip(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	attr := citypemodel.Attribute{
		Name: "credential", Alias: "credential",
		ChoiceWebHook: map[string]any{
			"headers":       map[string]any{"Cookie": "CIPHERTEXT"},
			"authorization": map[string]any{"token": "CIPHERTEXT2"},
		},
		Option:  map[string]any{"file_storage": "local"},
		Default: map[string]any{"default": "$created_at"},
	}
	if err := db.Create(&attr).Error; err != nil {
		t.Fatalf("create attribute: %v", err)
	}

	var got citypemodel.Attribute
	if err := db.First(&got, attr.ID).Error; err != nil {
		t.Fatalf("read attribute: %v", err)
	}
	hdrs, ok := got.ChoiceWebHook["headers"].(map[string]any)
	if !ok || hdrs["Cookie"] != "CIPHERTEXT" {
		t.Fatalf("ChoiceWebHook did not round-trip: %#v", got.ChoiceWebHook)
	}
	if got.Default["default"] != "$created_at" {
		t.Fatalf("Default did not round-trip: %#v", got.Default)
	}

	// A NULL JSON column must read back as nil, not panic.
	plain := citypemodel.Attribute{Name: "cpu", Alias: "cpu"}
	if err := db.Create(&plain).Error; err != nil {
		t.Fatalf("create plain attribute: %v", err)
	}
	var gotPlain citypemodel.Attribute
	if err := db.First(&gotPlain, plain.ID).Error; err != nil {
		t.Fatalf("read plain attribute: %v", err)
	}
	if gotPlain.ChoiceWebHook != nil || gotPlain.Option != nil {
		t.Fatalf("NULL JSON columns became non-nil: %#v", gotPlain.ChoiceWebHook)
	}

	ctr := citypemodel.CITypeRelation{
		ParentID: 1, ChildID: 2, RelationTypeID: 3,
		ParentAttrIDs: citypemodel.IDList{1, 2},
	}
	if err := db.Create(&ctr).Error; err != nil {
		t.Fatalf("create type relation: %v", err)
	}
	var gotCTR citypemodel.CITypeRelation
	if err := db.First(&gotCTR, ctr.ID).Error; err != nil {
		t.Fatalf("read type relation: %v", err)
	}
	if len(gotCTR.ParentAttrIDs) != 2 || gotCTR.ParentAttrIDs[0] != 1 || gotCTR.ParentAttrIDs[1] != 2 {
		t.Fatalf("ParentAttrIDs did not round-trip: %#v", gotCTR.ParentAttrIDs)
	}
}

// Index names must be unique across the whole database, not just per table:
// SQLite enforces that and MySQL does not. Asserted non-vacuously.
func TestIndexNamesAreGloballyUniqueAcrossBothMigrators(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("citype Migrate() error = %v", err)
	}

	models := []any{
		&citypemodel.RelationType{}, &citypemodel.CITypeGroup{}, &citypemodel.CITypeGroupItem{},
		&citypemodel.CIType{}, &citypemodel.CITypeInheritance{}, &citypemodel.CITypeRelation{},
		&citypemodel.Attribute{}, &citypemodel.CITypeAttribute{},
		&citypemodel.CITypeAttributeGroup{}, &citypemodel.CITypeAttributeGroupItem{},
		&citypemodel.CITypeUniqueConstraint{}, &citypemodel.CITypeTrigger{},
	}

	seen := map[string]string{}
	for _, m := range models {
		stmt := &gorm.Statement{DB: db}
		if err := stmt.Parse(m); err != nil {
			t.Fatalf("parse %T: %v", m, err)
		}
		for _, idx := range stmt.Schema.ParseIndexes() {
			if idx.Class == "CHECK" {
				continue
			}
			if prev, dup := seen[idx.Name]; dup {
				t.Errorf("index %s declared on both %s and %T", idx.Name, prev, m)
				continue
			}
			seen[idx.Name] = stmt.Schema.Table
		}
	}
	if len(seen) < 15 {
		t.Fatalf("only %d distinct index names discovered; the uniqueness check would be vacuous", len(seen))
	}
}
