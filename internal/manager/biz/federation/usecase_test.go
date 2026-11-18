package federation_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	biz "github.com/ongridio/ongrid/internal/manager/biz/federation"
	store "github.com/ongridio/ongrid/internal/manager/data/federation/store"
	model "github.com/ongridio/ongrid/internal/manager/model/federation"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

type fakeCrypto struct{ weak bool }

func (f fakeCrypto) Encrypt(plain string) (string, error) {
	return "enc:" + base64.StdEncoding.EncodeToString([]byte(plain)), nil
}
func (f fakeCrypto) Decrypt(cipher string) (string, error) {
	if !strings.HasPrefix(cipher, "enc:") {
		return "", errors.New("bad cipher")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(cipher, "enc:"))
	if err != nil {
		return "", err
	}
	return string(raw), nil
}
func (f fakeCrypto) Weak() bool { return f.weak }

type fakeQuerier struct {
	got  biz.QueryRequest
	page *biz.QueryPage
	err  error
}

func (f *fakeQuerier) Query(_ context.Context, _ *model.Connection, req biz.QueryRequest) (*biz.QueryPage, error) {
	f.got = req
	if f.err != nil {
		return nil, f.err
	}
	if f.page != nil {
		return f.page, nil
	}
	return &biz.QueryPage{Total: 1, Page: req.Page, PageSize: req.PageSize, Pages: 1, Items: []json.RawMessage{json.RawMessage(`{"_id":"a"}`)}}, nil
}

func (f *fakeQuerier) Probe(context.Context, biz.ProbeConfig) error { return f.err }

func newUsecase(t *testing.T, crypto biz.Crypto, querier biz.SourceQuerier) (*biz.Usecase, *store.Repo) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := store.Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	repo := store.NewRepo(db)
	return biz.NewUsecase(repo, querier, crypto, slog.New(slog.NewTextHandler(io.Discard, nil))), repo
}

func ptr[T any](v T) *T { return &v }

func TestCreateConnectionEncryptsAndMasks(t *testing.T) {
	uc, repo := newUsecase(t, fakeCrypto{}, &fakeQuerier{})
	view, err := uc.CreateConnection(context.Background(), biz.ConnectionInput{
		Kind:      model.KindExternalAlert,
		Name:      "primary",
		BaseURL:   "http://morse.invalid/",
		APIPath:   "/api/v1/alerts",
		AuthType:  "bearer",
		Auth:      &biz.Credentials{Token: "tok-secret"},
		IsDefault: ptr(true),
	}, 42)
	if err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}
	if view.TokenSet != true || view.PasswordSet {
		t.Fatalf("mask = %+v", view)
	}
	if view.BaseURL != "http://morse.invalid" {
		t.Fatalf("base url = %q", view.BaseURL)
	}
	stored, err := repo.GetConnection(context.Background(), view.ID)
	if err != nil {
		t.Fatalf("GetConnection: %v", err)
	}
	if strings.Contains(stored.AuthCipher, "tok-secret") || stored.AuthCipher == "" {
		t.Fatalf("cipher = %q", stored.AuthCipher)
	}
	if !stored.IsDefault || !stored.Enabled {
		t.Fatalf("stored = %+v", stored)
	}
}

func TestCreateConnectionRejectsWeakSecret(t *testing.T) {
	uc, _ := newUsecase(t, fakeCrypto{weak: true}, &fakeQuerier{})
	_, err := uc.CreateConnection(context.Background(), biz.ConnectionInput{
		Kind: model.KindExternalAlert, Name: "primary",
		BaseURL: "http://morse.invalid", APIPath: "/api/v1/alerts",
		AuthType: "bearer", Auth: &biz.Credentials{Token: "tok-secret"},
	}, 1)
	if !errors.Is(err, biz.ErrWeakSecret) {
		t.Fatalf("err = %v", err)
	}
}

func TestUpdateConnectionKeepsCredentialWhenAuthOmitted(t *testing.T) {
	uc, repo := newUsecase(t, fakeCrypto{}, &fakeQuerier{})
	ctx := context.Background()
	view, err := uc.CreateConnection(ctx, biz.ConnectionInput{
		Kind: model.KindExternalAlert, Name: "primary",
		BaseURL: "http://morse.invalid", APIPath: "/api/v1/alerts",
		AuthType: "bearer", Auth: &biz.Credentials{Token: "tok-secret"},
	}, 1)
	if err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}
	before, _ := repo.GetConnection(ctx, view.ID)

	if _, err := uc.UpdateConnection(ctx, view.ID, biz.ConnectionInput{
		Kind: model.KindExternalAlert, Name: "primary-renamed",
		BaseURL: "http://morse.invalid", APIPath: "/api/v1/alerts",
		// AuthType and Auth deliberately omitted: both must be preserved.
	}); err != nil {
		t.Fatalf("UpdateConnection: %v", err)
	}
	after, _ := repo.GetConnection(ctx, view.ID)
	if after.Name != "primary-renamed" {
		t.Fatalf("name = %q", after.Name)
	}
	if after.AuthCipher != before.AuthCipher {
		t.Fatal("credential was overwritten by an update that omitted auth")
	}
}

func TestListItemsBuildsFiltersAndClamps(t *testing.T) {
	querier := &fakeQuerier{}
	uc, _ := newUsecase(t, fakeCrypto{}, querier)
	ctx := context.Background()
	if _, err := uc.CreateConnection(ctx, biz.ConnectionInput{
		Kind: model.KindExternalAlert, Name: "primary",
		BaseURL: "http://morse.invalid", APIPath: "/api/v1/alerts",
	}, 1); err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}

	res, err := uc.ListItems(ctx, model.KindExternalAlert, biz.ListRequest{
		Status: "firing", Severity: "critical", Keyword: "Disk", Page: 1, PageSize: 9999,
	})
	if err != nil {
		t.Fatalf("ListItems: %v", err)
	}
	if !res.Configured || res.Total != 1 {
		t.Fatalf("result = %+v", res)
	}
	if querier.got.PageSize != 500 {
		t.Fatalf("page size = %d", querier.got.PageSize)
	}
	if len(querier.got.Filters) != 3 {
		t.Fatalf("filters = %v", querier.got.Filters)
	}
	want := []string{"status:eq:firing", "alert.labels.severity:eq:critical", "alertname:regex:Disk"}
	for i := range want {
		if querier.got.Filters[i] != want[i] {
			t.Fatalf("filters = %v", querier.got.Filters)
		}
	}
}

func TestListItemsWithoutConnectionIsNotConfigured(t *testing.T) {
	uc, _ := newUsecase(t, fakeCrypto{}, &fakeQuerier{})
	res, err := uc.ListItems(context.Background(), model.KindExternalAlert, biz.ListRequest{Page: 1, PageSize: 50})
	if err != nil {
		t.Fatalf("ListItems: %v", err)
	}
	if res.Configured || res.Reason != "not_configured" {
		t.Fatalf("result = %+v", res)
	}
}

func TestConnectionValidationRejectsBadEndpoint(t *testing.T) {
	uc, _ := newUsecase(t, fakeCrypto{}, &fakeQuerier{})
	cases := []biz.ConnectionInput{
		{Kind: "incident", Name: "x", BaseURL: "http://x", APIPath: "/a"},
		{Kind: model.KindExternalAlert, Name: "", BaseURL: "http://x", APIPath: "/a"},
		{Kind: model.KindExternalAlert, Name: "x", BaseURL: "ftp://x", APIPath: "/a"},
		{Kind: model.KindExternalAlert, Name: "x", BaseURL: "http://user:pass@x", APIPath: "/a"},
		{Kind: model.KindExternalAlert, Name: "x", BaseURL: "http://x", APIPath: "a"},
		{Kind: model.KindExternalAlert, Name: "x", BaseURL: "http://x", APIPath: "/a", AuthType: "basic"},
	}
	for _, in := range cases {
		if _, err := uc.CreateConnection(context.Background(), in, 1); !errors.Is(err, errs.ErrInvalid) {
			t.Fatalf("input %+v err = %v", in, err)
		}
	}
}

func TestConnectionHealthSkipsDisabled(t *testing.T) {
	uc, _ := newUsecase(t, fakeCrypto{}, &fakeQuerier{})
	ctx := context.Background()
	if _, err := uc.CreateConnection(ctx, biz.ConnectionInput{
		Kind: model.KindExternalAlert, Name: "on",
		BaseURL: "http://morse.invalid", APIPath: "/api/v1/alerts",
	}, 1); err != nil {
		t.Fatalf("CreateConnection on: %v", err)
	}
	if _, err := uc.CreateConnection(ctx, biz.ConnectionInput{
		Kind: model.KindExternalAlert, Name: "off",
		BaseURL: "http://morse.invalid", APIPath: "/api/v1/alerts",
		Enabled: ptr(false),
	}, 1); err != nil {
		t.Fatalf("CreateConnection off: %v", err)
	}
	rows, err := uc.ConnectionHealth(ctx, model.KindExternalAlert)
	if err != nil {
		t.Fatalf("ConnectionHealth: %v", err)
	}
	if len(rows) != 1 || rows[0].Name != "on" || !rows[0].OK {
		t.Fatalf("health = %+v", rows)
	}
}
