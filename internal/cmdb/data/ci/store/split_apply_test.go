package store

import (
	"context"
	"testing"

	"gorm.io/gorm"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
)

// The split apply command is an explicit operator migration. Dry-run reports
// without writing; the real run reclassifies deploy/run/depend/connect, flips
// only the power chain, retires demo/test edges, and is idempotent.
func TestApplyRelationSplitDryRunThenReal(t *testing.T) {
	db, fixture := newSplitApplyFixture(t)
	ctx := context.Background()

	dry, err := ApplyRelationSplit(ctx, db, true)
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if !dry.DryRun || dry.ReclassifiedRules != 5 || dry.ReclassifiedEdges != 5 ||
		dry.FlippedEdges != 1 || dry.RemovedDemoRules != 1 || dry.RemovedDemoEdges != 1 {
		t.Fatalf("dry report = %+v, want 5 rules/5 edges, 1 flipped, 1 demo rule/edge", dry)
	}
	if len(dry.CreatedTypes) != 0 || len(dry.DeprecatedTypes) != 0 {
		t.Fatalf("dry run wrote metadata: created=%v deprecated=%v", dry.CreatedTypes, dry.DeprecatedTypes)
	}
	if got := countRelationTypes(t, db, "RUNS_ON"); got != 0 {
		t.Fatalf("dry run created RUNS_ON: %d", got)
	}
	if fixture.demoEdgeID == 0 || !liveRelation(t, db, fixture.demoEdgeID) {
		t.Fatal("dry run deleted the demo edge")
	}

	report, err := ApplyRelationSplit(ctx, db, false)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if report.ReclassifiedRules != 5 || report.ReclassifiedEdges != 5 ||
		report.FlippedEdges != 1 || report.RemovedDemoRules != 1 || report.RemovedDemoEdges != 1 {
		t.Fatalf("report = %+v", report)
	}
	if len(report.CreatedTypes) != 4 {
		t.Fatalf("created types = %v, want 4", report.CreatedTypes)
	}
	if len(report.DeprecatedTypes) != 4 {
		t.Fatalf("deprecated types = %v, want 4", report.DeprecatedTypes)
	}

	runsOn := relationTypeID(t, db, "RUNS_ON")
	dependsOn := relationTypeID(t, db, "DEPENDS_ON")
	poweredBy := relationTypeID(t, db, "POWERED_BY")
	connectsTo := relationTypeID(t, db, "CONNECTS_TO")
	if runsOn == 0 || dependsOn == 0 || poweredBy == 0 || connectsTo == 0 {
		t.Fatal("a target relation type is missing")
	}
	assertTypeSemantics(t, db, poweredBy, "failure-domain", "dst_to_src", true, 1.0)

	assertRuleType(t, db, fixture.deployRuleID, runsOn)
	assertRuleType(t, db, fixture.runRuleID, runsOn)
	assertRuleType(t, db, fixture.dependRuleID, dependsOn)
	assertRuleType(t, db, fixture.serviceRuleID, connectsTo)
	assertRuleType(t, db, fixture.powerRuleID, poweredBy)
	assertRuleEndpoints(t, db, fixture.powerRuleID, fixture.upsTypeID, fixture.powerSourceTypeID)

	assertLiveEdgeType(t, db, fixture.deployEdgeID, runsOn)
	assertLiveEdgeType(t, db, fixture.runEdgeID, runsOn)
	assertLiveEdgeType(t, db, fixture.dependEdgeID, dependsOn)
	assertLiveEdgeType(t, db, fixture.serviceEdgeID, connectsTo)
	assertLiveEdgeType(t, db, fixture.powerEdgeID, poweredBy)
	assertEdgeEndpoints(t, db, fixture.powerEdgeID, fixture.upsCIID, fixture.powerSourceCIID)
	if liveRelation(t, db, fixture.demoEdgeID) {
		t.Fatal("demo edge is still live")
	}

	for _, name := range []string{"deploy", "run", "depend", "connect"} {
		if !relationTypeDeprecated(t, db, name) {
			t.Fatalf("%s was not deprecated", name)
		}
	}

	again, err := ApplyRelationSplit(ctx, db, false)
	if err != nil {
		t.Fatalf("second apply: %v", err)
	}
	if again.ReclassifiedRules != 0 || again.ReclassifiedEdges != 0 ||
		again.FlippedEdges != 0 || again.RemovedDemoRules != 0 || again.RemovedDemoEdges != 0 {
		t.Fatalf("second apply = %+v, want an idempotent no-op", again)
	}
}

type splitApplyFixture struct {
	upsTypeID, powerSourceTypeID model.ID
	deployRuleID, runRuleID      model.ID
	dependRuleID, powerRuleID    model.ID
	serviceRuleID, demoRuleID    model.ID
	deployEdgeID, runEdgeID      model.ID
	dependEdgeID, powerEdgeID    model.ID
	serviceEdgeID, demoEdgeID    model.ID
	upsCIID, powerSourceCIID     model.ID
}

func newSplitApplyFixture(t *testing.T) (*gorm.DB, splitApplyFixture) {
	t.Helper()
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := db.AutoMigrate(&citypemodel.CIType{}, &citypemodel.CITypeRelation{}); err != nil {
		t.Fatalf("migrate dictionary: %v", err)
	}

	for id, name := range map[int32]string{
		201: "deploy", 202: "run", 203: "depend", 204: "connect",
	} {
		rt := citypemodel.RelationType{Name: name}
		rt.ID = id
		if err := db.Create(&rt).Error; err != nil {
			t.Fatalf("seed type %s: %v", name, err)
		}
	}
	typeIDs := map[string]model.ID{
		"app_instance": 1, "vserver": 2, "db_cluster": 3, "power_source": 4,
		"ups": 5, "service": 6, "demo111": 7, "demo111_call": 8, "container": 9,
	}
	for name, id := range typeIDs {
		ct := citypemodel.CIType{Name: name, Alias: name, UniqueID: 1, Enabled: true}
		ct.ID = id
		if err := db.Create(&ct).Error; err != nil {
			t.Fatalf("seed ci type %s: %v", name, err)
		}
	}
	constraint := "2"
	addRule := func(relType, parent, child model.ID) model.ID {
		t.Helper()
		row := citypemodel.CITypeRelation{
			ParentID: parent, ChildID: child, RelationTypeID: relType, Constraint: &constraint,
		}
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed rule: %v", err)
		}
		return row.ID
	}
	fx := splitApplyFixture{
		upsTypeID: typeIDs["ups"], powerSourceTypeID: typeIDs["power_source"],
	}
	fx.deployRuleID = addRule(201, typeIDs["app_instance"], typeIDs["vserver"])
	fx.runRuleID = addRule(202, typeIDs["app_instance"], typeIDs["container"])
	fx.dependRuleID = addRule(203, typeIDs["app_instance"], typeIDs["db_cluster"])
	fx.powerRuleID = addRule(204, typeIDs["power_source"], typeIDs["ups"])
	fx.serviceRuleID = addRule(204, typeIDs["service"], typeIDs["service"])
	fx.demoRuleID = addRule(204, typeIDs["demo111"], typeIDs["demo111_call"])

	ciIDs := map[string]model.ID{
		"app_instance": 1001, "vserver": 1002, "container": 1003, "db_cluster": 1004,
		"power_source": 1005, "ups": 1006, "service_a": 1007, "service_b": 1008,
		"demo": 1009, "demo_call": 1010,
	}
	ciTypes := map[string]model.ID{
		"app_instance": typeIDs["app_instance"], "vserver": typeIDs["vserver"],
		"container": typeIDs["container"], "db_cluster": typeIDs["db_cluster"],
		"power_source": typeIDs["power_source"], "ups": typeIDs["ups"],
		"service_a": typeIDs["service"], "service_b": typeIDs["service"],
		"demo": typeIDs["demo111"], "demo_call": typeIDs["demo111_call"],
	}
	for name, id := range ciIDs {
		ci := cimodel.CI{TypeID: ciTypes[name], PropsJSON: "{}"}
		ci.ID = id
		if err := db.Create(&ci).Error; err != nil {
			t.Fatalf("seed ci %s: %v", name, err)
		}
	}
	addEdge := func(relType, first, second model.ID) model.ID {
		t.Helper()
		row := cimodel.Relation{FirstCIID: first, SecondCIID: second, RelationTypeID: relType}
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed edge: %v", err)
		}
		return row.ID
	}
	fx.deployEdgeID = addEdge(201, ciIDs["app_instance"], ciIDs["vserver"])
	fx.runEdgeID = addEdge(202, ciIDs["app_instance"], ciIDs["container"])
	fx.dependEdgeID = addEdge(203, ciIDs["app_instance"], ciIDs["db_cluster"])
	fx.powerEdgeID = addEdge(204, ciIDs["power_source"], ciIDs["ups"])
	fx.serviceEdgeID = addEdge(204, ciIDs["service_a"], ciIDs["service_b"])
	fx.demoEdgeID = addEdge(204, ciIDs["demo"], ciIDs["demo_call"])
	fx.upsCIID = ciIDs["ups"]
	fx.powerSourceCIID = ciIDs["power_source"]
	return db, fx
}

func relationTypeID(t *testing.T, db *gorm.DB, name string) model.ID {
	t.Helper()
	var rt citypemodel.RelationType
	if err := db.Where("name = ?", name).First(&rt).Error; err != nil {
		return 0
	}
	return rt.ID
}

func countRelationTypes(t *testing.T, db *gorm.DB, name string) int64 {
	t.Helper()
	var n int64
	if err := db.Model(&citypemodel.RelationType{}).Where("name = ?", name).Count(&n).Error; err != nil {
		t.Fatal(err)
	}
	return n
}

func assertTypeSemantics(t *testing.T, db *gorm.DB, id model.ID, category, direction string, propagates bool, weight float64) {
	t.Helper()
	var rt citypemodel.RelationType
	if err := db.First(&rt, id).Error; err != nil {
		t.Fatal(err)
	}
	if rt.Category != category || rt.Direction != direction || rt.PropagatesDefault != propagates || rt.WeightDefault != weight {
		t.Fatalf("type semantics = %+v", rt)
	}
}

func assertRuleType(t *testing.T, db *gorm.DB, id, want model.ID) {
	t.Helper()
	var rule citypemodel.CITypeRelation
	if err := db.First(&rule, id).Error; err != nil {
		t.Fatal(err)
	}
	if rule.RelationTypeID != want {
		t.Fatalf("rule %d relation type = %d, want %d", id, rule.RelationTypeID, want)
	}
}

func assertRuleEndpoints(t *testing.T, db *gorm.DB, id, parent, child model.ID) {
	t.Helper()
	var rule citypemodel.CITypeRelation
	if err := db.First(&rule, id).Error; err != nil {
		t.Fatal(err)
	}
	if rule.ParentID != parent || rule.ChildID != child {
		t.Fatalf("rule %d endpoints = %d->%d, want %d->%d", id, rule.ParentID, rule.ChildID, parent, child)
	}
}

func assertLiveEdgeType(t *testing.T, db *gorm.DB, id, want model.ID) {
	t.Helper()
	var edge cimodel.Relation
	if err := db.First(&edge, id).Error; err != nil {
		t.Fatal(err)
	}
	if edge.RelationTypeID != want {
		t.Fatalf("edge %d relation type = %d, want %d", id, edge.RelationTypeID, want)
	}
}

func assertEdgeEndpoints(t *testing.T, db *gorm.DB, id, first, second model.ID) {
	t.Helper()
	var edge cimodel.Relation
	if err := db.First(&edge, id).Error; err != nil {
		t.Fatal(err)
	}
	if edge.FirstCIID != first || edge.SecondCIID != second {
		t.Fatalf("edge %d endpoints = %d->%d, want %d->%d", id, edge.FirstCIID, edge.SecondCIID, first, second)
	}
}

func liveRelation(t *testing.T, db *gorm.DB, id model.ID) bool {
	t.Helper()
	var n int64
	if err := db.Model(&cimodel.Relation{}).Where("id = ?", id).Count(&n).Error; err != nil {
		t.Fatal(err)
	}
	return n > 0
}

func relationTypeDeprecated(t *testing.T, db *gorm.DB, name string) bool {
	t.Helper()
	var rt citypemodel.RelationType
	if err := db.Where("name = ?", name).First(&rt).Error; err != nil {
		t.Fatal(err)
	}
	return rt.Deprecated
}
