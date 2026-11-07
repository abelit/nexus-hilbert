package cmdb

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ongridio/ongrid/internal/manager/biz/aiops/tools/basetool"
	"github.com/ongridio/ongrid/internal/pkg/tenantctx"
)

func testClient(t *testing.T, h http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return New(srv.URL, func(tenantctx.Tenant) (string, error) { return "tok", nil }, nil, nil)
}

func findTool(t *testing.T, c *Client, name string) basetool.BaseTool {
	t.Helper()
	for _, tool := range Tools(c) {
		info, err := tool.Info(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if info.Name == name {
			return tool
		}
	}
	t.Fatalf("tool %q not found", name)
	return nil
}

func runTool(t *testing.T, c *Client, name, args string) map[string]any {
	t.Helper()
	tool := findTool(t, c, name)
	ctx := tenantctx.With(context.Background(), tenantctx.Tenant{UserID: 7, Role: "user"})
	out, err := tool.InvokableRun(ctx, args)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("%s returned non-object JSON %q: %v", name, out, err)
	}
	return got
}

func TestSearchCIShapesAndTruncates(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/cmdb/ci/s" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.URL.Query().Get("q") != "host" {
			t.Errorf("q = %q", r.URL.Query().Get("q"))
		}
		if r.URL.Query().Get("count") != "20" {
			t.Errorf("count = %q", r.URL.Query().Get("count"))
		}
		rows := make([]map[string]any, 21)
		for i := range rows {
			rows[i] = map[string]any{"_id": i + 1, "ci_id": i + 1, "ci_type": "host", "unique": fmt.Sprintf("h-%d", i)}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"numfound": 21, "page": 1, "result": rows})
	})

	got := runTool(t, c, ToolNameSearchCI, `{"q":"host"}`)
	items, _ := got["items"].([]any)
	if len(items) != 20 {
		t.Fatalf("items = %d, want 20", len(items))
	}
	if got["total"] != float64(21) {
		t.Fatalf("total = %v, want 21", got["total"])
	}
	if got["page"] != float64(1) {
		t.Fatalf("page = %v, want 1", got["page"])
	}
	if got["note"] == "" {
		t.Fatal("expected truncation note")
	}
}

func TestGetCISummaryAndFields(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/cmdb/instances/5" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.URL.Query().Get("fields") != "hostname,name" {
			t.Errorf("fields = %q", r.URL.Query().Get("fields"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ci_id": 5, "type_id": 3, "created_at": "2026-01-01T00:00:00Z",
			"values": map[string]any{
				"hostname": "web-01", "name": "web", "nested": map[string]any{"drop": true},
			},
		})
	})

	got := runTool(t, c, ToolNameGetCI, `{"ci_id":5,"fields":"hostname,name"}`)
	ci, _ := got["ci"].(map[string]any)
	if ci["hostname"] != "web-01" || ci["name"] != "web" {
		t.Fatalf("ci = %v", ci)
	}
	if _, ok := ci["values"]; ok {
		t.Fatalf("values should be flattened: %v", ci)
	}
	if _, ok := ci["nested"]; ok {
		t.Fatalf("nested object should be dropped: %v", ci)
	}
	if ci["ci_id"] != float64(5) {
		t.Fatalf("ci_id = %v", ci["ci_id"])
	}
}

func TestListCITypes(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/cmdb/ci-types" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []map[string]any{{"id": 3, "name": "host", "alias": "主机", "unique_key": "hostname", "enabled": true, "icon": "x"}},
			"total": 1,
		})
	})

	got := runTool(t, c, ToolNameListCITypes, `{"name":"host"}`)
	items, _ := got["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %d", len(items))
	}
	item, _ := items[0].(map[string]any)
	if item["name"] != "host" {
		t.Fatalf("item = %v", item)
	}
	if _, ok := item["icon"]; ok {
		t.Fatalf("icon should be dropped: %v", item)
	}
}

func TestGetCITypeMergesAttributes(t *testing.T) {
	var paths []string
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		switch r.URL.Path {
		case "/api/v1/cmdb/ci-types/3":
			_, _ = w.Write([]byte(`{"id":3,"name":"host"}`))
		case "/api/v1/cmdb/ci-types/3/attributes":
			_, _ = w.Write([]byte(`{"attributes":[{"id":1,"name":"hostname"}]}`))
		default:
			http.NotFound(w, r)
		}
	})

	got := runTool(t, c, ToolNameGetCIType, `{"ref":"3"}`)
	if got["type"] == nil || got["attributes"] == nil {
		t.Fatalf("got = %v", got)
	}
	if len(paths) != 2 {
		t.Fatalf("paths = %v", paths)
	}
}

func TestToolInfoIsReadOnly(t *testing.T) {
	c := testClient(t, func(http.ResponseWriter, *http.Request) {})
	want := map[string]bool{
		ToolNameSearchCI: false, ToolNameGetCI: false,
		ToolNameListCITypes: false, ToolNameGetCIType: false,
	}
	for _, tool := range Tools(c) {
		info, err := tool.Info(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := want[info.Name]; !ok {
			t.Fatalf("unexpected tool %q", info.Name)
		}
		want[info.Name] = true
		if info.Class != "read" {
			t.Fatalf("%s class = %q, want read", info.Name, info.Class)
		}
		if !json.Valid(info.Parameters) {
			t.Fatalf("%s schema is not valid JSON", info.Name)
		}
	}
	for name, seen := range want {
		if !seen {
			t.Fatalf("missing tool %q", name)
		}
	}
}

func TestToolsNilClient(t *testing.T) {
	if got := Tools(nil); got != nil {
		t.Fatalf("Tools(nil) = %v, want nil", got)
	}
}
