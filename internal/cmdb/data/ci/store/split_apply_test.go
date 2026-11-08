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

// Structural contain rules keep the stored whole -> part direction. The split
// creates inverse CMDB names that declare inverse_of, so no one2many rule or
// edge is flipped.
func TestApplyRelationSplitContainUsesInverseNames(t *testing.T) {
	db, fx := newContainSplitApplyFixture(t)
	ctx := context.Background()

	dry, err := ApplyRelationSplit(ctx, db, true)
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if dry.ReclassifiedRules != 5 || dry.ReclassifiedEdges != 5 || dry.FlippedEdges != 0 {
		t.Fatalf("dry report = %+v, want 5 rules/5 edges, 0 flipped", dry)
	}
	if len(dry.CreatedTypes) != 0 || len(dry.DeprecatedTypes) != 0 {
		t.Fatalf("dry run wrote metadata: created=%v deprecated=%v", dry.CreatedTypes, dry.DeprecatedTypes)
	}
	if got := countRelationTypes(t, db, "CONTAINS"); got != 0 {
		t.Fatalf("dry run created CONTAINS: %d", got)
	}
	var ipamRow, memberRow *SplitApplyRow
	for i := range dry.Rows {
		switch dry.Rows[i].ParentModel + "|" + dry.Rows[i].ChildModel {
		case "ipam_subnet|ipam_address":
			ipamRow = &dry.Rows[i]
		case "app_cluster|app_instance":
			memberRow = &dry.Rows[i]
		}
	}
	if ipamRow == nil || ipamRow.Target != "ALLOCATES" || ipamRow.InverseOf != "ALLOCATED_TO" {
		t.Fatalf("ipam row = %+v, want ALLOCATES inverse_of ALLOCATED_TO", ipamRow)
	}
	if memberRow == nil || memberRow.Target != "HAS_MEMBER" || memberRow.InverseOf != "MEMBER_OF" {
		t.Fatalf("member row = %+v, want HAS_MEMBER inverse_of MEMBER_OF", memberRow)
	}

	report, err := ApplyRelationSplit(ctx, db, false)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if report.ReclassifiedRules != 5 || report.ReclassifiedEdges != 5 || report.FlippedEdges != 0 {
		t.Fatalf("report = %+v, want 5 rules/5 edges, 0 flipped", report)
	}
	if len(report.CreatedTypes) != 5 {
		t.Fatalf("created types = %v, want 5", report.CreatedTypes)
	}
	if len(report.DeprecatedTypes) != 1 || report.DeprecatedTypes[0] != "contain" {
		t.Fatalf("deprecated types = %v, want [contain]", report.DeprecatedTypes)
	}

	allocates := relationTypeID(t, db, "ALLOCATES")
	hasMember := relationTypeID(t, db, "HAS_MEMBER")
	contains := relationTypeID(t, db, "CONTAINS")
	hasLocation := relationTypeID(t, db, "HAS_LOCATION")
	hasBelonging := relationTypeID(t, db, "HAS_BELONGING")
	for name, id := range map[string]model.ID{
		"ALLOCATES": allocates, "HAS_MEMBER": hasMember, "CONTAINS": contains,
		"HAS_LOCATION": hasLocation, "HAS_BELONGING": hasBelonging,
	} {
		if id == 0 {
			t.Fatalf("%s was not created", name)
		}
		assertTypeSemantics(t, db, id, "structure", "src_to_dst", false, 0)
	}
	assertTypeInverse(t, db, "ALLOCATES", "ALLOCATED_TO", false)
	assertTypeInverse(t, db, "HAS_MEMBER", "MEMBER_OF", false)
	assertTypeInverse(t, db, "CONTAINS", "PART_OF", true)
	assertTypeInverse(t, db, "HAS_LOCATION", "LOCATED_IN", false)
	assertTypeInverse(t, db, "HAS_BELONGING", "BELONGS_TO", false)

	assertRuleType(t, db, fx.subnetRuleID, allocates)
	assertRuleType(t, db, fx.memberRuleID, hasMember)
	assertRuleType(t, db, fx.partRuleID, contains)
	assertRuleType(t, db, fx.locationRuleID, hasLocation)
	assertRuleType(t, db, fx.belongingRuleID, hasBelonging)
	// The rule endpoints keep whole -> part.
	assertRuleEndpoints(t, db, fx.subnetRuleID, fx.subnetTypeID, fx.addressTypeID)
	assertRuleEndpoints(t, db, fx.partRuleID, fx.applicationTypeID, fx.clusterTypeID)

	assertLiveEdgeType(t, db, fx.subnetEdgeID, allocates)
	assertLiveEdgeType(t, db, fx.partEdgeID, contains)
	// No edge is flipped.
	assertEdgeEndpoints(t, db, fx.subnetEdgeID, fx.subnetCIID, fx.addressCIID)
	assertEdgeEndpoints(t, db, fx.partEdgeID, fx.applicationCIID, fx.clusterCIID)

	if !relationTypeDeprecated(t, db, "contain") {
		t.Fatal("contain was not deprecated")
	}

	again, err := ApplyRelationSplit(ctx, db, false)
	if err != nil {
		t.Fatalf("second apply: %v", err)
	}
	if again.ReclassifiedRules != 0 || again.ReclassifiedEdges != 0 ||
		again.FlippedEdges != 0 || len(again.CreatedTypes) != 0 {
		t.Fatalf("second apply = %+v, want an idempotent no-op", again)
	}
}

type containSplitFixture struct {
	subnetRuleID, memberRuleID, partRuleID, locationRuleID, belongingRuleID model.ID
	subnetEdgeID, memberEdgeID, partEdgeID, locationEdgeID, belongingEdgeID model.ID
	subnetTypeID, addressTypeID, clusterTypeID, instanceTypeID              model.ID
	applicationTypeID, certificateTypeID, rackTypeID, serverTypeID          model.ID
	subnetCIID, addressCIID, clusterCIID, instanceCIID                      model.ID
	applicationCIID, certificateCIID, rackCIID, serverCIID                  model.ID
}

func newContainSplitApplyFixture(t *testing.T) (*gorm.DB, containSplitFixture) {
	t.Helper()
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := db.AutoMigrate(&citypemodel.CIType{}, &citypemodel.CITypeRelation{}); err != nil {
		t.Fatalf("migrate dictionary: %v", err)
	}

	contain := citypemodel.RelationType{Name: "contain"}
	contain.ID = 205
	if err := db.Create(&contain).Error; err != nil {
		t.Fatalf("seed contain: %v", err)
	}

	typeIDs := map[string]model.ID{
		"ipam_subnet": 1, "ipam_address": 2, "app_cluster": 3, "app_instance": 4,
		"application": 5, "certificate": 6, "dcim_rack": 7, "server": 8,
	}
	for name, id := range typeIDs {
		ct := citypemodel.CIType{Name: name, Alias: name, UniqueID: 1, Enabled: true}
		ct.ID = id
		if err := db.Create(&ct).Error; err != nil {
			t.Fatalf("seed ci type %s: %v", name, err)
		}
	}
	constraint := "0"
	addRule := func(parent, child model.ID) model.ID {
		t.Helper()
		row := citypemodel.CITypeRelation{
			ParentID: parent, ChildID: child, RelationTypeID: contain.ID, Constraint: &constraint,
		}
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed rule: %v", err)
		}
		return row.ID
	}
	fx := containSplitFixture{
		subnetTypeID: typeIDs["ipam_subnet"], addressTypeID: typeIDs["ipam_address"],
		clusterTypeID: typeIDs["app_cluster"], instanceTypeID: typeIDs["app_instance"],
		applicationTypeID: typeIDs["application"], certificateTypeID: typeIDs["certificate"],
		rackTypeID: typeIDs["dcim_rack"], serverTypeID: typeIDs["server"],
	}
	fx.subnetRuleID = addRule(fx.subnetTypeID, fx.addressTypeID)
	fx.memberRuleID = addRule(fx.clusterTypeID, fx.instanceTypeID)
	fx.partRuleID = addRule(fx.applicationTypeID, fx.clusterTypeID)
	fx.locationRuleID = addRule(fx.rackTypeID, fx.serverTypeID)
	fx.belongingRuleID = addRule(fx.applicationTypeID, fx.certificateTypeID)

	ciIDs := map[string]model.ID{
		"ipam_subnet": 2001, "ipam_address": 2002, "app_cluster": 2003, "app_instance": 2004,
		"application": 2005, "certificate": 2006, "dcim_rack": 2007, "server": 2008,
	}
	ciTypes := map[string]model.ID{
		"ipam_subnet": typeIDs["ipam_subnet"], "ipam_address": typeIDs["ipam_address"],
		"app_cluster": typeIDs["app_cluster"], "app_instance": typeIDs["app_instance"],
		"application": typeIDs["application"], "certificate": typeIDs["certificate"],
		"dcim_rack": typeIDs["dcim_rack"], "server": typeIDs["server"],
	}
	for name, id := range ciIDs {
		ci := cimodel.CI{TypeID: ciTypes[name], PropsJSON: "{}"}
		ci.ID = id
		if err := db.Create(&ci).Error; err != nil {
			t.Fatalf("seed ci %s: %v", name, err)
		}
	}
	addEdge := func(first, second model.ID) model.ID {
		t.Helper()
		row := cimodel.Relation{FirstCIID: first, SecondCIID: second, RelationTypeID: contain.ID}
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed edge: %v", err)
		}
		return row.ID
	}
	fx.subnetCIID, fx.addressCIID = ciIDs["ipam_subnet"], ciIDs["ipam_address"]
	fx.clusterCIID, fx.instanceCIID = ciIDs["app_cluster"], ciIDs["app_instance"]
	fx.applicationCIID, fx.certificateCIID = ciIDs["application"], ciIDs["certificate"]
	fx.rackCIID, fx.serverCIID = ciIDs["dcim_rack"], ciIDs["server"]
	fx.subnetEdgeID = addEdge(fx.subnetCIID, fx.addressCIID)
	fx.memberEdgeID = addEdge(fx.clusterCIID, fx.instanceCIID)
	fx.partEdgeID = addEdge(fx.applicationCIID, fx.clusterCIID)
	fx.locationEdgeID = addEdge(fx.rackCIID, fx.serverCIID)
	fx.belongingEdgeID = addEdge(fx.applicationCIID, fx.certificateCIID)
	return db, fx
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

func assertTypeInverse(t *testing.T, db *gorm.DB, name, inverseOf string, transitive bool) {
	t.Helper()
	var rt citypemodel.RelationType
	if err := db.Where("name = ?", name).First(&rt).Error; err != nil {
		t.Fatalf("relation type %s: %v", name, err)
	}
	if rt.InverseOf != inverseOf || rt.Transitive != transitive {
		t.Fatalf("%s inverse_of/transitive = %q/%v, want %q/%v",
			name, rt.InverseOf, rt.Transitive, inverseOf, transitive)
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
