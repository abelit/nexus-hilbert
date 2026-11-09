package store

import (
	"context"
	"testing"

	cibiz "github.com/ongridio/ongrid/internal/cmdb/biz/ci"
	citypebiz "github.com/ongridio/ongrid/internal/cmdb/biz/citype"
	cmdbmodel "github.com/ongridio/ongrid/internal/cmdb/model"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
)

// Creating the models a feature addresses by name, against a real database.
//
// NOTHING IN THE PRODUCT DOES THIS. cantor's deployment either had `dcim_rack`
// or its DCIM pages answered 404, and the names were tribal knowledge: four
// names, a dozen attributes and which of them are numeric, written down
// nowhere. The port keeps resolving them by name, so the property under test
// here is that the bootstrap and the resolver agree — and that running the
// bootstrap on a deployment that already has some of it changes nothing.

func newBuiltinUsecase(t *testing.T) *citypebiz.Usecase {
	t.Helper()
	repo, _ := newWriteRepo(t)
	return citypebiz.NewUsecase(repo, nil)
}

func TestEnsureBuiltinModelsCreatesThenLeavesAlone(t *testing.T) {
	uc := newBuiltinUsecase(t)
	ctx := context.Background()

	first, err := uc.EnsureBuiltinModels(ctx, citypebiz.BuiltinEnsureInput{
		Models: cibiz.DCIMBuiltinModels(),
	})
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	if len(first.Created) == 0 {
		t.Fatal("the first call created nothing")
	}
	// The attribute dictionary is SHARED, so the first call can legitimately
	// find one already there: `u_count` is created for the device side before
	// the rack asks for it, and the rack reuses it.
	if !containsString(first.Existing, "attribute "+cibiz.AttrUnitCount) {
		t.Fatalf("the shared attribute was not reused across the passes: %v", first.Existing)
	}
	// Every model and every attribute it needs is reported BY NAME, so an
	// operator can see what the call did without reading the database.
	for _, name := range []string{
		"model dcim_region", "model dcim_idc", "model dcim_server_room", "model dcim_rack",
		"attribute rack_name", "attribute u_count", "attribute free_u_count",
		"attribute u_slot_abnormal",
	} {
		if !containsString(first.Created, name) {
			t.Fatalf("%q was not created: %v", name, first.Created)
		}
	}
	// The device-side attributes are created in the dictionary and bound to
	// nothing: which models are devices is the deployment's decision, and a
	// bootstrap that guessed would bind attributes to models it invented.
	if !containsString(first.Created, "attribute u_start") {
		t.Fatalf("the device-side attributes were not created: %v", first.Created)
	}

	second, err := uc.EnsureBuiltinModels(ctx, citypebiz.BuiltinEnsureInput{
		Models: cibiz.DCIMBuiltinModels(),
	})
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if len(second.Created) != 0 {
		t.Fatalf("the second call created %v; the bootstrap is not idempotent", second.Created)
	}
	// Everything the first call touched — what it created plus what it found —
	// is what the second call finds.
	if want := len(first.Created) + len(first.Existing); len(second.Existing) != want {
		t.Fatalf("the second call found %d of the %d the first left behind",
			len(second.Existing), want)
	}
}

// The relation bootstrap is what makes the write gate safe on a fresh install:
// without it, AssignAddresses and CreateSubnet have no rule to resolve. It is
// idempotent, and it must create the structural ipam_subnet -> ipam_subnet
// self-rule that the public API refuses by default.
func TestEnsureBuiltinRelationsCreatesThenLeavesAlone(t *testing.T) {
	uc := newBuiltinUsecase(t)
	ctx := context.Background()
	in := citypebiz.BuiltinEnsureInput{
		Models:    append(cibiz.DCIMBuiltinModels(), cibiz.IPAMBuiltinModels()...),
		Relations: append(cibiz.DCIMBuiltinRelations(), cibiz.IPAMBuiltinRelations()...),
	}

	first, err := uc.EnsureBuiltinModels(ctx, in)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	want := []string{
		"relation dcim_region->dcim_idc",
		"relation dcim_idc->dcim_server_room",
		"relation dcim_server_room->dcim_rack",
		"relation ipam_scope->ipam_subnet",
		"relation ipam_subnet->ipam_subnet",
		"relation ipam_subnet->ipam_address",
	}
	for _, label := range want {
		if !containsString(first.Created, label) {
			t.Fatalf("%q was not created: %v", label, first.Created)
		}
	}

	second, err := uc.EnsureBuiltinModels(ctx, in)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if len(second.Created) != 0 {
		t.Fatalf("the second call created %v; the relation bootstrap is not idempotent", second.Created)
	}
	for _, label := range want {
		if !containsString(second.Existing, label) {
			t.Fatalf("%q was not reported as existing: %v", label, second.Existing)
		}
	}

	// The self-rule must be usable by the resolver the IPAM code is injected
	// with, not merely present as a row.
	subnet, err := uc.GetByRef(ctx, string(cibiz.ModelIPAMSubnet))
	if err != nil || subnet == nil {
		t.Fatalf("resolve ipam_subnet: %v", err)
	}
	rules, err := uc.ListTypeRelations(ctx, citypebiz.TypeRelationFilter{})
	if err != nil {
		t.Fatal(err)
	}
	foundSelf := false
	for _, rule := range rules {
		if rule.Parent.Type.Type.ID == subnet.Type.ID && rule.Child.Type.Type.ID == subnet.Type.ID {
			foundSelf = true
		}
	}
	if !foundSelf {
		t.Fatal("the ipam_subnet -> ipam_subnet self-rule was not created")
	}
}

// The built-in rules use the post-split vocabulary and create its semantics, so
// a bootstrapped database can accept instance edges immediately — the write
// gate refuses a deprecated word such as `contain` on a migrated deployment.
func TestBuiltinRelationsUseTheTargetVocabulary(t *testing.T) {
	repo, db := newWriteRepo(t)
	uc := citypebiz.NewUsecase(repo, nil)
	ctx := context.Background()
	in := citypebiz.BuiltinEnsureInput{
		Models:    append(cibiz.DCIMBuiltinModels(), cibiz.IPAMBuiltinModels()...),
		Relations: append(cibiz.DCIMBuiltinRelations(), cibiz.IPAMBuiltinRelations()...),
	}
	if _, err := uc.EnsureBuiltinModels(ctx, in); err != nil {
		t.Fatal(err)
	}

	var got []struct {
		Parent string
		Child  string
		Rel    string
	}
	if err := db.Table("c_ci_type_relations AS tr").
		Select("p.name AS parent, c.name AS child, rt.name AS rel").
		Joins("JOIN c_ci_types p ON p.id = tr.parent_id").
		Joins("JOIN c_ci_types c ON c.id = tr.child_id").
		Joins("JOIN c_relation_types rt ON rt.id = tr.relation_type_id").
		Where("tr.delete_marker = 0 AND tr.deleted_at IS NULL").
		Scan(&got).Error; err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"dcim_region->dcim_idc":       "HAS_LOCATION",
		"dcim_idc->dcim_server_room":  "HAS_LOCATION",
		"dcim_server_room->dcim_rack": "HAS_LOCATION",
		"ipam_scope->ipam_subnet":     "CONTAINS",
		"ipam_subnet->ipam_subnet":    "CONTAINS",
		"ipam_subnet->ipam_address":   "ALLOCATES",
	}
	seen := map[string]string{}
	for _, row := range got {
		seen[row.Parent+"->"+row.Child] = row.Rel
	}
	for pair, rel := range want {
		if seen[pair] != rel {
			t.Fatalf("%s uses %q, want %q (all: %+v)", pair, seen[pair], rel, seen)
		}
	}

	for name, inverse := range map[string]string{
		"HAS_LOCATION": "LOCATED_IN", "CONTAINS": "PART_OF", "ALLOCATES": "ALLOCATED_TO",
	} {
		var rt citypemodel.RelationType
		if err := db.Where("name = ?", name).First(&rt).Error; err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if rt.InverseOf != inverse || rt.Revision != 1 || rt.WeightDefault != 0 {
			t.Fatalf("%s = %+v, want inverse %q, revision 1, weight 0", name, rt, inverse)
		}
	}
	var contains citypemodel.RelationType
	if err := db.Where("name = ?", "CONTAINS").First(&contains).Error; err != nil {
		t.Fatal(err)
	}
	if !contains.Transitive {
		t.Fatal("CONTAINS must be transitive")
	}
}

// The models the bootstrap creates are the ones the DCIM code RESOLVES, which
// is the only thing that makes the two halves meet: a model created under the
// right name but without `u_count` is a rack every operation refuses.
func TestEnsuredModelsResolveForDCIM(t *testing.T) {
	uc := newBuiltinUsecase(t)
	ctx := context.Background()
	if _, err := uc.EnsureBuiltinModels(ctx, citypebiz.BuiltinEnsureInput{
		Models: cibiz.DCIMBuiltinModels(),
	}); err != nil {
		t.Fatal(err)
	}

	// The resolver is the same adapter the instance layer is injected with, so
	// this is the check the DCIM code itself makes.
	resolver := citypebiz.NewCIResolver(uc)
	for _, spec := range cibiz.DCIMBuiltinModels() {
		set, err := resolver.ResolveForCI(ctx, spec.Name)
		if err != nil {
			t.Fatalf("resolve %s: %v", spec.Name, err)
		}
		if set == nil {
			t.Fatalf("%s was created but does not resolve", spec.Name)
		}
		if set.UniqueAttrID == 0 || set.UniqueAttr.Name != spec.UniqueKey {
			t.Fatalf("%s's identifying attribute = %q, want %q", spec.Name, set.UniqueAttr.Name, spec.UniqueKey)
		}
		for _, attr := range spec.Attributes {
			if _, ok := set.ByName[attr.Name]; !ok {
				t.Fatalf("%s does not carry %s", spec.Name, attr.Name)
			}
		}
	}
}

// A device model the operator binds the placement attributes to resolves them,
// which is what makes a rack able to hold anything.
func TestDeviceAttributesAreBindable(t *testing.T) {
	uc := newBuiltinUsecase(t)
	ctx := context.Background()
	if _, err := uc.EnsureBuiltinModels(ctx, citypebiz.BuiltinEnsureInput{
		Models: cibiz.DCIMBuiltinModels(),
	}); err != nil {
		t.Fatal(err)
	}

	// A device model of the operator's own, created the ordinary way.
	if _, err := uc.Create(ctx, citypebiz.CreateInput{
		Name: "server", Alias: "server", UniqueKey: "region_name",
	}); err != nil {
		t.Fatalf("create the device model: %v", err)
	}
	start, err := uc.GetAttribute(ctx, cibiz.AttrUnitStart)
	if err != nil || start == nil {
		t.Fatalf("the device-side attribute u_start is missing: %v", err)
	}
	if _, err := uc.BindAttributes(ctx, citypebiz.BindAttributesInput{
		TypeRef: "server", AttrIDs: []cmdbmodel.ID{start.ID},
	}); err != nil {
		t.Fatalf("bind: %v", err)
	}

	set, err := citypebiz.NewCIResolver(uc).ResolveForCI(ctx, "server")
	if err != nil || set == nil {
		t.Fatalf("resolve the device model: %v", err)
	}
	if _, ok := set.ByName[cibiz.AttrUnitStart]; !ok {
		t.Fatalf("the device model does not carry %s after binding", cibiz.AttrUnitStart)
	}
}

func containsString(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

// The IPAM bootstrap creates the models and attributes the IPAM feature
// resolves — including the console's `name` contract and the address fields
// the editor writes. A model created without them answers "unknown attribute"
// on the first save.
func TestEnsuredModelsResolveForIPAM(t *testing.T) {
	uc := newBuiltinUsecase(t)
	ctx := context.Background()
	if _, err := uc.EnsureBuiltinModels(ctx, citypebiz.BuiltinEnsureInput{
		Models: cibiz.IPAMBuiltinModels(),
	}); err != nil {
		t.Fatal(err)
	}

	resolver := citypebiz.NewCIResolver(uc)
	for _, spec := range cibiz.IPAMBuiltinModels() {
		set, err := resolver.ResolveForCI(ctx, spec.Name)
		if err != nil {
			t.Fatalf("resolve %s: %v", spec.Name, err)
		}
		if set == nil {
			t.Fatalf("%s was created but does not resolve", spec.Name)
		}
		if set.UniqueAttr.Name != spec.UniqueKey {
			t.Fatalf("%s identifies by %q, want %q", spec.Name, set.UniqueAttr.Name, spec.UniqueKey)
		}
		for _, attr := range spec.Attributes {
			if _, ok := set.ByName[attr.Name]; !ok {
				t.Fatalf("%s does not carry %s", spec.Name, attr.Name)
			}
		}
	}
}

// The RFC-011 template: three layers, their identity attributes, and the
// CONTAINS / HAS_INSTANCE / CALLS spine. CALLS is a model self-pair and must be
// created with AllowSelf; the public API still refuses one by default.
func TestServiceBuiltinModelsCreateTheThreeLayers(t *testing.T) {
	repo, db := newWriteRepo(t)
	uc := citypebiz.NewUsecase(repo, nil)
	ctx := context.Background()
	in := citypebiz.BuiltinEnsureInput{
		Models:    cibiz.ServiceBuiltinModels(),
		Relations: cibiz.ServiceBuiltinRelations(),
	}

	first, err := uc.EnsureBuiltinModels(ctx, in)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	for _, label := range []string{
		"model business_service", "model application_service", "model service_instance",
		"relation business_service->application_service",
		"relation application_service->service_instance",
		"relation application_service->application_service",
	} {
		if !containsString(first.Created, label) {
			t.Fatalf("%q was not created: %v", label, first.Created)
		}
	}

	// The resolver is what the instance layer uses; a model without its
	// identity attribute is a model every write refuses.
	resolver := citypebiz.NewCIResolver(uc)
	for _, spec := range cibiz.ServiceBuiltinModels() {
		set, err := resolver.ResolveForCI(ctx, spec.Name)
		if err != nil || set == nil {
			t.Fatalf("resolve %s: %v", spec.Name, err)
		}
		if set.UniqueAttr.Name != spec.UniqueKey {
			t.Fatalf("%s identifies by %q, want %q", spec.Name, set.UniqueAttr.Name, spec.UniqueKey)
		}
		for _, attr := range spec.Attributes {
			if _, ok := set.ByName[attr.Name]; !ok {
				t.Fatalf("%s does not carry %s", spec.Name, attr.Name)
			}
		}
	}

	var rules []struct {
		Parent string
		Child  string
		Rel    string
	}
	if err := db.Table("c_ci_type_relations AS tr").
		Select("p.name AS parent, c.name AS child, rt.name AS rel").
		Joins("JOIN c_ci_types p ON p.id = tr.parent_id").
		Joins("JOIN c_ci_types c ON c.id = tr.child_id").
		Joins("JOIN c_relation_types rt ON rt.id = tr.relation_type_id").
		Where("tr.delete_marker = 0 AND tr.deleted_at IS NULL").
		Scan(&rules).Error; err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"business_service->application_service":    "CONTAINS",
		"application_service->service_instance":    "HAS_INSTANCE",
		"application_service->application_service": "CALLS",
	}
	seen := map[string]string{}
	for _, rule := range rules {
		seen[rule.Parent+"->"+rule.Child] = rule.Rel
	}
	for pair, rel := range want {
		if seen[pair] != rel {
			t.Fatalf("%s uses %q, want %q (rules %+v)", pair, seen[pair], rel, rules)
		}
	}

	var calls citypemodel.RelationType
	if err := db.Where("name = ?", "CALLS").First(&calls).Error; err != nil {
		t.Fatalf("CALLS type: %v", err)
	}
	if calls.Direction != "dst_to_src" || !calls.PropagatesDefault || calls.WeightDefault != 0.9 {
		t.Fatalf("CALLS semantics = %+v", calls)
	}
	var hasInstance citypemodel.RelationType
	if err := db.Where("name = ?", "HAS_INSTANCE").First(&hasInstance).Error; err != nil {
		t.Fatalf("HAS_INSTANCE type: %v", err)
	}
	if hasInstance.InverseOf != "INSTANCE_OF" || hasInstance.WeightDefault != 0 {
		t.Fatalf("HAS_INSTANCE semantics = %+v", hasInstance)
	}

	second, err := uc.EnsureBuiltinModels(ctx, in)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if len(second.Created) != 0 {
		t.Fatalf("second call created %v; the bootstrap is not idempotent", second.Created)
	}
}
