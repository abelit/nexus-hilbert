package discovery

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	discoverybiz "github.com/ongridio/ongrid/internal/cmdb/biz/discovery"
	discoverystore "github.com/ongridio/ongrid/internal/cmdb/data/discovery/store"
)

type agentTestModels struct{}

func (agentTestModels) ResolveCIType(_ context.Context, ref string) (*discoverybiz.CITypeRef, error) {
	if ref == "1" {
		return &discoverybiz.CITypeRef{ID: 1, Name: "host", UniqueKey: "hostname"}, nil
	}
	return nil, nil
}

func TestAgentHTTPRegisterSyncReport(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:agenthttp?mode=memory&cache=shared"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := discoverystore.Migrate(db); err != nil {
		t.Fatal(err)
	}
	repo := discoverystore.NewRepo(db)
	signingPublic, signingPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	uc := discoverybiz.NewUsecase(repo).
		WithAgents(repo).
		WithPool(repo).
		WithModels(agentTestModels{}).
		WithSigningKey(signingPrivate)
	ctx := context.Background()

	rule, err := repo.CreateRule(ctx, discoverybiz.RuleWrite{
		Name: "server", Type: strPtr("agent"),
	})
	if err != nil {
		t.Fatal(err)
	}
	agentID := "0xabc"
	cron := "*/5 * * * *"
	target, err := repo.CreateTarget(ctx, discoverybiz.TargetWrite{
		TypeID: 1, AdrID: &rule.ID, AgentID: &agentID, Cron: &cron,
		Attributes: map[string]any{"machine_uuid": "hostname"},
		Enabled:    boolPtr(true),
	})
	if err != nil {
		t.Fatal(err)
	}

	created, err := uc.CreateAgentPrincipal(ctx, "test", "riemann-1", nil, time.Hour,
		discoverybiz.Actor{UserID: 1, IsAdmin: true})
	if err != nil {
		t.Fatal(err)
	}

	handler := NewHandler(uc)
	router := chi.NewRouter()
	router.Route("/api/v1/cmdb/discovery/agent", func(r chi.Router) {
		r.Use(handler.AgentMiddleware())
		handler.RegisterAgent(r)
	})
	srv := httptest.NewServer(router)
	defer srv.Close()

	post := func(path string, body any) (int, map[string]any) {
		raw, _ := json.Marshal(body)
		req, _ := http.NewRequest(http.MethodPost, srv.URL+path, bytes.NewReader(raw))
		req.Header.Set("Authorization", "Bearer "+created.Secret)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	status, registered := post("/api/v1/cmdb/discovery/agent/register", map[string]any{
		"euler_id": "0xabc", "riemann_id": "riemann-1", "hostname": "host-1",
		"capabilities": map[string]any{"roles": []string{"host"}},
	})
	if status != http.StatusOK {
		t.Fatalf("register status=%d body=%v", status, registered)
	}
	anchor, _ := base64.StdEncoding.DecodeString(fmt.Sprint(registered["task_signing_public_key"]))
	if !bytes.Equal(anchor, signingPublic) || registered["task_signing_key_id"] == "" {
		t.Fatalf("register did not return the task signing anchor: %v", registered)
	}

	status, body := post("/api/v1/cmdb/discovery/agent/tasks/sync", map[string]any{
		"euler_id": "0xabc",
	})
	if status != http.StatusOK {
		t.Fatalf("sync status=%d body=%v", status, body)
	}
	changed, _ := body["changed"].([]any)
	if len(changed) != 1 {
		t.Fatalf("changed = %v", body["changed"])
	}
	task := changed[0].(map[string]any)
	if task["task_id"] != fmt.Sprintf("t:%d", target.ID) {
		t.Fatalf("task id = %v, want t:%d", task["task_id"], target.ID)
	}
	if task["collect_key"] != "server" || task["unique_key"] != "machine_uuid" {
		t.Fatalf("task = %v", task)
	}
	if task["signature"] == "" || task["signing_key_id"] != registered["task_signing_key_id"] {
		t.Fatalf("task is not signed with the registered key: %v", task)
	}

	instance := []byte(`{"machine_uuid":"m-1","hostname":"host-1"}`)
	status, body = post("/api/v1/cmdb/discovery/agent/reports", map[string]any{
		"euler_id": "0xabc",
		"reports": []map[string]any{{
			"report_id": "r-1", "task_id": task["task_id"], "instance_json": instance,
		}},
	})
	if status != http.StatusOK {
		t.Fatalf("reports status=%d body=%v", status, body)
	}
	results, _ := body["results"].([]any)
	if len(results) != 1 || results[0].(map[string]any)["status"] != "accepted" {
		t.Fatalf("report results = %v", body["results"])
	}

	rows, total, err := repo.ListPool(ctx, discoverybiz.PoolFilter{TypeID: 1, Page: 1, PageSize: 10})
	if err != nil || total != 1 || len(rows) != 1 {
		t.Fatalf("pool rows=%d total=%d err=%v", len(rows), total, err)
	}
	if rows[0].UniqueValue == nil || *rows[0].UniqueValue != "m-1" {
		t.Fatalf("pool row = %+v", rows[0])
	}
	_ = target

	status, body = post("/api/v1/cmdb/discovery/agent/exec-logs", map[string]any{
		"euler_id": "0xabc",
		"logs": []map[string]any{{
			"log_id": "l-1", "task_id": task["task_id"], "success": true, "stdout": "collected 1",
		}},
	})
	if status != http.StatusOK {
		t.Fatalf("logs status=%d body=%v", status, body)
	}
	logs, totalLogs, err := repo.ListExecHistories(ctx, 1, 1, 10)
	if err != nil || totalLogs == 0 || len(logs) == 0 {
		t.Fatalf("exec logs = %+v total=%d err=%v", logs, totalLogs, err)
	}
}

func strPtr(v string) *string { return &v }
func boolPtr(v bool) *bool    { return &v }
