package ci

import (
	"context"
	"strings"
	"testing"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
	"github.com/ongridio/ongrid/internal/cmdb/model/value"
)

type triggerWriteRepo struct {
	readRepoStub
	writeResult  *WriteResult
	updateResult []Change
	rows         []ValueRow
	deleted      bool
}

func (r *triggerWriteRepo) WriteCI(context.Context, WriteSpec) (*WriteResult, error) {
	return r.writeResult, nil
}

func (r *triggerWriteRepo) UpsertCIValues(context.Context, UpdateInput) ([]Change, error) {
	return r.updateResult, nil
}

func (r *triggerWriteRepo) LoadValueRows(context.Context, model.ID) ([]ValueRow, error) {
	return r.rows, nil
}

func (r *triggerWriteRepo) DeleteCI(context.Context, model.ID) error {
	r.deleted = true
	r.rows = nil
	return nil
}

type triggerSetResolver struct{ set *AttributeSet }

func (r *triggerSetResolver) ResolveForCI(context.Context, string) (*AttributeSet, error) {
	return r.set, nil
}

func (r *triggerSetResolver) RelationBetween(context.Context, model.ID, model.ID) (TypeRelationRule, bool, error) {
	return TypeRelationRule{}, false, nil
}

func (r *triggerSetResolver) HierarchyLevels(context.Context, model.ID, int, bool) (HierarchyLevels, error) {
	return HierarchyLevels{}, nil
}

type recordingTriggerDispatcher struct {
	prepared    []TriggerEvent
	prepareErrs []error
	sent        [][]TriggerFiring
}

func (d *recordingTriggerDispatcher) Prepare(ctx context.Context, event TriggerEvent) ([]TriggerFiring, error) {
	d.prepareErrs = append(d.prepareErrs, ctx.Err())
	d.prepared = append(d.prepared, event)
	return []TriggerFiring{{TriggerID: 1}}, nil
}

func (d *recordingTriggerDispatcher) Send(firings []TriggerFiring) {
	d.sent = append(d.sent, firings)
}

func triggerServerFixture(t *testing.T) (*triggerWriteRepo, *triggerSetResolver, *recordingTriggerDispatcher, *Usecase) {
	t.Helper()
	nameSpec := AttributeSpec{ID: 1, Name: "name", Alias: "hostname", ValueType: value.TypeText, IsIndex: true, IsUnique: true}
	set := &AttributeSet{
		Type:         citypemodel.CIType{Base: model.Base{ID: 7}, Name: "server"},
		Specs:        map[model.ID]AttributeSpec{1: nameSpec},
		ByName:       map[string]model.ID{"name": 1},
		ByAlias:      map[string]model.ID{"hostname": 1},
		UniqueAttrID: 1,
		UniqueAttr:   nameSpec,
		ShowAttr:     nameSpec,
	}
	repo := &triggerWriteRepo{rows: []ValueRow{{AttrID: 1, Table: value.TableIndexTexts, Text: "web-01"}}}
	dispatcher := &recordingTriggerDispatcher{}
	uc := NewUsecase(repo, &triggerSetResolver{set: set}, nil).WithTriggerDispatcher(dispatcher)
	return repo, &triggerSetResolver{set: set}, dispatcher, uc
}

func TestCreateDispatchesAnAddEventAfterTheWrite(t *testing.T) {
	repo, _, dispatcher, uc := triggerServerFixture(t)
	repo.writeResult = &WriteResult{
		CIID: 42, Created: true,
		Changes: []Change{{CIID: 42, TypeID: 7, AttrID: 1, RecordID: 77, Operate: model.OperateAdd, New: "web-01"}},
	}

	if _, err := uc.Create(context.Background(), WriteRequest{TypeRef: "server", Values: map[string]any{"name": "web-01"}}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if len(dispatcher.prepared) != 1 {
		t.Fatalf("prepared = %+v, want one event", dispatcher.prepared)
	}
	event := dispatcher.prepared[0]
	if event.Kind != model.OperateAdd || event.CIID != 42 || event.RecordID != 77 {
		t.Fatalf("event = %+v", event)
	}
	if len(event.ChangedAttrIDs) != 1 || event.ChangedAttrIDs[0] != 1 {
		t.Fatalf("changed attrs = %v", event.ChangedAttrIDs)
	}
	for key, want := range map[string]string{
		"name": "web-01", "hostname": "web-01", "unique": "web-01",
		"_id": "42", "_type": "7", "ci_type": "server",
	} {
		if event.Values[key] != want {
			t.Fatalf("value %q = %q, want %q (all: %+v)", key, event.Values[key], want, event.Values)
		}
	}
	if len(dispatcher.sent) != 1 || len(dispatcher.sent[0]) != 1 {
		t.Fatalf("sent = %+v", dispatcher.sent)
	}
}

func TestUpdateDispatchesOnceWithChangedAttributesAndOldValues(t *testing.T) {
	repo, _, dispatcher, uc := triggerServerFixture(t)
	repo.ci = &cimodel.CI{Base: model.Base{ID: 42}, TypeID: 7}
	repo.updateResult = []Change{{
		CIID: 42, TypeID: 7, AttrID: 1, RecordID: 88,
		Operate: model.OperateUpdate, Old: "web-00", New: "web-01",
	}}

	if _, err := uc.Update(context.Background(), 42, WriteRequest{Values: map[string]any{"name": "web-01"}}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if len(dispatcher.prepared) != 1 {
		t.Fatalf("prepared = %+v, want one event", dispatcher.prepared)
	}
	event := dispatcher.prepared[0]
	if event.Kind != model.OperateUpdate || event.RecordID != 88 {
		t.Fatalf("event = %+v", event)
	}
	if len(event.ChangedAttrIDs) != 1 || event.ChangedAttrIDs[0] != 1 {
		t.Fatalf("changed attrs = %v", event.ChangedAttrIDs)
	}
	if event.Values["name"] != "web-01" || event.Values["old_name"] != "web-00" {
		t.Fatalf("values = %+v", event.Values)
	}
}

func TestUpdateThatChangesNothingDispatchesNothing(t *testing.T) {
	repo, _, dispatcher, uc := triggerServerFixture(t)
	repo.ci = &cimodel.CI{Base: model.Base{ID: 42}, TypeID: 7}
	repo.updateResult = nil

	if _, err := uc.Update(context.Background(), 42, WriteRequest{Values: map[string]any{"name": "web-01"}}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if len(dispatcher.prepared) != 0 {
		t.Fatalf("prepared = %+v, want none", dispatcher.prepared)
	}
}

func TestDeletePreparesTheEventWhileTheValuesStillExist(t *testing.T) {
	repo, _, dispatcher, uc := triggerServerFixture(t)
	repo.ci = &cimodel.CI{Base: model.Base{ID: 42}, TypeID: 7}

	if err := uc.Delete(context.Background(), 42); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if !repo.deleted {
		t.Fatal("DeleteCI was not called")
	}
	if len(dispatcher.prepared) != 1 {
		t.Fatalf("prepared = %+v, want one event", dispatcher.prepared)
	}
	event := dispatcher.prepared[0]
	if event.Kind != model.OperateDelete || event.CIID != 42 {
		t.Fatalf("event = %+v", event)
	}
	if event.Values["name"] != "web-01" {
		t.Fatalf("values = %+v, want the pre-delete value", event.Values)
	}
	if len(dispatcher.sent) != 1 {
		t.Fatalf("sent = %+v", dispatcher.sent)
	}
}

func TestCreateDispatchesEvenWhenTheRequestContextIsCanceled(t *testing.T) {
	repo, _, dispatcher, uc := triggerServerFixture(t)
	repo.writeResult = &WriteResult{
		CIID: 42, Created: true,
		Changes: []Change{{CIID: 42, TypeID: 7, AttrID: 1, RecordID: 77, Operate: model.OperateAdd, New: "web-01"}},
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := uc.Create(ctx, WriteRequest{TypeRef: "server", Values: map[string]any{"name": "web-01"}}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if len(dispatcher.prepared) != 1 {
		t.Fatalf("prepared = %+v, want the event to survive request cancellation", dispatcher.prepared)
	}
	if dispatcher.prepareErrs[0] != nil {
		t.Fatalf("prepare context error = %v, want a detached context", dispatcher.prepareErrs[0])
	}
}

func TestTriggerEventNeverCarriesPasswordValues(t *testing.T) {
	nameSpec := AttributeSpec{ID: 1, Name: "name", ValueType: value.TypeText, IsIndex: true, IsUnique: true}
	secretSpec := AttributeSpec{ID: 2, Name: "secret", Alias: "密码", ValueType: value.TypeText, IsPassword: true}
	set := &AttributeSet{
		Type:         citypemodel.CIType{Base: model.Base{ID: 7}, Name: "server"},
		Specs:        map[model.ID]AttributeSpec{1: nameSpec, 2: secretSpec},
		ByName:       map[string]model.ID{"name": 1, "secret": 2},
		ByAlias:      map[string]model.ID{"密码": 2},
		UniqueAttrID: 1,
		UniqueAttr:   nameSpec,
		ShowAttr:     nameSpec,
	}
	event := buildTriggerEvent(set, 42, model.OperateUpdate, []Change{{
		CIID: 42, TypeID: 7, AttrID: 2, Operate: model.OperateUpdate,
		Old: "old-secret", New: "new-secret",
	}}, []ValueRow{
		{AttrID: 1, Table: value.TableIndexTexts, Text: "web-01"},
		{AttrID: 2, Table: value.TableTexts, Text: "new-secret"},
	}, AuditInfo{})
	for key, value := range event.Values {
		if strings.Contains(value, "secret") {
			t.Fatalf("trigger payload leaked a password in %q: %q", key, value)
		}
		if key == "secret" || key == "密码" || key == "old_secret" || key == "old_密码" {
			t.Fatalf("trigger payload contains a password key %q", key)
		}
	}
}
