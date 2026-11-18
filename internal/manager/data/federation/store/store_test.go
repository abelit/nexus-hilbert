package store

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	biz "github.com/ongridio/ongrid/internal/manager/biz/federation"
	model "github.com/ongridio/ongrid/internal/manager/model/federation"
	"github.com/ongridio/ongrid/internal/pkg/errs"
	"github.com/ongridio/ongrid/internal/pkg/secretbox"
)

func newTestRepo(t *testing.T) *Repo {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("gorm.Open sqlite :memory:: %v", err)
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	return NewRepo(db)
}

func newConnection(name string) *model.Connection {
	return &model.Connection{
		Kind:            model.KindExternalAlert,
		Name:            name,
		BaseURL:         "http://upstream.invalid",
		APIPath:         "/api/v1/alerts",
		Method:          http.MethodGet,
		FixedParamsJSON: `{}`,
		AuthType:        "none",
		DefaultDays:     7,
		DefaultPageSize: 50,
		TimeoutSeconds:  15,
		Enabled:         true,
	}
}

func TestMigrateIsIdempotent(t *testing.T) {
	repo := newTestRepo(t)
	if err := Migrate(repo.DB()); err != nil {
		t.Fatalf("second Migrate: %v", err)
	}
}

func TestConnectionCRUDAndDefault(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()

	a := newConnection("primary")
	a.IsDefault = true
	if err := repo.CreateConnection(ctx, a); err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}
	if a.ID == 0 {
		t.Fatal("id not assigned")
	}
	b := newConnection("secondary")
	if err := repo.CreateConnection(ctx, b); err != nil {
		t.Fatalf("CreateConnection b: %v", err)
	}

	got, err := repo.GetConnection(ctx, a.ID)
	if err != nil {
		t.Fatalf("GetConnection: %v", err)
	}
	if got.Name != "primary" || !got.IsDefault {
		t.Fatalf("got = %+v", got)
	}

	list, err := repo.ListConnections(ctx, model.KindExternalAlert)
	if err != nil || len(list) != 2 {
		t.Fatalf("ListConnections = %v, %v", list, err)
	}

	if err := repo.ClearDefaultConnection(ctx, model.KindExternalAlert, b.ID); err != nil {
		t.Fatalf("ClearDefaultConnection: %v", err)
	}
	got, _ = repo.GetConnection(ctx, a.ID)
	if got.IsDefault {
		t.Fatal("default not cleared")
	}

	dup := newConnection("primary")
	if err := repo.CreateConnection(ctx, dup); !errors.Is(err, errs.ErrConflict) {
		t.Fatalf("duplicate name err = %v", err)
	}

	got.Remark = "updated"
	if err := repo.UpdateConnection(ctx, got); err != nil {
		t.Fatalf("UpdateConnection: %v", err)
	}
	got, _ = repo.GetConnection(ctx, a.ID)
	if got.Remark != "updated" {
		t.Fatalf("remark = %q", got.Remark)
	}
}

func TestDeleteConnectionCascadesMappings(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	conn := newConnection("primary")
	if err := repo.CreateConnection(ctx, conn); err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}
	mapping := &model.CIMapping{
		Kind:             model.KindExternalAlert,
		CITypeID:         7,
		ConnectionID:     conn.ID,
		FieldMappingJSON: `[]`,
		Enabled:          true,
	}
	if err := repo.CreateMapping(ctx, mapping); err != nil {
		t.Fatalf("CreateMapping: %v", err)
	}
	if err := repo.DeleteConnection(ctx, conn.ID, true); err != nil {
		t.Fatalf("DeleteConnection: %v", err)
	}
	if _, err := repo.GetConnection(ctx, conn.ID); !errors.Is(err, errs.ErrNotFound) {
		t.Fatalf("connection still present: %v", err)
	}
	if _, err := repo.GetMapping(ctx, mapping.ID); !errors.Is(err, errs.ErrNotFound) {
		t.Fatalf("mapping not cascaded: %v", err)
	}

	conn2 := newConnection("secondary")
	_ = repo.CreateConnection(ctx, conn2)
	m2 := &model.CIMapping{Kind: model.KindExternalAlert, CITypeID: 8, ConnectionID: conn2.ID, FieldMappingJSON: `[]`, Enabled: true}
	_ = repo.CreateMapping(ctx, m2)
	if err := repo.DeleteConnection(ctx, conn2.ID, false); !errors.Is(err, errs.ErrConflict) {
		t.Fatalf("non-cascade delete err = %v", err)
	}
}

func TestFilterUpsertAndBadgeCount(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	f := &model.CenterFilter{
		Kind:         model.KindExternalAlert,
		FilterKey:    "mine",
		Name:         "Mine",
		Usage:        model.UsageBoth,
		AndRulesJSON: `[]`,
		OrRulesJSON:  `[]`,
		Enabled:      true,
	}
	if err := repo.SaveFilter(ctx, f); err != nil {
		t.Fatalf("SaveFilter: %v", err)
	}
	got, err := repo.GetFilter(ctx, model.KindExternalAlert, "mine")
	if err != nil || got.Name != "Mine" {
		t.Fatalf("GetFilter = %+v, %v", got, err)
	}
	got.Name = "Mine (updated)"
	if err := repo.SaveFilter(ctx, got); err != nil {
		t.Fatalf("SaveFilter update: %v", err)
	}
	list, _ := repo.ListFilters(ctx, model.KindExternalAlert)
	if len(list) != 1 || list[0].Name != "Mine (updated)" {
		t.Fatalf("list = %+v", list)
	}
	count, err := repo.CountBadgeFilters(ctx, model.KindExternalAlert, "other")
	if err != nil || count != 1 {
		t.Fatalf("CountBadgeFilters = %d, %v", count, err)
	}
	if err := repo.DeleteFilter(ctx, model.KindExternalAlert, "mine"); err != nil {
		t.Fatalf("DeleteFilter: %v", err)
	}
	if _, err := repo.GetFilter(ctx, model.KindExternalAlert, "mine"); !errors.Is(err, errs.ErrNotFound) {
		t.Fatalf("filter still present: %v", err)
	}
}

func TestReplaceColumnsIsOrderedAndAtomic(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	cols := []model.DisplayColumn{
		{Kind: model.KindExternalAlert, ColumnKey: "status", ColumnKind: model.ColumnKindBuiltin, Visible: true, Position: 0},
		{Kind: model.KindExternalAlert, ColumnKey: "owner", ColumnKind: model.ColumnKindCustom, Path: "a.b", Render: model.RenderText, LabelEN: "Owner", Visible: true, Position: 1},
	}
	if err := repo.ReplaceColumns(ctx, model.KindExternalAlert, cols); err != nil {
		t.Fatalf("ReplaceColumns: %v", err)
	}
	got, err := repo.ListColumns(ctx, model.KindExternalAlert)
	if err != nil || len(got) != 2 || got[1].ColumnKey != "owner" {
		t.Fatalf("ListColumns = %+v, %v", got, err)
	}
	if err := repo.ReplaceColumns(ctx, model.KindExternalAlert, cols[:1]); err != nil {
		t.Fatalf("ReplaceColumns replace: %v", err)
	}
	got, _ = repo.ListColumns(ctx, model.KindExternalAlert)
	if len(got) != 1 || got[0].ColumnKey != "status" {
		t.Fatalf("replaced = %+v", got)
	}
}

func TestUpstreamQueryDecryptsStoredCredential(t *testing.T) {
	var auth string
	var query string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		query = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"success","data":{"total":1,"page":1,"page_size":50,"pages":1,"items":[{"_id":"a"}]}}`)
	}))
	defer srv.Close()

	cipher, err := secretbox.Encrypt(`{"token":"tok-123456"}`)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	conn := newConnection("primary")
	conn.BaseURL = srv.URL
	conn.APIPath = "/api/v1/alerts"
	conn.AuthType = "bearer"
	conn.AuthCipher = cipher
	conn.FixedParamsJSON = `{"table":["pinned"]}`

	page, err := NewUpstream().Query(context.Background(), conn, biz.QueryRequest{
		Days: 7, Page: 1, PageSize: 50, Filters: []string{"status:eq:firing"},
	})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if auth != "Bearer tok-123456" {
		t.Fatalf("Authorization = %q", auth)
	}
	if !strings.Contains(query, "table=pinned") || !strings.Contains(query, "filter=status%3Aeq%3Afiring") {
		t.Fatalf("query = %s", query)
	}
	if page.Total != 1 || len(page.Items) != 1 {
		t.Fatalf("page = %+v", page)
	}
}

func TestUpstreamQueryUndecryptableCredential(t *testing.T) {
	conn := newConnection("primary")
	conn.AuthCipher = "v1:not-valid-base64"
	_, err := NewUpstream().Query(context.Background(), conn, biz.QueryRequest{Days: 7, Page: 1, PageSize: 50})
	if !errors.Is(err, biz.ErrCredentialUndecryptable) {
		t.Fatalf("err = %v", err)
	}
}

func TestUpstreamProbe(t *testing.T) {
	var method string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		_, _ = io.WriteString(w, `{"status":"success","data":{"total":0,"items":[]}}`)
	}))
	defer srv.Close()

	if err := NewUpstream().Probe(context.Background(), biz.ProbeConfig{
		BaseURL: srv.URL, APIPath: "/api/v1/alerts", Method: http.MethodPost,
		DefaultTable: "alert_instances", TimeoutSeconds: 2,
	}); err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if method != http.MethodGet {
		t.Fatalf("probe method = %s", method)
	}
}

