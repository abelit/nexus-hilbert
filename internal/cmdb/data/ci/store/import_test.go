package store

import (
	"context"
	"strings"
	"testing"

	cibiz "github.com/ongridio/ongrid/internal/cmdb/biz/ci"
	model "github.com/ongridio/ongrid/internal/cmdb/model"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
)

// The sheet import against a database.
//
// WHAT IS TESTED HERE IS WHAT A PREVIEW AND A COMMIT DO that makes an import
// differ from a loop of instance writes: one transaction, rows that see each
// other, and a preview that agrees with the commit.

func newImportFixture(t *testing.T) (*cibiz.Usecase, *Repo) {
	t.Helper()
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := db.AutoMigrate(
		&citypemodel.CIType{}, &citypemodel.Attribute{}, &citypemodel.CITypeAttribute{},
		&citypemodel.RelationType{}, &citypemodel.CITypeRelation{},
	); err != nil {
		t.Fatalf("migrate dictionary: %v", err)
	}

	// Two models: the one being imported, and the parent a relation column
	// names. The rack model carries a text identifier the sheet can use.
	ct := citypemodel.CIType{Name: "host", Alias: "主机", UniqueID: 1, Enabled: true}
	ct.ID = 1
	if err := db.Create(&ct).Error; err != nil {
		t.Fatal(err)
	}
	rack := citypemodel.CIType{Name: "rack", Alias: "机柜", UniqueID: 4, Enabled: true}
	rack.ID = 2
	if err := db.Create(&rack).Error; err != nil {
		t.Fatal(err)
	}
	for id, spec := range map[model.ID]struct {
		typeID   model.ID
		name, vt string
	}{
		1: {1, "hostname", "2"},
		2: {1, "cpu", "0"},
		3: {1, "note", "2"},
		4: {2, "rack_code", "2"},
	} {
		attr := citypemodel.Attribute{Name: spec.name, Alias: spec.name, ValueType: spec.vt, IsIndex: true}
		attr.ID = id
		if err := db.Create(&attr).Error; err != nil {
			t.Fatal(err)
		}
		binding := citypemodel.CITypeAttribute{TypeID: spec.typeID, AttrID: id}
		if err := db.Create(&binding).Error; err != nil {
			t.Fatal(err)
		}
	}
	relationType := citypemodel.RelationType{Name: "running_on", Color: "#1890ff"}
	relationType.ID = 1
	if err := db.Create(&relationType).Error; err != nil {
		t.Fatal(err)
	}
	constraint := "2"
	relation := citypemodel.CITypeRelation{
		ParentID: 2, ChildID: 1, RelationTypeID: 1, Constraint: &constraint,
	}
	if err := db.Create(&relation).Error; err != nil {
		t.Fatal(err)
	}

	repo := NewRepo(db)
	return cibiz.NewUsecase(repo, &hostResolver{}, nil), repo
}

// hostResolver answers the model side for the import fixture's two models.
type hostResolver struct{}

func (hostResolver) ResolveForCI(_ context.Context, ref string) (*cibiz.AttributeSet, error) {
	if ref == "host" || ref == "1" {
		return hostSet(), nil
	}
	if ref == "rack" || ref == "2" {
		return rackSet(), nil
	}
	return nil, nil
}

func hostSet() *cibiz.AttributeSet {
	ct := citypemodel.CIType{Name: "host", Alias: "主机", UniqueID: 1, Enabled: true}
	ct.ID = 1
	specs := map[model.ID]cibiz.AttributeSpec{
		1: {ID: 1, Name: "hostname", Alias: "hostname", ValueType: "2", IsIndex: true, IsUnique: true},
		2: {ID: 2, Name: "cpu", Alias: "cpu", ValueType: "0", IsIndex: true},
		3: {ID: 3, Name: "note", Alias: "note", ValueType: "2"},
	}
	return attributeSet(ct, 1, specs)
}

func rackSet() *cibiz.AttributeSet {
	ct := citypemodel.CIType{Name: "rack", Alias: "机柜", UniqueID: 4, Enabled: true}
	ct.ID = 2
	specs := map[model.ID]cibiz.AttributeSpec{
		4: {ID: 4, Name: "rack_code", Alias: "机柜编号", ValueType: "2", IsIndex: true, IsUnique: true},
	}
	return attributeSet(ct, 4, specs)
}

func attributeSet(ct citypemodel.CIType, uniqueID model.ID, specs map[model.ID]cibiz.AttributeSpec) *cibiz.AttributeSet {
	set := &cibiz.AttributeSet{
		Type: ct, Specs: specs,
		ByName: map[string]model.ID{}, ByAlias: map[string]model.ID{},
		UniqueAttrID: uniqueID, UniqueAttr: specs[uniqueID], ShowAttr: specs[uniqueID],
	}
	for id, spec := range specs {
		set.ByName[spec.Name] = id
		set.ByAlias[spec.Alias] = id
	}
	return set
}

func (hostResolver) ResolveForCIAlias(_ context.Context, alias string) (*cibiz.AttributeSet, error) {
	switch alias {
	case "主机":
		return hostSet(), nil
	case "机柜":
		return rackSet(), nil
	default:
		return nil, nil
	}
}

func (hostResolver) RelationBetween(_ context.Context, parentTypeID, childTypeID model.ID) (cibiz.TypeRelationRule, bool, error) {
	if parentTypeID == 2 && childTypeID == 1 {
		return cibiz.TypeRelationRule{RelationTypeID: 1, Constraint: "2", RelationTypeName: "running_on"}, true, nil
	}
	return cibiz.TypeRelationRule{}, false, nil
}

func (hostResolver) HierarchyLevels(context.Context, model.ID, int, bool) (cibiz.HierarchyLevels, error) {
	return cibiz.HierarchyLevels{}, nil
}

func importSheet(policy cibiz.ExistPolicy, rows ...[]any) cibiz.ImportRequest {
	return cibiz.ImportRequest{
		TypeRef:     "host",
		Headers:     []string{"hostname", "cpu", "note"},
		Rows:        rows,
		ExistPolicy: policy,
	}
}

func TestImportPreviewWritesNothing(t *testing.T) {
	uc, _ := newImportFixture(t)
	ctx := context.Background()

	got, err := uc.PreviewImport(ctx, importSheet(cibiz.ExistReject,
		[]any{"web-01", "8", "first"},
		[]any{"web-02", "not-a-number", ""},
	))
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if got.Total != 2 || got.Valid != 1 || got.Invalid != 1 || got.Creates != 1 {
		t.Fatalf("preview = %+v", got)
	}
	if got.Rows[1].OK || len(got.Rows[1].Issues) == 0 {
		t.Fatalf("the bad row was not reported: %+v", got.Rows[1])
	}
	// NOTHING WAS WRITTEN, which is what makes a preview a preview.
	list, err := uc.Search(ctx, cibiz.SearchRequest{Query: "_type:host"})
	if err != nil {
		t.Fatal(err)
	}
	if list.NumFound != 0 {
		t.Fatalf("the preview wrote %d instances", list.NumFound)
	}
}

// Under `replace`, a row whose identifier is new is a CREATE in both the row
// and the counts. The policy says what to do when an instance exists; it does
// not describe a row that will insert one.
func TestImportPreviewReportsACreateUnderReplace(t *testing.T) {
	uc, _ := newImportFixture(t)
	ctx := context.Background()

	got, err := uc.PreviewImport(ctx, importSheet(cibiz.ExistReplace, []any{"web-01", "8", ""}))
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if got.Creates != 1 || got.Updates != 0 {
		t.Fatalf("preview counts = %+v", got)
	}
	if got.Rows[0].Action != "create" {
		t.Fatalf("row action = %q, want create", got.Rows[0].Action)
	}
}

func TestImportCommitIsOneTransaction(t *testing.T) {
	uc, _ := newImportFixture(t)
	ctx := context.Background()

	// A GOOD ROW FOLLOWED BY A BAD ONE. cantor's browser loop wrote the first
	// and reported the second, leaving an operator to reconcile the sheet
	// against a half-imported model.
	_, err := uc.CommitImport(ctx, importSheet(cibiz.ExistReject,
		[]any{"web-01", "8", ""},
		[]any{"web-02", "not-a-number", ""},
	))
	if err == nil {
		t.Fatal("a sheet with an unwritable row was committed")
	}
	// The refusal NAMES the row, because "one of your five thousand rows is
	// wrong" is not a thing anybody can act on.
	if !strings.Contains(err.Error(), "row 3") {
		t.Fatalf("the refusal does not say which row: %v", err)
	}
	list, searchErr := uc.Search(context.Background(), cibiz.SearchRequest{Query: "_type:host"})
	if searchErr != nil {
		t.Fatal(searchErr)
	}
	if list.NumFound != 0 {
		t.Fatalf("the refused import wrote %d instances", list.NumFound)
	}
}

func TestImportCommitWritesTheSheet(t *testing.T) {
	uc, _ := newImportFixture(t)
	ctx := context.Background()

	got, err := uc.CommitImport(ctx, importSheet(cibiz.ExistReject,
		[]any{"web-01", "8", "first"},
		[]any{"web-02", 4, ""},
	))
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	if got.Written != 2 || got.Creates != 2 || got.Updates != 0 {
		t.Fatalf("result = %+v", got)
	}
	for _, row := range got.Rows {
		if row.InstanceID == 0 {
			t.Fatalf("a written row has no instance id: %+v", row)
		}
	}

	list, err := uc.Search(ctx, cibiz.SearchRequest{Query: "_type:host,cpu:8"})
	if err != nil {
		t.Fatal(err)
	}
	if list.NumFound != 1 {
		t.Fatalf("cpu:8 matched %d, want the one row that carries a numeric 8", list.NumFound)
	}

	// A SECOND IMPORT OF THE SAME SHEET is refused under the create policy,
	// and the refusal names the row rather than the sheet.
	_, err = uc.CommitImport(ctx, importSheet(cibiz.ExistReject, []any{"web-01", "9", ""}))
	if err == nil {
		t.Fatal("a duplicate import was accepted")
	}
	if !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("err = %v", err)
	}

	// Under `replace` the same sheet updates, and the preview says so first.
	preview, err := uc.PreviewImport(ctx, importSheet(cibiz.ExistReplace, []any{"web-01", "9", ""}))
	if err != nil {
		t.Fatal(err)
	}
	if preview.Updates != 1 || preview.Creates != 0 {
		t.Fatalf("preview = %+v", preview)
	}
	done, err := uc.CommitImport(ctx, importSheet(cibiz.ExistReplace, []any{"web-01", "9", ""}))
	if err != nil {
		t.Fatalf("replace: %v", err)
	}
	if done.Updates != 1 || done.Creates != 0 {
		t.Fatalf("result = %+v", done)
	}
}

// ROWS SEE EACH OTHER, because they are one transaction.
//
// A sheet that adds a column to rows it also creates must resolve the second
// occurrence against the first row's insert. cantor's per-row requests could
// not: each was its own transaction, so the second row's lookup did not see the
// first's.
func TestImportRowsSeeEachOther(t *testing.T) {
	uc, _ := newImportFixture(t)
	ctx := context.Background()

	got, err := uc.CommitImport(ctx, importSheet(cibiz.ExistReplace,
		[]any{"web-01", "4", "first"},
		[]any{"web-01", "8", "second"},
	))
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	if got.Creates != 1 || got.Updates != 1 {
		t.Fatalf("result = %+v; the second row should update the first row's instance", got)
	}
	if got.Rows[0].InstanceID != got.Rows[1].InstanceID {
		t.Fatalf("the two rows are different instances: %d and %d",
			got.Rows[0].InstanceID, got.Rows[1].InstanceID)
	}
	inst, err := uc.Get(ctx, got.Rows[1].InstanceID, []string{"cpu", "note"}, cibiz.RetKeyName)
	if err != nil {
		t.Fatal(err)
	}
	if inst.Values["note"] != "second" || inst.Values["cpu"] == nil {
		t.Fatalf("the last row did not win: %v", inst.Values)
	}
}

// A relation column resolves its parent values in the preview, and the commit
// writes the edge in the SAME transaction as the child instance.
func TestImportRelationColumnsWriteEdges(t *testing.T) {
	uc, repo := newImportFixture(t)
	ctx := context.Background()

	parent, err := uc.Create(ctx, cibiz.WriteRequest{
		TypeRef: "rack",
		Values:  map[string]any{"rack_code": "R-A01"},
	})
	if err != nil {
		t.Fatalf("create rack: %v", err)
	}

	req := cibiz.ImportRequest{
		TypeRef: "host",
		Headers: []string{"hostname", "$rack.rack_code"},
		Rows:    [][]any{{"web-01", "R-A01"}},
	}
	preview, err := uc.PreviewImport(ctx, req)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if preview.Valid != 1 || preview.Invalid != 0 || len(preview.Relations) != 1 {
		t.Fatalf("preview = %+v", preview)
	}
	rel := preview.Relations[0]
	if !rel.Matched || rel.ParentType != "rack" || rel.Attr != "rack_code" || rel.RelationTypeID != 1 {
		t.Fatalf("relation column = %+v", rel)
	}
	if len(preview.Rows[0].Parents) != 1 || preview.Rows[0].Parents[0].ParentID != parent.CIID {
		t.Fatalf("the row did not resolve its parent: %+v", preview.Rows[0].Parents)
	}

	done, err := uc.CommitImport(ctx, req)
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	if done.Written != 1 {
		t.Fatalf("written = %d", done.Written)
	}
	edges, total, err := repo.RelationsTo(ctx, done.Rows[0].InstanceID, 0, 10, 0)
	if err != nil {
		t.Fatalf("read relations: %v", err)
	}
	if total != 1 || len(edges) != 1 {
		t.Fatalf("relations = %d/%d, want one", total, len(edges))
	}
	if edges[0].FirstCIID != parent.CIID || edges[0].SecondCIID != done.Rows[0].InstanceID {
		t.Fatalf("edge = %+v", edges[0])
	}
}

// A relation header may address the parent model by its display alias, which
// is what cantor's templates wrote. The generated template uses the model name,
// but an edited header must still work.
func TestImportRelationColumnAddressesAParentAlias(t *testing.T) {
	uc, _ := newImportFixture(t)
	ctx := context.Background()

	parent, err := uc.Create(ctx, cibiz.WriteRequest{
		TypeRef: "rack",
		Values:  map[string]any{"rack_code": "R-A01"},
	})
	if err != nil {
		t.Fatalf("create rack: %v", err)
	}
	preview, err := uc.PreviewImport(ctx, cibiz.ImportRequest{
		TypeRef: "host",
		Headers: []string{"hostname", "$机柜.机柜编号"},
		Rows:    [][]any{{"web-01", "R-A01"}},
	})
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if preview.Valid != 1 || len(preview.Relations) != 1 {
		t.Fatalf("preview = %+v", preview)
	}
	if preview.Relations[0].ParentType != "rack" || preview.Relations[0].Note == "" {
		t.Fatalf("relation column = %+v", preview.Relations[0])
	}
	if len(preview.Rows[0].Parents) != 1 || preview.Rows[0].Parents[0].ParentID != parent.CIID {
		t.Fatalf("parent = %+v", preview.Rows[0].Parents)
	}
}

// A relation cell naming no parent makes its row invalid instead of importing
// the instance without the edge the sheet asked for.
func TestImportRelationColumnReportsUnknownParents(t *testing.T) {
	uc, _ := newImportFixture(t)
	ctx := context.Background()

	preview, err := uc.PreviewImport(ctx, cibiz.ImportRequest{
		TypeRef: "host",
		Headers: []string{"hostname", "$rack.rack_code"},
		Rows:    [][]any{{"web-01", "R-NOPE"}},
	})
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if preview.Invalid != 1 || preview.Rows[0].OK {
		t.Fatalf("preview = %+v", preview)
	}
	issues := preview.Rows[0].Issues
	if len(issues) != 1 || !strings.Contains(issues[0].Message, "no rack instance") {
		t.Fatalf("issues = %+v", issues)
	}
}

// A relation header that cannot be resolved is a refusal, not a silently
// ignored column: the sheet would otherwise import instances with no relation.
func TestImportRefusesUnresolvableRelationColumns(t *testing.T) {
	uc, _ := newImportFixture(t)
	ctx := context.Background()

	for _, header := range []string{"$", "$rack", "$missing.rack_code", "$rack.missing", "$host.hostname"} {
		_, err := uc.PreviewImport(ctx, cibiz.ImportRequest{
			TypeRef: "host",
			Headers: []string{"hostname", header},
			Rows:    [][]any{{"web-01", "x"}},
		})
		if err == nil {
			t.Fatalf("header %q was accepted", header)
		}
	}
}

// A sheet whose headers match nothing, and one that identifies nothing, are
// refused before any row is examined.
func TestImportRefusesAnUnusableSheet(t *testing.T) {
	uc, _ := newImportFixture(t)
	ctx := context.Background()

	_, err := uc.PreviewImport(ctx, cibiz.ImportRequest{
		TypeRef: "host", Headers: []string{"a", "b"}, Rows: [][]any{{"1", "2"}},
	})
	if err == nil {
		t.Fatal("a sheet whose columns match nothing was accepted")
	}

	_, err = uc.PreviewImport(ctx, cibiz.ImportRequest{
		TypeRef: "host", Headers: []string{"cpu"}, Rows: [][]any{{"8"}},
	})
	if err == nil {
		t.Fatal("a sheet with no identifier column was accepted")
	}
	if !strings.Contains(err.Error(), "hostname") {
		t.Fatalf("the refusal does not name the missing identifier: %v", err)
	}

	// The row and column limits are refusals, not truncations.
	wide := make([]string, cibiz.MaxImportColumns+1)
	for i := range wide {
		wide[i] = "cpu"
	}
	if _, err := uc.PreviewImport(ctx, cibiz.ImportRequest{
		TypeRef: "host", Headers: wide, Rows: [][]any{{"1"}},
	}); err == nil {
		t.Fatal("an over-wide sheet was accepted")
	}
}
