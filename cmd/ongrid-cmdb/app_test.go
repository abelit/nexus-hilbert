package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	cmdbfilebiz "github.com/ongridio/ongrid/internal/cmdb/biz/file"
	cmdbdata "github.com/ongridio/ongrid/internal/cmdb/data"
	"github.com/ongridio/ongrid/internal/pkg/auth"
	"github.com/ongridio/ongrid/internal/pkg/config"
	"github.com/ongridio/ongrid/internal/pkg/dbx"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// newTestApp wires the real CMDB handlers over a migrated SQLite database.
// Nothing is mocked: the test covers the production construction path, the
// JWT middleware and the router.
func newTestApp(t *testing.T) (http.Handler, *auth.Signer) {
	t.Helper()
	db, err := dbx.Open(config.DBConfig{Dialect: "sqlite", Path: filepath.Join(t.TempDir(), "cmdb.db")}, nil)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := dbx.RunMigrationsLocked(context.Background(), db, 10*time.Second, nil, cmdbdata.Migrate); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	signer := auth.NewSigner("test-secret", time.Minute, time.Hour)
	log := testLogger()
	handlers, closeTriggers := buildHandlers(db, log, fileOptions(t))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := closeTriggers(ctx); err != nil {
			t.Logf("close trigger dispatcher: %v", err)
		}
	})
	return newRouter(db, signer, handlers, "test"), signer
}

func fileOptions(t *testing.T) cmdbfilebiz.Options {
	t.Helper()
	return cmdbfilebiz.Options{
		DefaultLocalPath:     filepath.Join(t.TempDir(), "cmdb-files"),
		DefaultPreviewURL:    "http://127.0.0.1:8012/onlinePreview",
		DefaultMaxFileSizeMB: 50,
		SignerSecret:         "test-secret",
	}
}

func tokenFor(t *testing.T, signer *auth.Signer, admin bool) string {
	t.Helper()
	role := "user"
	isSuper := false
	if admin {
		role = "admin"
		isSuper = true
	}
	tok, err := signer.SignAccess(auth.Claims{UserID: 7, Email: "tester@example.com", Role: role, IsSuperuser: isSuper})
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return tok
}

func request(t *testing.T, h http.Handler, method, path, token string, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestHealthAndReadyProbesAreUnauthenticated(t *testing.T) {
	app, _ := newTestApp(t)

	if rec := request(t, app, http.MethodGet, "/healthz", "", ""); rec.Code != http.StatusOK || rec.Body.String() != "ok" {
		t.Fatalf("GET /healthz = %d %q", rec.Code, rec.Body.String())
	}
	if rec := request(t, app, http.MethodGet, "/readyz", "", ""); rec.Code != http.StatusOK || rec.Body.String() != "ready" {
		t.Fatalf("GET /readyz = %d %q", rec.Code, rec.Body.String())
	}
}

func TestCMDBRoutesRequireBearerToken(t *testing.T) {
	app, _ := newTestApp(t)
	for _, path := range []string{"/api/v1/cmdb/health", "/api/v1/cmdb/ci-types"} {
		if rec := request(t, app, http.MethodGet, path, "", ""); rec.Code != http.StatusUnauthorized {
			t.Fatalf("GET %s without token = %d, want 401", path, rec.Code)
		}
	}
}

func TestCMDBHealthAndListWithAdminToken(t *testing.T) {
	app, signer := newTestApp(t)
	token := tokenFor(t, signer, true)

	rec := request(t, app, http.MethodGet, "/api/v1/cmdb/health", token, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/cmdb/health = %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "generation") {
		t.Fatalf("health body = %s, want schema lineage", rec.Body.String())
	}

	rec = request(t, app, http.MethodGet, "/api/v1/cmdb/ci-types", token, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/cmdb/ci-types = %d %s", rec.Code, rec.Body.String())
	}
	var list struct {
		Items []json.RawMessage `json:"items"`
		Total int               `json:"total"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode ci-types: %v (%s)", err, rec.Body.String())
	}
	if list.Total != 0 || len(list.Items) != 0 {
		t.Fatalf("fresh database ci-types = %+v, want empty", list)
	}
}

// The pool's routes must reach a wired use case, not the ErrNotWiredYet
// placeholder: a 200 with an empty page is the difference between "no sightings
// yet" and "the composition root forgot WithPool".
func TestDiscoveryPoolIsWired(t *testing.T) {
	app, signer := newTestApp(t)
	token := tokenFor(t, signer, true)

	for _, path := range []string{
		"/api/v1/cmdb/discovery/adc?type_id=1",
		"/api/v1/cmdb/discovery/adc/counter?type_id=1",
		"/api/v1/cmdb/discovery/adc/ci-types",
		"/api/v1/cmdb/discovery/adc/exec-histories?type_id=1",
	} {
		rec := request(t, app, http.MethodGet, path, token, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s = %d %s", path, rec.Code, rec.Body.String())
		}
	}
}

// The global history reads are admin-only; one instance's history is not.
func TestHistoryAuthz(t *testing.T) {
	app, signer := newTestApp(t)
	user := tokenFor(t, signer, false)
	admin := tokenFor(t, signer, true)

	if rec := request(t, app, http.MethodGet, "/api/v1/cmdb/history/attributes", user, ""); rec.Code != http.StatusForbidden {
		t.Fatalf("non-admin GET history = %d %s, want 403", rec.Code, rec.Body.String())
	}
	rec := request(t, app, http.MethodGet, "/api/v1/cmdb/history/attributes", admin, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("admin GET history = %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"items"`) {
		t.Fatalf("history body = %s, want the list shape", rec.Body.String())
	}
	if rec := request(t, app, http.MethodGet, "/api/v1/cmdb/history/ci/100", user, ""); rec.Code != http.StatusOK {
		t.Fatalf("user GET instance history = %d %s, want 200", rec.Code, rec.Body.String())
	}
}

// The topology reads must reach the store, not the ErrNotWiredYet placeholder.
func TestTopologyIsWired(t *testing.T) {
	app, signer := newTestApp(t)
	user := tokenFor(t, signer, false)
	admin := tokenFor(t, signer, true)

	for _, path := range []string{
		"/api/v1/cmdb/topology-views",
		"/api/v1/cmdb/topology-views/groups",
	} {
		if rec := request(t, app, http.MethodGet, path, user, ""); rec.Code != http.StatusOK {
			t.Fatalf("GET %s = %d %s", path, rec.Code, rec.Body.String())
		}
	}
	if rec := request(t, app, http.MethodPost, "/api/v1/cmdb/topology-views", user, `{"name":"x"}`); rec.Code != http.StatusForbidden {
		t.Fatalf("non-admin create view = %d, want 403", rec.Code)
	}
	if rec := request(t, app, http.MethodPost, "/api/v1/cmdb/topology-views", admin, `{"name":"x"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("admin create view with no central model = %d %s, want 400", rec.Code, rec.Body.String())
	}
}

func TestAdminGateRejectsNonAdminWrite(t *testing.T) {
	app, signer := newTestApp(t)
	body := `{"name":"runs_on","color":"#1890ff"}`

	rec := request(t, app, http.MethodPost, "/api/v1/cmdb/relation-types", tokenFor(t, signer, false), body)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-admin POST relation-types = %d %s, want 403", rec.Code, rec.Body.String())
	}

	rec = request(t, app, http.MethodPost, "/api/v1/cmdb/relation-types", tokenFor(t, signer, true), body)
	if rec.Code < 200 || rec.Code >= 300 {
		t.Fatalf("admin POST relation-types = %d %s, want 2xx", rec.Code, rec.Body.String())
	}
}

func TestRouterEmitsHTTPSpanAndFiltersProbes(t *testing.T) {
	previous := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(previous)
		_ = provider.Shutdown(context.Background())
	})

	app, _ := newTestApp(t)

	// A normal request must produce one HTTP span. /version is used because
	// it needs no token; the API routes are covered by the auth tests.
	if rec := request(t, app, http.MethodGet, "/version", "", ""); rec.Code != http.StatusOK {
		t.Fatalf("GET /version = %d %s", rec.Code, rec.Body.String())
	}
	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("ended spans = %d, want 1", len(spans))
	}
	if !spans[0].SpanContext().IsValid() {
		t.Fatal("HTTP span has an invalid span context")
	}

	// Liveness/readiness probes are excluded so they do not crowd out real
	// request traces in Tempo.
	if rec := request(t, app, http.MethodGet, "/healthz", "", ""); rec.Code != http.StatusOK {
		t.Fatalf("GET /healthz = %d", rec.Code)
	}
	if got := len(recorder.Ended()); got != 1 {
		t.Fatalf("health probe emitted a span (ended spans = %d)", got)
	}
}

func TestRunHealthcheckProbesTheLocalServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	host := strings.TrimPrefix(srv.URL, "http://")
	if err := runHealthcheck(host, time.Second); err != nil {
		t.Fatalf("runHealthcheck(%s): %v", host, err)
	}
	if err := runHealthcheck("127.0.0.1:1", 100*time.Millisecond); err == nil {
		t.Fatal("runHealthcheck against a closed port succeeded")
	}
}

func multipartUpload(t *testing.T, h http.Handler, token, filename, content string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("files", filename)
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := part.Write([]byte(content)); err != nil {
		t.Fatalf("write form file: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/cmdb/ci/files", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestFileUploadDownloadCapabilityAndDelete(t *testing.T) {
	app, signer := newTestApp(t)
	token := tokenFor(t, signer, false)

	upload := multipartUpload(t, app, token, "report.txt", "hello attachment")
	if upload.Code != http.StatusOK {
		t.Fatalf("upload = %d %s", upload.Code, upload.Body.String())
	}
	var uploaded struct {
		Files []struct {
			FileID string `json:"file_id"`
		} `json:"files"`
	}
	if err := json.Unmarshal(upload.Body.Bytes(), &uploaded); err != nil || len(uploaded.Files) != 1 {
		t.Fatalf("upload body = %s (%v)", upload.Body.String(), err)
	}
	fileID := uploaded.Files[0].FileID
	if fileID == "" {
		t.Fatal("upload returned an empty file_id")
	}

	download := request(t, app, http.MethodGet, "/api/v1/cmdb/ci/files?file_id="+url.QueryEscape(fileID), token, "")
	if download.Code != http.StatusOK || download.Body.String() != "hello attachment" {
		t.Fatalf("download = %d %q", download.Code, download.Body.String())
	}
	if got := download.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("nosniff = %q", got)
	}

	preview := request(t, app, http.MethodPost, "/api/v1/cmdb/ci/files/preview-url", token, `{"file_id":"`+fileID+`"}`)
	if preview.Code != http.StatusOK {
		t.Fatalf("preview-url = %d %s", preview.Code, preview.Body.String())
	}
	var link struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(preview.Body.Bytes(), &link); err != nil || link.URL == "" {
		t.Fatalf("preview link = %s (%v)", preview.Body.String(), err)
	}
	public := request(t, app, http.MethodGet, link.URL, "", "")
	if public.Code != http.StatusOK || public.Body.String() != "hello attachment" {
		t.Fatalf("public capability = %d %q", public.Code, public.Body.String())
	}

	remove := request(t, app, http.MethodDelete, "/api/v1/cmdb/ci/files", token, `{"files":[{"file_id":"`+fileID+`"}]}`)
	if remove.Code != http.StatusOK {
		t.Fatalf("delete = %d %s", remove.Code, remove.Body.String())
	}
	missing := request(t, app, http.MethodGet, "/api/v1/cmdb/ci/files?file_id="+url.QueryEscape(fileID), token, "")
	if missing.Code != http.StatusNotFound {
		t.Fatalf("download after delete = %d %s", missing.Code, missing.Body.String())
	}
}

func TestFileSettingsPermissions(t *testing.T) {
	app, signer := newTestApp(t)
	admin := tokenFor(t, signer, true)
	user := tokenFor(t, signer, false)

	if rec := request(t, app, http.MethodGet, "/api/v1/cmdb/file-storage", admin, ""); rec.Code != http.StatusOK {
		t.Fatalf("admin storage = %d %s", rec.Code, rec.Body.String())
	}
	if rec := request(t, app, http.MethodGet, "/api/v1/cmdb/file-storage", user, ""); rec.Code != http.StatusForbidden {
		t.Fatalf("user storage = %d, want 403", rec.Code)
	}
	if rec := request(t, app, http.MethodGet, "/api/v1/cmdb/file-preview", user, ""); rec.Code != http.StatusOK {
		t.Fatalf("user preview = %d %s", rec.Code, rec.Body.String())
	}
	body := `{"preview_server_url":"http://kk.example/onlinePreview","force_updated_cache_types":["txt"]}`
	if rec := request(t, app, http.MethodPut, "/api/v1/cmdb/file-preview", admin, body); rec.Code != http.StatusOK {
		t.Fatalf("admin preview save = %d %s", rec.Code, rec.Body.String())
	}
	if rec := request(t, app, http.MethodPut, "/api/v1/cmdb/file-preview", user, body); rec.Code != http.StatusForbidden {
		t.Fatalf("user preview save = %d, want 403", rec.Code)
	}
}

// A committed instance write must reach the trigger's webhook and leave a
// firing row behind. This is the end-to-end shape the console reads: the
// resource drawer's "trigger records" tab and the operation history both come
// from c_ci_trigger_histories.
func TestInstanceWriteFiresAWebhookAndRecordsIt(t *testing.T) {
	hits := make(chan string, 4)
	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		hits <- string(body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	defer hook.Close()

	app, signer := newTestApp(t)
	admin := tokenFor(t, signer, true)
	user := tokenFor(t, signer, false)

	rec := request(t, app, http.MethodPost, "/api/v1/cmdb/attributes", admin,
		`{"name":"hostname","alias":"主机名","value_type":"2"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create attribute = %d %s", rec.Code, rec.Body.String())
	}

	rec = request(t, app, http.MethodPost, "/api/v1/cmdb/ci-types", admin,
		`{"name":"server","alias":"服务器","unique_key":"hostname"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create model = %d %s", rec.Code, rec.Body.String())
	}

	option, err := json.Marshal(map[string]any{
		"name": "hook", "enable": true, "action": "0",
		"webhooks": map[string]any{
			"method": "POST",
			"url":    hook.URL,
			"body":   `{"host":"{{ hostname }}"}`,
			"headers": map[string]any{
				"X-CI": "{{ _id }}",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	rec = request(t, app, http.MethodPost, "/api/v1/cmdb/ci-types/server/triggers", admin,
		`{"attr_id":null,"option":`+string(option)+`}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create trigger = %d %s", rec.Code, rec.Body.String())
	}
	var trigger struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &trigger); err != nil || trigger.ID == 0 {
		t.Fatalf("create trigger response = %s (%v)", rec.Body.String(), err)
	}

	updateOption, err := json.Marshal(map[string]any{
		"name": "hook-update", "enable": true, "action": "2",
		"webhooks": map[string]any{
			"method": "POST",
			"url":    hook.URL,
			"body":   `{"host":"{{ hostname }}"}`,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	rec = request(t, app, http.MethodPost, "/api/v1/cmdb/ci-types/server/triggers", admin,
		`{"attr_id":null,"option":`+string(updateOption)+`}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create update trigger = %d %s", rec.Code, rec.Body.String())
	}

	deleteOption, err := json.Marshal(map[string]any{
		"name": "hook-delete", "enable": true, "action": "1",
		"webhooks": map[string]any{
			"method": "POST",
			"url":    hook.URL,
			"body":   `{"host":"{{ hostname }}"}`,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	rec = request(t, app, http.MethodPost, "/api/v1/cmdb/ci-types/server/triggers", admin,
		`{"attr_id":null,"option":`+string(deleteOption)+`}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create delete trigger = %d %s", rec.Code, rec.Body.String())
	}

	rec = request(t, app, http.MethodPost, "/api/v1/cmdb/instances", user,
		`{"ci_type":"server","hostname":"web-01"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create instance = %d %s", rec.Code, rec.Body.String())
	}
	var created struct {
		CIID int64 `json:"ci_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil || created.CIID == 0 {
		t.Fatalf("create response = %s (%v)", rec.Body.String(), err)
	}

	select {
	case body := <-hits:
		if body != `{"host":"web-01"}` {
			t.Fatalf("webhook body = %q", body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the webhook was not called")
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		rec = request(t, app, http.MethodGet,
			"/api/v1/cmdb/history/ci/"+strconv.FormatInt(created.CIID, 10)+"/triggers", user, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("trigger history = %d %s", rec.Code, rec.Body.String())
		}
		var page struct {
			Items []struct {
				OperateType string `json:"operate_type"`
				RecordID    int64  `json:"record_id"`
				TriggerName string `json:"trigger_name"`
				IsOK        bool   `json:"is_ok"`
				Webhook     string `json:"webhook"`
			} `json:"items"`
			Total int `json:"total"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
			t.Fatalf("decode history: %v (%s)", err, rec.Body.String())
		}
		if page.Total > 0 {
			item := page.Items[0]
			if !item.IsOK || item.TriggerName != "hook" || item.OperateType != "0" {
				t.Fatalf("firing = %+v", item)
			}
			if item.RecordID == 0 {
				t.Fatalf("firing is not linked to its write record: %+v", item)
			}
			if !strings.Contains(item.Webhook, hook.URL) || !strings.Contains(item.Webhook, `"status":200`) {
				t.Fatalf("webhook history = %s", item.Webhook)
			}

			// The manual test route must go through the same sender and use a
			// real instance so its templates resolve.
			rec = request(t, app, http.MethodPost,
				"/api/v1/cmdb/ci-types/server/triggers/"+strconv.FormatInt(trigger.ID, 10)+"/test", admin, "")
			if rec.Code != http.StatusNoContent {
				t.Fatalf("test trigger = %d %s", rec.Code, rec.Body.String())
			}
			select {
			case body := <-hits:
				if body != `{"host":"web-01"}` {
					t.Fatalf("test webhook body = %q", body)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("the manual test did not call the webhook")
			}

			// An ordinary edit must fire the update-only rule and record its
			// action code, with the payload rendered from the committed values.
			rec = request(t, app, http.MethodPut,
				"/api/v1/cmdb/instances/"+strconv.FormatInt(created.CIID, 10), user,
				`{"hostname":"web-02"}`)
			if rec.Code != http.StatusOK {
				t.Fatalf("update instance = %d %s", rec.Code, rec.Body.String())
			}
			select {
			case body := <-hits:
				if body != `{"host":"web-02"}` {
					t.Fatalf("update webhook body = %q", body)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("the update webhook was not called")
			}

			updateDeadline := time.Now().Add(5 * time.Second)
			for {
				rec = request(t, app, http.MethodGet,
					"/api/v1/cmdb/history/ci/"+strconv.FormatInt(created.CIID, 10)+"/triggers", user, "")
				if rec.Code != http.StatusOK {
					t.Fatalf("trigger history after update = %d %s", rec.Code, rec.Body.String())
				}
				var afterUpdate struct {
					Items []struct {
						OperateType string `json:"operate_type"`
						TriggerName string `json:"trigger_name"`
						IsOK        bool   `json:"is_ok"`
					} `json:"items"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &afterUpdate); err != nil {
					t.Fatalf("decode history after update: %v (%s)", err, rec.Body.String())
				}
				for _, item := range afterUpdate.Items {
					if item.TriggerName == "hook-update" {
						if !item.IsOK || item.OperateType != "2" {
							t.Fatalf("update firing = %+v", item)
						}

						// A delete fires while the values still exist and
						// records a nullable record_id, cantor's delete shape.
						rec = request(t, app, http.MethodDelete,
							"/api/v1/cmdb/instances/"+strconv.FormatInt(created.CIID, 10), user, "")
						if rec.Code != http.StatusNoContent {
							t.Fatalf("delete instance = %d %s", rec.Code, rec.Body.String())
						}
						select {
						case body := <-hits:
							if body != `{"host":"web-02"}` {
								t.Fatalf("delete webhook body = %q", body)
							}
						case <-time.After(5 * time.Second):
							t.Fatal("the delete webhook was not called")
						}

						deleteDeadline := time.Now().Add(5 * time.Second)
						for {
							rec = request(t, app, http.MethodGet,
								"/api/v1/cmdb/history/ci/"+strconv.FormatInt(created.CIID, 10)+"/triggers", user, "")
							if rec.Code != http.StatusOK {
								t.Fatalf("trigger history after delete = %d %s", rec.Code, rec.Body.String())
							}
							var afterDelete struct {
								Items []struct {
									OperateType string `json:"operate_type"`
									TriggerName string `json:"trigger_name"`
									IsOK        bool   `json:"is_ok"`
								} `json:"items"`
							}
							if err := json.Unmarshal(rec.Body.Bytes(), &afterDelete); err != nil {
								t.Fatalf("decode history after delete: %v (%s)", err, rec.Body.String())
							}
							for _, deleted := range afterDelete.Items {
								if deleted.TriggerName == "hook-delete" {
									if !deleted.IsOK || deleted.OperateType != "1" {
										t.Fatalf("delete firing = %+v", deleted)
									}
									return
								}
							}
							if time.Now().After(deleteDeadline) {
								t.Fatal("no delete firing history was written")
							}
							time.Sleep(50 * time.Millisecond)
						}
					}
				}
				if time.Now().After(updateDeadline) {
					t.Fatal("no update firing history was written")
				}
				time.Sleep(50 * time.Millisecond)
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("no firing history was written")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
