package store

import (
	"context"
	"strings"
	"testing"

	"gorm.io/gorm"

	cibiz "github.com/ongridio/ongrid/internal/cmdb/biz/ci"
	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
	"github.com/ongridio/ongrid/internal/cmdb/model/value"
)

// The M1 apply creates the target CIs for the deterministic sources, records
// the source -> target mapping, skips missing/duplicate identifiers, and is
// resumable. It never touches the source instances.
func TestApplyServiceLayersCreatesAndResumes(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := db.AutoMigrate(&citypemodel.CIType{}); err != nil {
		t.Fatalf("migrate types: %v", err)
	}
	// The write path takes a row lock on the target model.
	for id, name := range map[model.ID]string{20: "application_service", 21: "service_instance"} {
		ct := citypemodel.CIType{Name: name, Alias: name, Enabled: true}
		ct.ID = id
		if err := db.Create(&ct).Error; err != nil {
			t.Fatalf("seed target model %s: %v", name, err)
		}
	}
	repo := NewRepo(db)
	uc := cibiz.NewUsecase(repo, serviceLayerResolver{}.withSets(), nil).WithLayerMappings(repo)
	ctx := context.Background()

	// Source instances: two applications, one instance, one without an
	// identifier, and a duplicate pair.
	for _, ci := range []struct {
		id, typeID model.ID
	}{
		{1001, 10}, {1002, 10},
		{1101, 11}, {1102, 11}, {1103, 11}, {1104, 11},
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
		{1001, 1, "app-a"}, {1001, 2, "App A"}, {1001, 3, "team-a"},
		{1002, 1, "app-b"}, {1002, 2, "App B"},
		{1101, 3, "inst-a"}, {1101, 4, "Instance A"}, {1101, 5, "v1"},
		{1102, 4, "Instance without code"},
		{1103, 3, "dup"}, {1103, 4, "Duplicate A"},
		{1104, 3, "dup"}, {1104, 4, "Duplicate B"},
	}
	for _, v := range values {
		row := value.ValueIndexText{CIID: v.ciID, AttrID: v.attrID, Value: v.text}
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed value %v: %v", v, err)
		}
	}

	dry, err := uc.ApplyServiceLayers(ctx, cibiz.ServiceLayerApplyInput{DryRun: true})
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if len(dry.Created) != 3 || len(dry.Skipped) != 3 || len(dry.Existing) != 0 {
		t.Fatalf("dry report = %+v", dry)
	}
	if got := serviceLayerCountCIs(t, repo, 20); got != 0 {
		t.Fatalf("dry run created %d target CIs", got)
	}
	if got := serviceLayerCountCIs(t, repo, 21); got != 0 {
		t.Fatalf("dry run created %d target instances", got)
	}

	report, err := uc.ApplyServiceLayers(ctx, cibiz.ServiceLayerApplyInput{})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if len(report.Created) != 3 || len(report.Skipped) != 3 || len(report.Existing) != 0 {
		t.Fatalf("report = %+v", report)
	}
	if got := serviceLayerCountCIs(t, repo, 20); got != 2 {
		t.Fatalf("application_service = %d, want 2", got)
	}
	if got := serviceLayerCountCIs(t, repo, 21); got != 1 {
		t.Fatalf("service_instance = %d, want 1", got)
	}

	// The target carries the identity, the display name and the same-name
	// attribute copied from the source.
	appService := serviceLayerFindCIByUnique(t, db, 20, 10, "app-a")
	if appService == 0 {
		t.Fatal("application_service app-a was not created")
	}
	if got := serviceLayerTextValue(t, db, appService, 11); got != "App A" {
		t.Fatalf("application_service name = %q", got)
	}
	if got := serviceLayerTextValue(t, db, appService, 12); got != "team-a" {
		t.Fatalf("application_service owner = %q", got)
	}
	instance := serviceLayerFindCIByUnique(t, db, 21, 20, "inst-a")
	if instance == 0 {
		t.Fatal("service_instance inst-a was not created")
	}
	if got := serviceLayerTextValue(t, db, instance, 22); got != "v1" {
		t.Fatalf("service_instance version = %q", got)
	}

	if mapping, err := repo.LayerMappingFor(ctx, 1001, "application_service"); err != nil || mapping == nil || mapping.TargetCIID != appService {
		t.Fatalf("mapping = %+v, err = %v", mapping, err)
	}

	again, err := uc.ApplyServiceLayers(ctx, cibiz.ServiceLayerApplyInput{})
	if err != nil {
		t.Fatalf("second apply: %v", err)
	}
	if len(again.Created) != 0 || len(again.Existing) != 3 || len(again.Skipped) != 3 {
		t.Fatalf("second report = %+v, want an idempotent resume", again)
	}
	if got := serviceLayerCountCIs(t, repo, 20); got != 2 {
		t.Fatalf("second apply duplicated application_service: %d", got)
	}
}

// A service is written only when every conservative gate passes, and only
// when the operator opted into the classification; a connection or missing
// evidence keeps it in the review queue.
func TestApplyServiceLayersClassifiesServices(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := db.AutoMigrate(&citypemodel.CIType{}, &citypemodel.Attribute{}); err != nil {
		t.Fatalf("migrate types: %v", err)
	}
	for id, name := range map[model.ID]string{
		10: "application", 11: "app_instance", 20: "application_service",
		21: "service_instance", 30: "service", 40: "business_service",
		43: "product", 44: "sla", 45: "members",
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

	repo := NewRepo(db)
	uc := cibiz.NewUsecase(repo, serviceLayerResolver{}.withSets(), nil).WithLayerMappings(repo)
	ctx := context.Background()

	for _, ci := range []struct {
		id, typeID model.ID
	}{
		{1101, 10},
		{1201, 30}, {1202, 30}, {1203, 30},
		{4301, 43}, {4401, 44}, {4501, 45},
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
		{1101, 1, "app-a"}, {1101, 2, "App A"},
		{1201, 1, "svc-a"}, {1201, 2, "Service A"},
		{1202, 1, "svc-b"}, {1202, 2, "Service B"},
		{1203, 1, "svc-c"}, {1203, 2, "Service C"},
	}
	for _, id := range []model.ID{1201, 1202, 1203} {
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
		{1201, 1101, 50}, // the business service aggregates the application
		{4301, 1201, 51}, // and all three governance anchors
		{4401, 1201, 53},
		{4501, 1201, 54},
		{1202, 1101, 50}, // 1202 aggregates an application too, but
		{1202, 1203, 52}, // a service-to-service connection keeps it in review
	} {
		row := cimodel.Relation{FirstCIID: rel.first, SecondCIID: rel.second, RelationTypeID: rel.typeID}
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed relation %v: %v", rel, err)
		}
	}

	// Without the explicit opt-in, no service target or mapping is written.
	skippedReport, err := uc.ApplyServiceLayers(ctx, cibiz.ServiceLayerApplyInput{DryRun: true})
	if err != nil {
		t.Fatalf("dry run without classification: %v", err)
	}
	if len(skippedReport.Created) != 1 || len(skippedReport.Skipped) != 3 {
		t.Fatalf("unclassified dry report = %+v", skippedReport)
	}
	for _, row := range skippedReport.Skipped {
		if !strings.Contains(row.Reason, "--classify-service") {
			t.Fatalf("unclassified skip reason = %q", row.Reason)
		}
	}

	report, err := uc.ApplyServiceLayers(ctx, cibiz.ServiceLayerApplyInput{DryRun: true, ClassifyService: true})
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if len(report.Created) != 2 || len(report.Skipped) != 2 || len(report.Existing) != 0 {
		t.Fatalf("dry report = %+v", report)
	}

	report, err = uc.ApplyServiceLayers(ctx, cibiz.ServiceLayerApplyInput{ClassifyService: true})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if len(report.Created) != 2 || len(report.Skipped) != 2 || len(report.Existing) != 0 {
		t.Fatalf("report = %+v", report)
	}
	var serviceRow *cibiz.ServiceLayerAppliedRow
	for i := range report.Created {
		if report.Created[i].SourceCIID == 1201 {
			serviceRow = &report.Created[i]
		}
	}
	if serviceRow == nil || serviceRow.TargetModel != "business_service" || serviceRow.TargetCIID == 0 {
		t.Fatalf("service 1201 was not projected: %+v", report.Created)
	}
	reasons := map[model.ID]string{}
	for _, row := range report.Skipped {
		reasons[row.SourceCIID] = row.Reason
	}
	if !strings.Contains(reasons[1202], "CONNECTS_TO") {
		t.Fatalf("service 1202 reason = %q", reasons[1202])
	}
	if !strings.Contains(reasons[1203], "CONNECTS_TO (out 0 / in 1)") {
		t.Fatalf("service 1203 reason = %q", reasons[1203])
	}
	if got := serviceLayerTextValue(t, db, serviceRow.TargetCIID, 30); got != "svc-a" {
		t.Fatalf("business_service_code = %q, want the source identifier", got)
	}
	if got := serviceLayerTextValue(t, db, serviceRow.TargetCIID, 31); got != "Service A" {
		t.Fatalf("business_service name = %q", got)
	}
	if mapping, err := repo.LayerMappingFor(ctx, 1201, "business_service"); err != nil || mapping == nil {
		t.Fatalf("mapping = %+v, err = %v", mapping, err)
	}

	again, err := uc.ApplyServiceLayers(ctx, cibiz.ServiceLayerApplyInput{ClassifyService: true})
	if err != nil {
		t.Fatalf("second apply: %v", err)
	}
	if len(again.Created) != 0 || len(again.Existing) != 2 || len(again.Skipped) != 2 {
		t.Fatalf("second report = %+v, want an idempotent resume", again)
	}
}

type serviceLayerResolver map[string]*cibiz.AttributeSet

func (r serviceLayerResolver) withSets() serviceLayerResolver {
	set := func(id, unique, show model.ID, name string, specs map[model.ID]cibiz.AttributeSpec) *cibiz.AttributeSet {
		ct := citypemodel.CIType{Name: name, Alias: name, UniqueID: unique, Enabled: true}
		ct.ID = id
		out := &cibiz.AttributeSet{
			Type: ct, Specs: specs,
			ByName: map[string]model.ID{}, ByAlias: map[string]model.ID{},
			UniqueAttrID: unique, UniqueAttr: specs[unique], ShowAttr: specs[show],
		}
		for attrID, spec := range specs {
			out.ByName[spec.Name] = attrID
			out.ByAlias[spec.Alias] = attrID
		}
		return out
	}
	text := func(id model.ID, name string, unique bool) cibiz.AttributeSpec {
		return cibiz.AttributeSpec{ID: id, Name: name, Alias: name, ValueType: "2", IsIndex: true, IsUnique: unique}
	}
	r["application"] = set(10, 1, 2, "application", map[model.ID]cibiz.AttributeSpec{
		1: text(1, "application_code", true),
		2: text(2, "name", false),
		3: text(3, "owner", false),
	})
	// The built-in service models declare no show attribute, so the resolver
	// falls back to the unique attribute. Passing the unique id as the show id
	// here keeps the fixture faithful to that shape.
	r["application_service"] = set(20, 10, 10, "application_service", map[model.ID]cibiz.AttributeSpec{
		10: text(10, "application_service_code", true),
		11: text(11, "name", false),
		12: text(12, "owner", false),
	})
	r["app_instance"] = set(11, 3, 4, "app_instance", map[model.ID]cibiz.AttributeSpec{
		3: text(3, "instance_code", true),
		4: text(4, "name", false),
		5: text(5, "version", false),
	})
	r["service_instance"] = set(21, 20, 20, "service_instance", map[model.ID]cibiz.AttributeSpec{
		20: text(20, "service_instance_code", true),
		21: text(21, "name", false),
		22: text(22, "version", false),
	})
	r["service"] = set(30, 1, 2, "service", map[model.ID]cibiz.AttributeSpec{
		1: text(1, "uuid", true),
		2: text(2, "name", false),
	})
	r["business_service"] = set(40, 30, 31, "business_service", map[model.ID]cibiz.AttributeSpec{
		30: text(30, "business_service_code", true),
		31: text(31, "name", false),
		32: text(32, "owner", false),
	})
	return r
}

func (r serviceLayerResolver) ResolveForCI(_ context.Context, ref string) (*cibiz.AttributeSet, error) {
	return r[ref], nil
}

func (r serviceLayerResolver) ResolveForCIAlias(_ context.Context, ref string) (*cibiz.AttributeSet, error) {
	return r[ref], nil
}

func (r serviceLayerResolver) RelationBetween(context.Context, model.ID, model.ID) (cibiz.TypeRelationRule, bool, error) {
	return cibiz.TypeRelationRule{}, false, nil
}

func (r serviceLayerResolver) HierarchyLevels(context.Context, model.ID, int, bool) (cibiz.HierarchyLevels, error) {
	return cibiz.HierarchyLevels{}, nil
}

func serviceLayerCountCIs(t *testing.T, repo *Repo, typeID model.ID) int {
	t.Helper()
	_, total, err := repo.ListCIsByType(context.Background(), typeID, 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	return int(total)
}

func serviceLayerFindCIByUnique(t *testing.T, db interface {
	Model(any) *gorm.DB
}, typeID, attrID model.ID, text string) model.ID {
	t.Helper()
	var row value.ValueIndexText
	if err := db.Model(&value.ValueIndexText{}).
		Where("attr_id = ? AND value = ?", attrID, text).First(&row).Error; err != nil {
		return 0
	}
	return row.CIID
}

func serviceLayerTextValue(t *testing.T, db interface {
	Model(any) *gorm.DB
}, ciID, attrID model.ID) string {
	t.Helper()
	var row value.ValueIndexText
	if err := db.Model(&value.ValueIndexText{}).
		Where("ci_id = ? AND attr_id = ?", ciID, attrID).First(&row).Error; err != nil {
		return ""
	}
	return row.Value
}
