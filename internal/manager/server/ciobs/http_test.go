package ciobs_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	ciobsbiz "github.com/ongridio/ongrid/internal/manager/biz/ciobs"
	federationbiz "github.com/ongridio/ongrid/internal/manager/biz/federation"
	ciobsdata "github.com/ongridio/ongrid/internal/manager/data/ciobs/store"
	ciobsserver "github.com/ongridio/ongrid/internal/manager/server/ciobs"
	ciobsservice "github.com/ongridio/ongrid/internal/manager/service/ciobs"
	"github.com/ongridio/ongrid/internal/pkg/promquery"
	"github.com/ongridio/ongrid/internal/pkg/tenantctx"
)

type testCMDB struct{ instance *federationbiz.CMDBInstance }

func (c testCMDB) GetInstance(context.Context, uint64) (*federationbiz.CMDBInstance, error) {
	return c.instance, nil
}

type testProm struct{ alerts []promquery.Alert }

func (p testProm) Alerts(context.Context) ([]promquery.Alert, error) { return p.alerts, nil }

type testToggles struct{ values map[string]string }

func (t *testToggles) Get(_ context.Context, category, key string) (string, bool, error) {
	value, ok := t.values[category+"/"+key]
	return value, ok, nil
}

func (t *testToggles) Set(_ context.Context, category, key, value string, _ bool) error {
	t.values[category+"/"+key] = value
	return nil
}

type testCrypto struct{}

func (testCrypto) Encrypt(plain string) (string, error) { return "enc:" + plain, nil }
func (testCrypto) Decrypt(cipher string) (string, error) {
	return strings.TrimPrefix(cipher, "enc:"), nil
}
func (testCrypto) Weak() bool { return false }

func newRouter(t *testing.T, role string) (*chi.Mux, *ciobsservice.Service) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := ciobsdata.Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	uc := ciobsbiz.NewUsecase(
		ciobsdata.NewRepo(db),
		testCMDB{instance: &federationbiz.CMDBInstance{ID: 7, TypeID: 3, Values: map[string]any{"hostname": "web-1"}}},
		testProm{alerts: []promquery.Alert{
			{Labels: map[string]string{"host": "web-1", "severity": "critical"}, State: "firing"},
		}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	uc.SetCrypto(testCrypto{})
	uc.SetPlatformToggles(&testToggles{values: map[string]string{}})
	service := ciobsservice.New(uc)
	handler := ciobsserver.NewHandler(service, slog.New(slog.NewTextHandler(io.Discard, nil)))
	router := chi.NewRouter()
	if role != "" {
		router.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ctx := tenantctx.With(r.Context(), tenantctx.Tenant{UserID: 1, Role: role, IsSuperuser: role == "admin"})
				next.ServeHTTP(w, r.WithContext(ctx))
			})
		})
	}
	handler.Register(router)
	return router, service
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

func decode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var out T
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	return out
}

func TestLinksRequireAdmin(t *testing.T) {
	admin, _ := newRouter(t, "admin")
	rec := do(t, admin, http.MethodPut, "/v1/observability/ci-links/grafana/3", map[string]any{
		"dashboard_uid": "d",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("admin status = %d body=%s", rec.Code, rec.Body)
	}
	user, _ := newRouter(t, "user")
	rec = do(t, user, http.MethodPut, "/v1/observability/ci-links/grafana/3", map[string]any{"dashboard_uid": "x"})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("user status = %d body=%s", rec.Code, rec.Body)
	}
	rec = do(t, user, http.MethodGet, "/v1/observability/ci/7/grafana", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("read status = %d body=%s", rec.Code, rec.Body)
	}
}

func TestGrafanaAndPrometheusReads(t *testing.T) {
	router, _ := newRouter(t, "admin")
	rec := do(t, router, http.MethodPut, "/v1/observability/ci-links/grafana/3", map[string]any{
		"dashboard_uid": "dash", "dashboard_slug": "detail",
		"var_mapping": []map[string]any{{"ci_attribute": "hostname", "var_name": "device_id"}},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("grafana save = %d body=%s", rec.Code, rec.Body)
	}
	rec = do(t, router, http.MethodPut, "/v1/observability/ci-links/prometheus/3", map[string]any{
		"label_mapping":  []map[string]any{{"ci_attribute": "hostname", "prom_label": "host"}},
		"extra_matchers": []map[string]any{{"label": "severity", "op": "eq", "value": "critical"}},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("prom save = %d body=%s", rec.Code, rec.Body)
	}

	grafana := decode[ciobsbiz.GrafanaResult](t, do(t, router, http.MethodGet, "/v1/observability/ci/7/grafana", nil))
	if !grafana.Configured || grafana.UID != "dash" || grafana.Vars["device_id"] != "web-1" {
		t.Fatalf("grafana = %+v", grafana)
	}
	alerts := decode[ciobsbiz.PromResult](t, do(t, router, http.MethodGet, "/v1/observability/ci/7/alerts", nil))
	if !alerts.Configured || alerts.Total != 1 {
		t.Fatalf("alerts = %+v", alerts)
	}
	linkage := decode[ciobsbiz.Linkage](t, do(t, router, http.MethodGet, "/v1/observability/ci-types/3/linkage", nil))
	if !linkage.Grafana || !linkage.Prometheus {
		t.Fatalf("linkage = %+v", linkage)
	}
	list := decode[struct {
		Items []ciobsbiz.LinkView `json:"items"`
	}](t, do(t, router, http.MethodGet, "/v1/observability/ci-links?provider=grafana", nil))
	if len(list.Items) != 1 {
		t.Fatalf("list = %+v", list)
	}
	if list.Items[0].CITypeID != 3 {
		t.Fatalf("ci type = %d", list.Items[0].CITypeID)
	}
}

func TestMonitoringConnectionsInternalAndExternal(t *testing.T) {
	admin, _ := newRouter(t, "admin")
	rec := do(t, admin, http.MethodGet, "/v1/observability/monitoring-connections?provider=grafana", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d body=%s", rec.Code, rec.Body)
	}
	initial := decode[struct {
		Items []ciobsbiz.ConnectionView `json:"items"`
	}](t, rec)
	if len(initial.Items) != 1 || initial.Items[0].Kind != "internal" || initial.Items[0].ID != 0 {
		t.Fatalf("initial = %+v", initial)
	}

	rec = do(t, admin, http.MethodPost, "/v1/observability/monitoring-connections?provider=grafana", map[string]any{
		"name": "external", "base_url": "https://grafana.example.com/grafana",
		"auth_type": "bearer", "auth_data": map[string]any{"token": "tok-secret"},
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), "tok-secret") {
		t.Fatalf("response leaks token: %s", rec.Body)
	}
	created := decode[ciobsbiz.ConnectionView](t, rec)
	if created.Kind != "external" || !created.TokenSet {
		t.Fatalf("created = %+v", created)
	}

	rec = do(t, admin, http.MethodGet, "/v1/observability/monitoring-connections?provider=grafana", nil)
	rows := decode[struct {
		Items []ciobsbiz.ConnectionView `json:"items"`
	}](t, rec)
	if len(rows.Items) != 2 {
		t.Fatalf("rows = %+v", rows)
	}

	user, _ := newRouter(t, "user")
	rec = do(t, user, http.MethodPost, "/v1/observability/monitoring-connections?provider=grafana", map[string]any{
		"name": "x", "base_url": "https://x.example.com", "auth_type": "none",
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("user status = %d body=%s", rec.Code, rec.Body)
	}

	rec = do(t, admin, http.MethodDelete, "/v1/observability/monitoring-connections/"+formatID(created.ID), nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d body=%s", rec.Code, rec.Body)
	}
}

func TestPlatformConnectionCanBeToggled(t *testing.T) {
	admin, _ := newRouter(t, "admin")
	rec := do(t, admin, http.MethodPut, "/v1/observability/monitoring-connections/platform?provider=grafana", map[string]any{"enabled": false})
	if rec.Code != http.StatusOK {
		t.Fatalf("toggle status = %d body=%s", rec.Code, rec.Body)
	}
	view := decode[ciobsbiz.ConnectionView](t, rec)
	if view.Enabled || view.Kind != "internal" {
		t.Fatalf("view = %+v", view)
	}

	rec = do(t, admin, http.MethodGet, "/v1/observability/monitoring-connections?provider=grafana", nil)
	rows := decode[struct {
		Items []ciobsbiz.ConnectionView `json:"items"`
	}](t, rec)
	if len(rows.Items) != 1 || rows.Items[0].Enabled {
		t.Fatalf("rows = %+v", rows.Items)
	}

	rec = do(t, admin, http.MethodPut, "/v1/observability/ci-links/grafana/3", map[string]any{"dashboard_uid": "dash"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("link status = %d body=%s", rec.Code, rec.Body)
	}

	user, _ := newRouter(t, "user")
	rec = do(t, user, http.MethodPut, "/v1/observability/monitoring-connections/platform?provider=grafana", map[string]any{"enabled": true})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("user status = %d body=%s", rec.Code, rec.Body)
	}
}

func formatID(id uint64) string {
	return strconv.FormatUint(id, 10)
}
