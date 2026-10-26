package history

import (
	"context"
	"testing"
	"time"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
)

// The history read paths: grouping a page of changes under their operation
// record, and naming what the ids refer to.
//
// THE STORE IS A DOUBLE HERE because its job is one joined query per table; what
// this file settles is the shape a console page consumes — one row per write,
// with the changes underneath it and the labels a person can read.

type stubRepo struct {
	attributes []AttributeRow
	relations  []RelationRow
	types      []TypeRow
	triggers   []TriggerRow

	lastAttributeFilter AttributeFilter
	lastRelationFilter  RelationFilter
	lastTypeFilter      TypeFilter
	lastTriggerFilter   TriggerFilter
	lastCIPage          [2]int
}

func (s *stubRepo) ListAttributeRecords(_ context.Context, f AttributeFilter) ([]AttributeRow, int64, error) {
	s.lastAttributeFilter = f
	return s.attributes, int64(len(s.attributes)), nil
}

func (s *stubRepo) ListRelationRecords(_ context.Context, f RelationFilter) ([]RelationRow, int64, error) {
	s.lastRelationFilter = f
	return s.relations, int64(len(s.relations)), nil
}

func (s *stubRepo) ListTypeRecords(_ context.Context, f TypeFilter) ([]TypeRow, int64, error) {
	s.lastTypeFilter = f
	return s.types, int64(len(s.types)), nil
}

func (s *stubRepo) ListTriggerRecords(_ context.Context, f TriggerFilter) ([]TriggerRow, int64, error) {
	s.lastTriggerFilter = f
	return s.triggers, int64(len(s.triggers)), nil
}

func (s *stubRepo) ListCIAttributeRecords(_ context.Context, _ model.ID, page, size int) ([]AttributeRow, int64, error) {
	s.lastCIPage = [2]int{page, size}
	return s.attributes, int64(len(s.attributes)), nil
}

func (s *stubRepo) ListCITriggerRecords(_ context.Context, _ model.ID, page, size int) ([]TriggerRow, int64, error) {
	s.lastCIPage = [2]int{page, size}
	return s.triggers, int64(len(s.triggers)), nil
}

type stubTypeNames map[model.ID]string

func (s stubTypeNames) TypeName(_ context.Context, id model.ID) (string, string, error) {
	name := s[id]
	return name, name + " alias", nil
}

type stubAttributes map[model.ID][]AttributeRef

func (s stubAttributes) ResolveAttributes(_ context.Context, typeID model.ID) ([]AttributeRef, error) {
	return s[typeID], nil
}

type stubCINames map[model.ID]string

func (s stubCINames) ResolveCINames(_ context.Context, ids []model.ID) (map[model.ID]string, error) {
	out := map[model.ID]string{}
	for _, id := range ids {
		if name, ok := s[id]; ok {
			out[id] = name
		}
	}
	return out, nil
}

func ptr[T any](v T) *T { return &v }

func timeAt(hour int) time.Time {
	return time.Date(2026, 10, 26, hour, 0, 0, 0, time.UTC)
}

func fixtureUseCase(repo *stubRepo) *Usecase {
	return NewUsecase(repo).
		WithTypeNames(stubTypeNames{1: "host", 2: "switch"}).
		WithAttributes(stubAttributes{
			1: []AttributeRef{
				{ID: 10, Name: "hostname", Alias: "主机名", ValueType: "2"},
				{ID: 11, Name: "cpu", Alias: "CPU", ValueType: "3"},
			},
		}).
		WithCINames(stubCINames{100: "web-01", 101: "sw-01"})
}

func TestAttributeHistoryGroupsChangesUnderTheirRecord(t *testing.T) {
	repo := &stubRepo{attributes: []AttributeRow{
		{
			Record: Record{ID: 2, UID: 7, TypeID: 1, Origin: "ui", CreatedAt: timeAt(11)},
			ID:     20, OperateType: "u", CIID: 100, AttrID: 10,
			Old: ptr("web-00"), New: ptr("web-01"),
		},
		{
			Record: Record{ID: 2, UID: 7, TypeID: 1, Origin: "ui", CreatedAt: timeAt(11)},
			ID:     19, OperateType: "u", CIID: 100, AttrID: 11,
			Old: ptr("4"), New: ptr("8"),
		},
		{
			Record: Record{ID: 1, UID: 8, TypeID: 1, Origin: "import", CreatedAt: timeAt(10)},
			ID:     18, OperateType: "a", CIID: 100, AttrID: 10,
			New: ptr("web-00"),
		},
	}}
	got, err := fixtureUseCase(repo).ListAttributes(context.Background(), AttributeFilter{Page: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("ListAttributes: %v", err)
	}
	if len(got.Items) != 2 || got.Total != 3 {
		t.Fatalf("page = %+v, want 2 groups over 3 changes", got)
	}
	first := got.Items[0]
	if first.RecordID != 2 || first.UID != 7 || first.TypeName != "host" || first.Origin != "ui" {
		t.Fatalf("first record = %+v", first)
	}
	if len(first.Changes) != 2 {
		t.Fatalf("first record changes = %+v, want 2", first.Changes)
	}
	if first.Changes[0].AttrName != "hostname" || first.Changes[0].AttrAlias != "主机名" ||
		first.Changes[0].CIName != "web-01" || first.Changes[0].ValueType != "2" {
		t.Fatalf("first change = %+v", first.Changes[0])
	}
	if first.Changes[0].Old != "web-00" || first.Changes[0].New != "web-01" {
		t.Fatalf("old/new = %q/%q", first.Changes[0].Old, first.Changes[0].New)
	}
	if first.CreatedAt != "2026-10-26 11:00:00" {
		t.Fatalf("created_at = %q", first.CreatedAt)
	}
}

func TestHistoryFiltersReachTheStoreAndPagesAreClamped(t *testing.T) {
	repo := &stubRepo{}
	uc := fixtureUseCase(repo)
	start := timeAt(9)

	_, err := uc.ListAttributes(context.Background(), AttributeFilter{
		Start: start, End: timeAt(12), UID: 7, TypeID: 1, CIID: 100, AttrID: 10,
		OperateType: "u", Page: 0, PageSize: 9999,
	})
	if err != nil {
		t.Fatalf("ListAttributes: %v", err)
	}
	got := repo.lastAttributeFilter
	if got.Page != 1 || got.PageSize != MaxPageSize {
		t.Fatalf("paging = %d/%d, want 1/%d", got.Page, got.PageSize, MaxPageSize)
	}
	if !got.Start.Equal(start) || !got.End.Equal(timeAt(12)) || got.UID != 7 ||
		got.TypeID != 1 || got.CIID != 100 || got.AttrID != 10 || got.OperateType != "u" {
		t.Fatalf("filter = %+v", got)
	}
}

func TestRelationHistoryNamesBothEnds(t *testing.T) {
	repo := &stubRepo{relations: []RelationRow{{
		Record: Record{ID: 5, UID: 7, TypeID: 1, CreatedAt: timeAt(12)},
		ID:     30, OperateType: "a", FirstCIID: ptr(model.ID(100)), SecondCIID: ptr(model.ID(101)),
		RelationTypeID: ptr(model.ID(3)), RelationID: 9,
	}}}
	got, err := fixtureUseCase(repo).ListRelations(context.Background(), RelationFilter{Page: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("ListRelations: %v", err)
	}
	if len(got.Items) != 1 || len(got.Items[0].Changes) != 1 {
		t.Fatalf("relation page = %+v", got)
	}
	change := got.Items[0].Changes[0]
	if change.FirstCIName != "web-01" || change.SecondCIName != "sw-01" || change.RelationTypeID != 3 {
		t.Fatalf("relation change = %+v", change)
	}
}

func TestCITypeHistoryNamesTheModelAndAttribute(t *testing.T) {
	repo := &stubRepo{types: []TypeRow{{
		ID: 40, OperateType: "10", TypeID: 1, AttrID: ptr(model.ID(10)),
		UID: ptr(model.ID(7)), Change: map[string]any{"alias": "主机名"}, CreatedAt: timeAt(9),
	}}}
	got, err := fixtureUseCase(repo).ListTypes(context.Background(), TypeFilter{Page: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("ListTypes: %v", err)
	}
	if len(got.Items) != 1 || got.Items[0].TypeName != "host" || got.Items[0].AttrName != "hostname" {
		t.Fatalf("type item = %+v", got.Items)
	}
}

func TestTriggerHistoryNamesTheModelAndCI(t *testing.T) {
	repo := &stubRepo{triggers: []TriggerRow{{
		ID: 50, OperateType: "a", CIID: 100, TriggerID: ptr(model.ID(4)),
		TriggerName: "notify", IsOK: true, UID: 7, TypeID: 1, CreatedAt: timeAt(8),
	}}}
	got, err := fixtureUseCase(repo).ListTriggers(context.Background(), TriggerFilter{Page: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("ListTriggers: %v", err)
	}
	if len(got.Items) != 1 || got.Items[0].CIName != "web-01" || got.Items[0].TypeName != "host" ||
		got.Items[0].TriggerName != "notify" || !got.Items[0].IsOK {
		t.Fatalf("trigger item = %+v", got.Items)
	}
}

func TestPerCIHistoryPagesAndNamesTheAttribute(t *testing.T) {
	repo := &stubRepo{attributes: []AttributeRow{{
		Record: Record{ID: 2, UID: 7, TypeID: 1, CreatedAt: timeAt(11)},
		ID:     20, OperateType: "u", CIID: 100, AttrID: 10, Old: ptr("a"), New: ptr("b"),
	}}}
	got, err := fixtureUseCase(repo).ListCIAttributes(context.Background(), 100, 0, 9999)
	if err != nil {
		t.Fatalf("ListCIAttributes: %v", err)
	}
	if got.Page != 1 || got.PageSize != MaxPageSize {
		t.Fatalf("paging = %d/%d", got.Page, got.PageSize)
	}
	if len(got.Items) != 1 || got.Items[0].AttrName != "hostname" || got.Items[0].CIName != "web-01" {
		t.Fatalf("ci history = %+v", got.Items)
	}
}
