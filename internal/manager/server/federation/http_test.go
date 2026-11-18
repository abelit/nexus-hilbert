package federation_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	biz "github.com/ongridio/ongrid/internal/manager/biz/federation"
	store "github.com/ongridio/ongrid/internal/manager/data/federation/store"
	model "github.com/ongridio/ongrid/internal/manager/model/federation"
	server "github.com/ongridio/ongrid/internal/manager/server/federation"
	svc "github.com/ongridio/ongrid/internal/manager/service/federation"
	"github.com/ongridio/ongrid/internal/pkg/tenantctx"
)

type testCrypto struct{ weak bool }

func (c testCrypto) Encrypt(plain string) (string, error) {
	return "enc:" + base64.StdEncoding.EncodeToString([]byte(plain)), nil
}
func (c testCrypto) Decrypt(cipher string) (string, error) {
	if !strings.HasPrefix(cipher, "enc:") {
		return "", errors.New("bad cipher")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(cipher, "enc:"))
	if err != nil {
		return "", err
	}
	return string(raw), nil
}
func (c testCrypto) Weak() bool { return c.weak }

type testQuerier struct {
	page *biz.QueryPage
	err  error
}

func (q *testQuerier) Query(context.Context, *model.Connection, biz.QueryRequest) (*biz.QueryPage, error) {
	if q.err != nil {
		return nil, q.err
	}
	if q.page != nil {
		return q.page, nil
	}
	return &biz.QueryPage{Total: 1, Page: 1, PageSize: 50, Pages: 1, Items: []json.RawMessage{json.RawMessage(`{"_id":"a"}`)}}, nil
}
func (q *testQuerier) Probe(context.Context, biz.ProbeConfig) error { return q.err }

func newTestRouter(t *testing.T, role string, crypto biz.Crypto, querier biz.SourceQuerier) (*chi.Mux, *svc.Service, *store.Repo) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := store.Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	repo := store.NewRepo(db)
	uc := biz.NewUsecase(repo, querier, crypto, slog.New(slog.NewTextHandler(io.Discard, nil)))
	service := svc.New(uc)
	handler := server.NewHandler(service, slog.New(slog.NewTextHandler(io.Discard, nil)))
	router := chi.NewRouter()
	if role != "" {
		router.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ctx := tenantctx.With(r.Context(), tenantctx.Tenant{
					UserID: 1, Email: "a@b", Role: role, IsSuperuser: role == "admin",
				})
				next.ServeHTTP(w, r.WithContext(ctx))
			})
		})
	}
	handler.Register(router)
	return router, service, repo
}

func do(t *testing.T, router http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func createInput() map[string]any {
	return map[string]any{
		"kind":     model.KindExternalAlert,
		"name":     "primary",
		"base_url": "http://morse.invalid",
		"api_path": "/api/v1/alerts",
		"auth_type": "bearer",
		"auth_data": map[string]any{"token": "tok-secret"},
	}
}

func decodeBody[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var out T
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	return out
}

func TestConfigRoutesRequireAdmin(t *testing.T) {
	router, _, _ := newTestRouter(t, "user", testCrypto{}, &testQuerier{})
	rec := do(t, router, http.MethodPost, "/v1/federation/connections", createInput())
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body)
	}
}

func TestCreateConnectionMasksSecretAndRevealsToAdmin(t *testing.T) {
	router, _, _ := newTestRouter(t, "admin", testCrypto{}, &testQuerier{})
	rec := do(t, router, http.MethodPost, "/v1/federation/connections", createInput())
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), "tok-secret") {
		t.Fatalf("response leaks secret: %s", rec.Body)
	}
	view := decodeBody[biz.ConnectionView](t, rec)
	if !view.TokenSet || view.PasswordSet {
		t.Fatalf("view = %+v", view)
	}

	list := do(t, router, http.MethodGet, "/v1/federation/connections?kind=external_alert", nil)
	if list.Code != http.StatusOK || strings.Contains(list.Body.String(), "tok-secret") {
		t.Fatalf("list status=%d body=%s", list.Code, list.Body)
	}

	reveal := do(t, router, http.MethodGet, "/v1/federation/connections/1/reveal", nil)
	if reveal.Code != http.StatusOK {
		t.Fatalf("reveal status=%d body=%s", reveal.Code, reveal.Body)
	}
	creds := decodeBody[map[string]string](t, reveal)
	if creds["token"] != "tok-secret" {
		t.Fatalf("reveal = %+v", creds)
	}
}

func TestListAlertsAllowsAnyAuthenticatedUser(t *testing.T) {
	router, service, _ := newTestRouter(t, "user", testCrypto{}, &testQuerier{})
	if _, err := service.CreateConnection(context.Background(), biz.ConnectionInput{
		Kind: model.KindExternalAlert, Name: "primary",
		BaseURL: "http://morse.invalid", APIPath: "/api/v1/alerts",
	}, 1); err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}
	rec := do(t, router, http.MethodGet, "/v1/federation/alerts?days=7&page=1&page_size=50", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body)
	}
	got := decodeBody[biz.ListResult](t, rec)
	if !got.Configured || got.Total != 1 || len(got.Items) != 1 {
		t.Fatalf("result = %+v", got)
	}
}

func TestUpstreamErrorIs502(t *testing.T) {
	router, service, _ := newTestRouter(t, "admin", testCrypto{}, &testQuerier{err: biz.ErrUpstream})
	if _, err := service.CreateConnection(context.Background(), biz.ConnectionInput{
		Kind: model.KindExternalAlert, Name: "primary",
		BaseURL: "http://morse.invalid", APIPath: "/api/v1/alerts",
	}, 1); err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}
	rec := do(t, router, http.MethodGet, "/v1/federation/alerts", nil)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body)
	}
	if decodeBody[map[string]string](t, rec)["code"] != "upstream" {
		t.Fatalf("body = %s", rec.Body)
	}
}

func TestWeakSecretIsRejectedWithCode(t *testing.T) {
	router, _, _ := newTestRouter(t, "admin", testCrypto{weak: true}, &testQuerier{})
	rec := do(t, router, http.MethodPost, "/v1/federation/connections", createInput())
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body)
	}
	if decodeBody[map[string]string](t, rec)["code"] != "secret-key-weak" {
		t.Fatalf("body = %s", rec.Body)
	}
}

func TestHealthReturnsRows(t *testing.T) {
	router, service, _ := newTestRouter(t, "admin", testCrypto{}, &testQuerier{})
	if _, err := service.CreateConnection(context.Background(), biz.ConnectionInput{
		Kind: model.KindExternalAlert, Name: "primary",
		BaseURL: "http://morse.invalid", APIPath: "/api/v1/alerts",
	}, 1); err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}
	rec := do(t, router, http.MethodGet, "/v1/federation/connections/health?kind=external_alert", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body)
	}
	got := decodeBody[struct {
		Items []biz.HealthRow `json:"items"`
		Total int             `json:"total"`
	}](t, rec)
	if got.Total != 1 || !got.Items[0].OK {
		t.Fatalf("health = %+v", got)
	}
}

func TestMissingKindIs400(t *testing.T) {
	router, _, _ := newTestRouter(t, "admin", testCrypto{}, &testQuerier{})
	rec := do(t, router, http.MethodGet, "/v1/federation/connections", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body)
	}
}

func TestListAlertsNotConfigured(t *testing.T) {
	router, _, _ := newTestRouter(t, "user", testCrypto{}, &testQuerier{})
	rec := do(t, router, http.MethodGet, "/v1/federation/alerts", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body)
	}
	got := decodeBody[biz.ListResult](t, rec)
	if got.Configured || got.Reason != "not_configured" {
		t.Fatalf("result = %+v", got)
	}
}

func TestUnauthenticatedIs401(t *testing.T) {
	router, _, _ := newTestRouter(t, "", testCrypto{}, &testQuerier{})
	rec := do(t, router, http.MethodGet, "/v1/federation/alerts", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body)
	}
}

func TestDeleteConnectionConflictWithoutCascade(t *testing.T) {
	router, service, repo := newTestRouter(t, "admin", testCrypto{}, &testQuerier{})
	view, err := service.CreateConnection(context.Background(), biz.ConnectionInput{
		Kind: model.KindExternalAlert, Name: "primary",
		BaseURL: "http://morse.invalid", APIPath: "/api/v1/alerts",
	}, 1)
	if err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}
	if err := repo.CreateMapping(context.Background(), &model.CIMapping{
		Kind: model.KindExternalAlert, CITypeID: 3, ConnectionID: view.ID,
		FieldMappingJSON: `[]`, Enabled: true,
	}); err != nil {
		t.Fatalf("CreateMapping: %v", err)
	}
	rec := do(t, router, http.MethodDelete, "/v1/federation/connections/1", nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body)
	}
	rec = do(t, router, http.MethodDelete, "/v1/federation/connections/1?cascade=true", nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("cascade status = %d body=%s", rec.Code, rec.Body)
	}
}

type testIdentities map[string][]string

func (t testIdentities) Resolve(context.Context, uint64) (map[string][]string, error) {
	return map[string][]string(t), nil
}

func saveIdentityFilter(t *testing.T, service *svc.Service, key string) {
	t.Helper()
	if _, err := service.SaveFilter(context.Background(), model.KindExternalAlert, biz.FilterInput{
		Key: key, Name: key, Usage: biz.UsageBoth, Enabled: boolPtr(true),
		And: []biz.Rule{
			{Field: "owner", Op: "eq", ValueType: biz.ValueTypeIdentity, Identity: "email"},
			{Field: "status", Op: "eq", ValueType: biz.ValueTypeFixed, Values: []string{"firing"}},
		},
	}, ""); err != nil {
		t.Fatalf("SaveFilter: %v", err)
	}
}

func boolPtr(v bool) *bool { return &v }

func TestCenterFilterWritesRequireAdminAndSummariesAreReadable(t *testing.T) {
	router, service, _ := newTestRouter(t, "admin", testCrypto{}, &testQuerier{})
	saveIdentityFilter(t, service, "mine")

	userRouter, _, _ := newTestRouter(t, "user", testCrypto{}, &testQuerier{})
	// The user router has its own empty DB; summaries are still a valid read.
	rec := do(t, userRouter, http.MethodGet, "/v1/federation/center-filters/summaries?kind=external_alert", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("summaries status = %d body=%s", rec.Code, rec.Body)
	}
	rec = do(t, userRouter, http.MethodPost, "/v1/federation/center-filters?kind=external_alert", map[string]any{
		"key": "x", "name": "X", "usage": "filter",
		"and": []map[string]any{{"field": "status", "op": "eq", "value_type": "fixed", "values": []string{"firing"}}},
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("write status = %d body=%s", rec.Code, rec.Body)
	}

	rec = do(t, router, http.MethodGet, "/v1/federation/center-filters/summaries?kind=external_alert", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin summaries status = %d body=%s", rec.Code, rec.Body)
	}
	got := decodeBody[struct {
		Items []biz.FilterSummary `json:"items"`
	}](t, rec)
	if len(got.Items) != 1 || got.Items[0].Key != "mine" || !got.Items[0].IdentityRequired {
		t.Fatalf("summaries = %+v", got)
	}
}

func TestColumnsAreReadableByUser(t *testing.T) {
	router, _, _ := newTestRouter(t, "user", testCrypto{}, &testQuerier{})
	rec := do(t, router, http.MethodGet, "/v1/federation/columns?kind=external_alert", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body)
	}
	got := decodeBody[struct {
		Items []map[string]any `json:"items"`
	}](t, rec)
	if len(got.Items) == 0 {
		t.Fatalf("body = %s", rec.Body)
	}
}

func TestMyAlertsUnboundWhenNoIdentity(t *testing.T) {
	router, service, _ := newTestRouter(t, "user", testCrypto{}, &testQuerier{})
	saveIdentityFilter(t, service, "mine")
	rec := do(t, router, http.MethodGet, "/v1/federation/alerts/my?scope=mine", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body)
	}
	got := decodeBody[biz.ListResult](t, rec)
	if got.Identity != "unbound" || got.Reason != "unbound" {
		t.Fatalf("result = %+v", got)
	}
}

func TestMyAlertsBoundWithIdentity(t *testing.T) {
	router, service, _ := newTestRouter(t, "user", testCrypto{}, &testQuerier{})
	if _, err := service.CreateConnection(context.Background(), biz.ConnectionInput{
		Kind: model.KindExternalAlert, Name: "primary",
		BaseURL: "http://morse.invalid", APIPath: "/api/v1/alerts",
	}, 1); err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}
	saveIdentityFilter(t, service, "mine")
	service.SetIdentityResolver(testIdentities{"email": {"a@b"}})
	rec := do(t, router, http.MethodGet, "/v1/federation/alerts/my?scope=mine", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body)
	}
	got := decodeBody[biz.ListResult](t, rec)
	if got.Identity != "bound" || got.Scope != "mine" {
		t.Fatalf("result = %+v", got)
	}
}

func TestAlertStats(t *testing.T) {
	router, service, _ := newTestRouter(t, "user", testCrypto{}, &testQuerier{})
	if _, err := service.CreateConnection(context.Background(), biz.ConnectionInput{
		Kind: model.KindExternalAlert, Name: "primary",
		BaseURL: "http://morse.invalid", APIPath: "/api/v1/alerts",
	}, 1); err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}
	rec := do(t, router, http.MethodGet, "/v1/federation/alerts/stats?days=7", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body)
	}
	got := decodeBody[biz.StatsResult](t, rec)
	if !got.Configured || got.Total == nil || *got.Total != 1 {
		t.Fatalf("stats = %+v", got)
	}
}

func TestFieldPathsRequireAdmin(t *testing.T) {
	userRouter, _, _ := newTestRouter(t, "user", testCrypto{}, &testQuerier{})
	rec := do(t, userRouter, http.MethodPost, "/v1/federation/field-paths?kind=external_alert", nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body)
	}
}

func TestListTicketsIsReadableAndConfigured(t *testing.T) {
	router, service, _ := newTestRouter(t, "user", testCrypto{}, &testQuerier{})
	if _, err := service.CreateConnection(context.Background(), biz.ConnectionInput{
		Kind: model.KindITSMTicket, Name: "itsm",
		BaseURL: "http://itsm.invalid", APIPath: "/api/v1/webhook/dingtalk/database/incidents",
	}, 1); err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}
	rec := do(t, router, http.MethodGet, "/v1/federation/tickets?days=30&status=RUNNING", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body)
	}
	got := decodeBody[biz.ListResult](t, rec)
	if !got.Configured || got.Kind != model.KindITSMTicket || got.Total != 1 {
		t.Fatalf("result = %+v", got)
	}
}
