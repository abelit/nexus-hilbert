package store

import (
	"context"
	"testing"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
)

// The split planner is read-only: it reports the target vocabulary, the edge
// impact and the rows that need a human decision, and changes nothing.
func TestPlanRelationSplitClassifiesPairsAndFlagsReview(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := db.AutoMigrate(&citypemodel.CIType{}, &citypemodel.CITypeRelation{}); err != nil {
		t.Fatalf("migrate dictionary: %v", err)
	}

	// Relation type ids high enough not to collide with newTestDB's pool.
	for id, name := range map[int32]string{
		101: "contain", 102: "connect", 103: "depend", 104: "deploy", 105: "run",
	} {
		rt := citypemodel.RelationType{Name: name}
		rt.ID = id
		if err := db.Create(&rt).Error; err != nil {
			t.Fatalf("seed relation type %s: %v", name, err)
		}
	}

	typeIDs := map[string]model.ID{
		"ipam_subnet": 1, "ipam_address": 2, "app_cluster": 3, "app_instance": 4,
		"power_source": 5, "ups": 6, "service": 7, "application": 8,
		"db_cluster": 9, "vserver": 10, "container": 11,
	}
	for name, id := range typeIDs {
		ct := citypemodel.CIType{Name: name, Alias: name, UniqueID: 1, Enabled: true}
		ct.ID = id
		if err := db.Create(&ct).Error; err != nil {
			t.Fatalf("seed type %s: %v", name, err)
		}
	}

	constraint := "2"
	addRule := func(relType, parent, child model.ID) {
		t.Helper()
		if err := db.Create(&citypemodel.CITypeRelation{
			ParentID: parent, ChildID: child, RelationTypeID: relType, Constraint: &constraint,
		}).Error; err != nil {
			t.Fatalf("seed rule %d->%d: %v", parent, child, err)
		}
	}
	addRule(101, typeIDs["ipam_subnet"], typeIDs["ipam_address"])
	addRule(101, typeIDs["app_cluster"], typeIDs["app_instance"])
	addRule(101, typeIDs["application"], typeIDs["app_cluster"])
	addRule(102, typeIDs["power_source"], typeIDs["ups"])
	addRule(102, typeIDs["service"], typeIDs["service"])
	addRule(103, typeIDs["app_instance"], typeIDs["db_cluster"])
	addRule(103, typeIDs["service"], typeIDs["application"])
	addRule(104, typeIDs["app_instance"], typeIDs["vserver"])
	addRule(105, typeIDs["container"], typeIDs["vserver"])

	ciIDs := map[string]model.ID{
		"ipam_subnet": 1001, "ipam_address": 1002, "app_cluster": 1003, "app_instance": 1004,
		"power_source": 1005, "ups": 1006, "service_a": 1007, "service_b": 1008,
		"application": 1009, "db_cluster": 1010, "vserver": 1011, "container": 1012,
	}
	ciTypes := map[string]model.ID{
		"ipam_subnet": typeIDs["ipam_subnet"], "ipam_address": typeIDs["ipam_address"],
		"app_cluster": typeIDs["app_cluster"], "app_instance": typeIDs["app_instance"],
		"power_source": typeIDs["power_source"], "ups": typeIDs["ups"],
		"service_a": typeIDs["service"], "service_b": typeIDs["service"],
		"application": typeIDs["application"], "db_cluster": typeIDs["db_cluster"],
		"vserver": typeIDs["vserver"], "container": typeIDs["container"],
	}
	for name, id := range ciIDs {
		ci := cimodel.CI{TypeID: ciTypes[name], PropsJSON: "{}"}
		ci.ID = id
		if err := db.Create(&ci).Error; err != nil {
			t.Fatalf("seed ci %s: %v", name, err)
		}
	}

	addEdge := func(relType, first, second model.ID) {
		t.Helper()
		if err := db.Create(&cimodel.Relation{
			FirstCIID: first, SecondCIID: second, RelationTypeID: relType,
		}).Error; err != nil {
			t.Fatalf("seed edge: %v", err)
		}
	}
	addEdge(101, ciIDs["ipam_subnet"], ciIDs["ipam_address"])
	addEdge(101, ciIDs["app_cluster"], ciIDs["app_instance"])
	addEdge(101, ciIDs["application"], ciIDs["app_cluster"])
	addEdge(102, ciIDs["power_source"], ciIDs["ups"])
	addEdge(102, ciIDs["service_a"], ciIDs["service_b"])
	addEdge(103, ciIDs["app_instance"], ciIDs["db_cluster"])
	addEdge(103, ciIDs["service_a"], ciIDs["application"])
	addEdge(104, ciIDs["app_instance"], ciIDs["vserver"])
	addEdge(105, ciIDs["container"], ciIDs["vserver"])

	report, err := PlanRelationSplit(context.Background(), db)
	if err != nil {
		t.Fatalf("PlanRelationSplit() error = %v", err)
	}
	if report.UnresolvedRules != 0 || report.UnresolvedEdges != 0 {
		t.Fatalf("unresolved = %d rules / %d edges, want 0", report.UnresolvedRules, report.UnresolvedEdges)
	}
	if report.TotalEdges != 9 {
		t.Fatalf("total edges = %d, want 9", report.TotalEdges)
	}
	wantTotals := map[string]int64{
		"ALLOCATED_TO": 1, "MEMBER_OF": 1, "PART_OF": 1,
		"POWERED_BY": 1, "CONNECTS_TO": 1, "DEPENDS_ON": 2, "RUNS_ON": 2,
	}
	for target, want := range wantTotals {
		if report.Totals[target] != want {
			t.Fatalf("target %s = %d edges, want %d (report %+v)", target, report.Totals[target], want, report.Totals)
		}
	}

	reviewed := map[string]SplitPlanRow{}
	for _, row := range report.Rows {
		reviewed[row.RelationType+"|"+row.ParentModel+"|"+row.ChildModel] = row
	}
	power := reviewed["connect|power_source|ups"]
	if !power.Review || !power.DirectionInverted || power.Target != "POWERED_BY" {
		t.Fatalf("power row = %+v, want reviewed, direction-inverted POWERED_BY", power)
	}
	svc := reviewed["connect|service|service"]
	if !svc.Review || svc.DirectionInverted || svc.Target != "CONNECTS_TO" {
		t.Fatalf("service row = %+v, want reviewed CONNECTS_TO", svc)
	}
	dep := reviewed["depend|service|application"]
	if !dep.Review || dep.Target != "DEPENDS_ON" {
		t.Fatalf("ambiguous depend row = %+v, want reviewed DEPENDS_ON", dep)
	}
	ipam := reviewed["contain|ipam_subnet|ipam_address"]
	if ipam.Review || ipam.Target != "ALLOCATED_TO" || ipam.CmdbName != "ALLOCATES" ||
		ipam.InverseOf != "ALLOCATED_TO" || !ipam.DirectionInverted {
		t.Fatalf("ipam row = %+v, want ALLOCATES inverse_of ALLOCATED_TO", ipam)
	}
	member := reviewed["contain|app_cluster|app_instance"]
	if member.Target != "MEMBER_OF" || member.CmdbName != "HAS_MEMBER" ||
		member.InverseOf != "MEMBER_OF" || !member.DirectionInverted {
		t.Fatalf("member row = %+v, want HAS_MEMBER inverse_of MEMBER_OF", member)
	}
}

func TestPlanRelationSplitRejectsNilDB(t *testing.T) {
	if _, err := PlanRelationSplit(context.Background(), nil); err == nil {
		t.Fatal("PlanRelationSplit(nil) = nil error, want error")
	}
}
