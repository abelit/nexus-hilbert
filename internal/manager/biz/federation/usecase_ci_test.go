package federation_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	biz "github.com/ongridio/ongrid/internal/manager/biz/federation"
	model "github.com/ongridio/ongrid/internal/manager/model/federation"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

type fakeCMDB struct {
	instance *biz.CMDBInstance
	types    []biz.CMDBType
	err      error
}

func (f fakeCMDB) GetInstance(context.Context, uint64) (*biz.CMDBInstance, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.instance, nil
}

func (f fakeCMDB) ListCITypes(context.Context) ([]biz.CMDBType, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.types, nil
}

func createConnectionNamed(t *testing.T, uc *biz.Usecase, name string) uint64 {
	t.Helper()
	view, err := uc.CreateConnection(context.Background(), biz.ConnectionInput{
		Kind: model.KindExternalAlert, Name: name,
		BaseURL: "http://morse.invalid", APIPath: "/api/v1/alerts",
	}, 1)
	if err != nil {
		t.Fatalf("CreateConnection %s: %v", name, err)
	}
	return view.ID
}

func TestSaveMappingValidatesAndLists(t *testing.T) {
	uc, _ := newUsecase(t, fakeCrypto{}, &fakeQuerier{})
	ctx := context.Background()
	connID := createConnectionNamed(t, uc, "primary")
	uc.SetCMDBReader(fakeCMDB{types: []biz.CMDBType{{ID: 3, Name: "host"}}})

	view, err := uc.SaveMapping(ctx, model.KindExternalAlert, biz.MappingInput{
		CITypeID: 3, ConnectionID: connID,
		Rows: []biz.FieldMapping{{SourceField: "alert.labels.host", Op: "eq", MapType: biz.MapTypeField, Value: "hostname"}},
	}, 0)
	if err != nil {
		t.Fatalf("SaveMapping: %v", err)
	}
	if view.CITypeID != 3 || view.ConnectionID != connID || !view.Enabled {
		t.Fatalf("view = %+v", view)
	}
	rows, err := uc.ListMappings(ctx, model.KindExternalAlert, 3)
	if err != nil || len(rows) != 1 || len(rows[0].Rows) != 1 {
		t.Fatalf("ListMappings = %+v, %v", rows, err)
	}

	if _, err := uc.SaveMapping(ctx, model.KindExternalAlert, biz.MappingInput{
		CITypeID: 3, ConnectionID: connID,
		Rows: []biz.FieldMapping{{SourceField: "", Op: "eq", MapType: biz.MapTypeField, Value: "hostname"}},
	}, 0); !errors.Is(err, errs.ErrInvalid) {
		t.Fatalf("bad rows err = %v", err)
	}
	if _, err := uc.SaveMapping(ctx, model.KindExternalAlert, biz.MappingInput{
		CITypeID: 99, ConnectionID: connID,
		Rows: []biz.FieldMapping{{SourceField: "host", Op: "eq", MapType: biz.MapTypeField, Value: "hostname"}},
	}, 0); !errors.Is(err, errs.ErrInvalid) {
		t.Fatalf("unknown ci type err = %v", err)
	}
}

func TestCIItemsMergesAndDedupes(t *testing.T) {
	page := &biz.QueryPage{
		Total: 2, Page: 1, PageSize: 500, Pages: 1,
		Items: []json.RawMessage{
			json.RawMessage(`{"_id":"a","created_at":"2026-01-01T00:00:00Z"}`),
			json.RawMessage(`{"_id":"b","created_at":"2026-01-02T00:00:00Z"}`),
		},
	}
	uc, _ := newUsecase(t, fakeCrypto{}, &fakeQuerier{page: page})
	ctx := context.Background()
	first := createConnectionNamed(t, uc, "primary")
	second := createConnectionNamed(t, uc, "secondary")
	uc.SetCMDBReader(fakeCMDB{types: []biz.CMDBType{{ID: 3, Name: "host"}}, instance: &biz.CMDBInstance{
		ID: 7, TypeID: 3, Values: map[string]any{"hostname": "web-1"},
	}})
	rows := []biz.FieldMapping{{SourceField: "host", Op: "eq", MapType: biz.MapTypeField, Value: "hostname"}}
	if _, err := uc.SaveMapping(ctx, model.KindExternalAlert, biz.MappingInput{CITypeID: 3, ConnectionID: first, Rows: rows}, 0); err != nil {
		t.Fatalf("SaveMapping first: %v", err)
	}
	if _, err := uc.SaveMapping(ctx, model.KindExternalAlert, biz.MappingInput{CITypeID: 3, ConnectionID: second, Rows: rows}, 0); err != nil {
		t.Fatalf("SaveMapping second: %v", err)
	}
	result, err := uc.CIItems(ctx, model.KindExternalAlert, 7, 7)
	if err != nil {
		t.Fatalf("CIItems: %v", err)
	}
	if !result.Configured || !result.HasMapping || result.Total != 2 || len(result.Items) != 2 {
		t.Fatalf("result = %+v", result)
	}
	// Newest first.
	if string(result.Items[0]) != `{"_id":"b","created_at":"2026-01-02T00:00:00Z"}` {
		t.Fatalf("items = %s", result.Items[0])
	}
}

func TestCIItemsNoValueAndNoMapping(t *testing.T) {
	uc, _ := newUsecase(t, fakeCrypto{}, &fakeQuerier{})
	ctx := context.Background()
	connID := createConnectionNamed(t, uc, "primary")
	uc.SetCMDBReader(fakeCMDB{types: []biz.CMDBType{{ID: 3, Name: "host"}}, instance: &biz.CMDBInstance{ID: 7, TypeID: 3, Values: map[string]any{}}})

	result, err := uc.CIItems(ctx, model.KindExternalAlert, 7, 7)
	if err != nil {
		t.Fatalf("CIItems no mapping: %v", err)
	}
	if result.HasMapping || result.Reason != "no_mapping" {
		t.Fatalf("no mapping = %+v", result)
	}

	if _, err := uc.SaveMapping(ctx, model.KindExternalAlert, biz.MappingInput{
		CITypeID: 3, ConnectionID: connID,
		Rows: []biz.FieldMapping{{SourceField: "host", Op: "eq", MapType: biz.MapTypeField, Value: "missing"}},
	}, 0); err != nil {
		t.Fatalf("SaveMapping: %v", err)
	}
	result, err = uc.CIItems(ctx, model.KindExternalAlert, 7, 7)
	if err != nil {
		t.Fatalf("CIItems no value: %v", err)
	}
	if !result.HasMapping || result.Reason != "no_ci_value" {
		t.Fatalf("no value = %+v", result)
	}
}

func TestCIItemsCMDBUnavailable(t *testing.T) {
	uc, _ := newUsecase(t, fakeCrypto{}, &fakeQuerier{})
	result, err := uc.CIItems(context.Background(), model.KindExternalAlert, 7, 7)
	if err != nil {
		t.Fatalf("CIItems: %v", err)
	}
	if result.Configured || result.Reason != "cmdb_unavailable" {
		t.Fatalf("result = %+v", result)
	}
	if _, err := uc.CITypes(context.Background()); !errors.Is(err, biz.ErrCMDBUnavailable) {
		t.Fatalf("CITypes err = %v", err)
	}
}

func TestMappingStatusAndPreview(t *testing.T) {
	uc, _ := newUsecase(t, fakeCrypto{}, &fakeQuerier{})
	ctx := context.Background()
	connID := createConnectionNamed(t, uc, "primary")
	uc.SetCMDBReader(fakeCMDB{
		types:    []biz.CMDBType{{ID: 3, Name: "host"}},
		instance: &biz.CMDBInstance{ID: 7, TypeID: 3, Values: map[string]any{"hostname": "web-1"}},
	})
	rows := []biz.FieldMapping{{SourceField: "host", Op: "eq", MapType: biz.MapTypeField, Value: "hostname"}}
	if _, err := uc.SaveMapping(ctx, model.KindExternalAlert, biz.MappingInput{CITypeID: 3, ConnectionID: connID, Rows: rows}, 0); err != nil {
		t.Fatalf("SaveMapping: %v", err)
	}
	status, err := uc.MappingStatus(ctx, model.KindExternalAlert, 3)
	if err != nil || !status.Configured || !status.HasMapping {
		t.Fatalf("status = %+v, %v", status, err)
	}
	preview, err := uc.PreviewMapping(ctx, model.KindExternalAlert, 7, biz.MappingInput{
		CITypeID: 3, ConnectionID: connID, Rows: rows,
	})
	if err != nil {
		t.Fatalf("PreviewMapping: %v", err)
	}
	if preview.Matched != 1 || len(preview.Or) != 1 || preview.Or[0] != "host:eq:web-1" {
		t.Fatalf("preview = %+v", preview)
	}
}
