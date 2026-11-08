package cmdb

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
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
		ToolNameGetCIRelations: false, ToolNameQueryRelationPath: false,
		ToolNameFindCITypePath: false, ToolNameGetCIHistory: false,
		ToolNameRelationGraph: false,
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

func TestGetCIRelationsDirection(t *testing.T) {
	for _, tc := range []struct {
		direction string
		path      string
	}{
		{"down", "/api/v1/cmdb/ci-relations/9/children"},
		{"up", "/api/v1/cmdb/ci-relations/9/parents"},
	} {
		t.Run(tc.direction, func(t *testing.T) {
			c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != tc.path {
					t.Errorf("path = %q, want %q", r.URL.Path, tc.path)
				}
				if r.URL.Query().Get("page") != "2" || r.URL.Query().Get("count") != "10" {
					t.Errorf("query = %v", r.URL.Query())
				}
				if r.URL.Query().Get("relation_type_id") != "4" {
					t.Errorf("relation_type_id = %q", r.URL.Query().Get("relation_type_id"))
				}
				_ = json.NewEncoder(w).Encode(map[string]any{
					"items":    []map[string]any{{"relation_id": 1, "ci_id": 10, "type_id": 3, "relation_type_id": 4}},
					"numfound": 1, "page": 2,
				})
			})
			got := runTool(t, c, ToolNameGetCIRelations, `{"ci_id":9,"direction":"`+tc.direction+`","page":2,"count":10,"relation_type_id":4}`)
			items, _ := got["items"].([]any)
			if len(items) != 1 {
				t.Fatalf("items = %v", got["items"])
			}
		})
	}
}

func TestQueryRelationPathBody(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/cmdb/ci-relations/path/s" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		source, _ := body["source"].(map[string]any)
		if source["type_id"] != float64(3) || source["q"] != "hostname:web-01" {
			t.Errorf("source = %v", body["source"])
		}
		target, _ := body["target"].(map[string]any)
		if fmt.Sprint(target["type_ids"]) != "[4 5]" {
			t.Errorf("target = %v", body["target"])
		}
		_, _ = w.Write([]byte(`{"numfound":1,"total":1,"page":1,"paths":{"a":[[1,2]]},"id2ci":{}}`))
	})
	got := runTool(t, c, ToolNameQueryRelationPath, `{"source":{"type_id":3,"q":"hostname:web-01"},"target":{"type_ids":[4,5],"q":""},"path":[[3,4]],"count":5}`)
	if got["numfound"] != float64(1) || got["paths"] == nil {
		t.Fatalf("got = %v", got)
	}
}

func TestFindCITypePathQuery(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/cmdb/ci-type-relations/path" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.URL.Query().Get("source_type_id") != "3" || r.URL.Query().Get("target_type_ids") != "4,5" {
			t.Errorf("query = %v", r.URL.Query())
		}
		_, _ = w.Write([]byte(`{"paths":[{"chain":[3,4]}]}`))
	})
	got := runTool(t, c, ToolNameFindCITypePath, `{"source_type_id":3,"target_type_ids":"4,5"}`)
	if got["paths"] == nil {
		t.Fatalf("got = %v", got)
	}
}

func TestGetCIHistoryPaging(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/cmdb/history/ci/9" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.URL.Query().Get("page") != "2" || r.URL.Query().Get("page_size") != "10" {
			t.Errorf("query = %v", r.URL.Query())
		}
		_, _ = w.Write([]byte(`{"items":[{"attribute":"name"}],"total":1,"page":2,"page_size":10}`))
	})
	got := runTool(t, c, ToolNameGetCIHistory, `{"ci_id":9,"page":2,"page_size":10}`)
	if got["total"] != float64(1) {
		t.Fatalf("got = %v", got)
	}
}

func TestGetCIHonorsExplicitFields(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		values := map[string]any{}
		for i := 0; i < 8; i++ {
			values[fmt.Sprintf("f%d", i)] = i
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ci_id": 5, "type_id": 3, "values": values})
	})
	got := runTool(t, c, ToolNameGetCI, `{"ci_id":5,"fields":"f0,f1,f2,f3,f4,f5,f6,f7"}`)
	ci, _ := got["ci"].(map[string]any)
	for i := 0; i < 8; i++ {
		key := fmt.Sprintf("f%d", i)
		if _, ok := ci[key]; !ok {
			t.Fatalf("explicit field %q was dropped: %v", key, ci)
		}
	}
}

func TestSearchCIHonorsFL(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		row := map[string]any{"_id": 1, "ci_id": 1, "ci_type": "host"}
		for i := 0; i < 8; i++ {
			row[fmt.Sprintf("f%d", i)] = i
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"numfound": 1, "page": 1, "result": []map[string]any{row}})
	})
	got := runTool(t, c, ToolNameSearchCI, `{"q":"host","fl":"f0,f1,f2,f3,f4,f5,f6,f7"}`)
	items, _ := got["items"].([]any)
	row, _ := items[0].(map[string]any)
	for i := 0; i < 8; i++ {
		key := fmt.Sprintf("f%d", i)
		if _, ok := row[key]; !ok {
			t.Fatalf("explicit fl field %q was dropped: %v", key, row)
		}
	}
}

func TestRelationGraphBounds(t *testing.T) {
	var childRequests int
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/children") {
			childRequests++
			id, _ := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/v1/cmdb/ci-relations/"), "/children"))
			items := []map[string]any{}
			if id < 5 {
				items = append(items, map[string]any{"relation_id": id, "ci_id": id + 1, "type_id": 3, "relation_type_id": 1})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"items": items, "numfound": len(items), "page": 1})
			return
		}
		if r.URL.Path == "/api/v1/cmdb/ci-types" {
			_, _ = w.Write([]byte(`{"items":[]}`))
			return
		}
		if r.URL.Path == "/api/v1/cmdb/ci-type-relations" {
			_, _ = w.Write([]byte(`{"items":[]}`))
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/cmdb/instances/") {
			id, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/api/v1/cmdb/instances/"))
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ci_id": id, "type_id": 3,
				"values": map[string]any{"hostname": fmt.Sprintf("h-%d", id)},
			})
			return
		}
		t.Fatalf("unexpected path %q", r.URL.Path)
	})

	got := runTool(t, c, ToolNameRelationGraph, `{"ci_id":1,"direction":"down","depth":99,"max_nodes":999}`)
	nodes, _ := got["nodes"].([]any)
	if len(nodes) != 4 { // 1 → 2 → 3 → 4; depth clamped to 3
		t.Fatalf("nodes = %d, want 4: %v", len(nodes), got)
	}
	if childRequests != 3 { // one request per level, not 99
		t.Fatalf("children requests = %d, want 3", childRequests)
	}

	got = runTool(t, c, ToolNameRelationGraph, `{"ci_id":1,"direction":"down","depth":3,"max_nodes":2}`)
	if got["truncated"] != true {
		t.Fatalf("truncated = %v, want true", got["truncated"])
	}
	if nodes, _ := got["nodes"].([]any); len(nodes) > 2 {
		t.Fatalf("nodes = %d, want <= 2", len(nodes))
	}
}

func TestRelationGraphBoundsFanOut(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/children"):
			id, _ := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/v1/cmdb/ci-relations/"), "/children"))
			items := make([]map[string]any, 0, 30)
			for i := 1; i <= 30; i++ {
				items = append(items, map[string]any{
					"relation_id": id*100 + i, "ci_id": i, "type_id": 3, "relation_type_id": 1,
				})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"items": items, "numfound": len(items), "page": 1})
		case strings.HasSuffix(r.URL.Path, "/parents"):
			id, _ := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/v1/cmdb/ci-relations/"), "/parents"))
			items := []map[string]any{}
			if id > 1 {
				items = append(items, map[string]any{
					"relation_id": (id-1)*100 + id, "ci_id": id - 1, "type_id": 3, "relation_type_id": 1,
				})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"items": items, "numfound": len(items), "page": 1})
		case r.URL.Path == "/api/v1/cmdb/ci-types":
			_, _ = w.Write([]byte(`{"items":[]}`))
		case r.URL.Path == "/api/v1/cmdb/ci-type-relations":
			_, _ = w.Write([]byte(`{"items":[]}`))
		case strings.HasPrefix(r.URL.Path, "/api/v1/cmdb/instances/"):
			id, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/api/v1/cmdb/instances/"))
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ci_id": id, "type_id": 3,
				"values": map[string]any{"hostname": fmt.Sprintf("h-%d", id)},
			})
		default:
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
	})

	got := runTool(t, c, ToolNameRelationGraph, `{"ci_id":1,"direction":"both","depth":3,"max_nodes":5}`)
	nodes, _ := got["nodes"].([]any)
	if len(nodes) > 5 {
		t.Fatalf("nodes = %d, want <= 5", len(nodes))
	}
	edges, _ := got["edges"].([]any)
	if len(edges) > 10 {
		t.Fatalf("edges = %d, want <= 10 (2*max_nodes)", len(edges))
	}
	nodeSet := map[float64]bool{}
	for _, n := range nodes {
		nodeSet[n.(map[string]any)["id"].(float64)] = true
	}
	seen := map[string]bool{}
	for _, e := range edges {
		edge := e.(map[string]any)
		key := fmt.Sprintf("%v->%v", edge["source"], edge["target"])
		if seen[key] {
			t.Fatalf("duplicate edge %s", key)
		}
		seen[key] = true
		if !nodeSet[edge["source"].(float64)] || !nodeSet[edge["target"].(float64)] {
			t.Fatalf("dangling edge %v", edge)
		}
	}
	if got["truncated"] != true {
		t.Fatalf("truncated = %v, want true", got["truncated"])
	}
}

func TestRelationGraphRenderPayload(t *testing.T) {
	var childrenHits, parentHits int
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/cmdb/ci-types":
			_, _ = w.Write([]byte(`{"items":[{"id":3,"name":"host","alias":"主机"},{"id":4,"name":"db","alias":"数据库"}]}`))
		case r.URL.Path == "/api/v1/cmdb/ci-type-relations":
			_, _ = w.Write([]byte(`{"items":[{"parent":{"type":{"id":3},"relation_type":{"id":7,"name":"runs_on"}},"child":{"type":{"id":4},"relation_type":{"id":7,"name":"runs_on"}}}]}`))
		case r.URL.Path == "/api/v1/cmdb/ci-relations/1/children":
			childrenHits++
			_, _ = w.Write([]byte(`{"items":[{"relation_id":1,"ci_id":2,"type_id":4,"relation_type_id":7}],"numfound":1,"page":1}`))
		case r.URL.Path == "/api/v1/cmdb/ci-relations/1/parents":
			parentHits++
			_, _ = w.Write([]byte(`{"items":[{"relation_id":2,"ci_id":9,"type_id":3,"relation_type_id":7}],"numfound":1,"page":1}`))
		case strings.HasPrefix(r.URL.Path, "/api/v1/cmdb/instances/"):
			id, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/api/v1/cmdb/instances/"))
			typeID := 3
			if id == 2 {
				typeID = 4
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ci_id": id, "type_id": typeID,
				"values": map[string]any{"hostname": fmt.Sprintf("h-%d", id)},
			})
		default:
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
	})

	got := runTool(t, c, ToolNameRelationGraph, `{"ci_id":1,"depth":1}`)
	root, _ := got["root"].(map[string]any)
	if root["id"] != float64(1) || root["type_name"] != "主机" {
		t.Fatalf("root = %v", root)
	}
	if got["direction"] != "both" {
		t.Fatalf("direction = %v, want both", got["direction"])
	}
	if childrenHits == 0 || parentHits == 0 {
		t.Fatalf("default direction must query both sides: children=%d parents=%d", childrenHits, parentHits)
	}
	counts, _ := got["counts"].(map[string]any)
	if counts["upstream"] != float64(1) || counts["downstream"] != float64(1) {
		t.Fatalf("counts = %v", counts)
	}
	edges, _ := got["edges"].([]any)
	labels := map[string]string{}
	for _, e := range edges {
		edge := e.(map[string]any)
		labels[fmt.Sprintf("%v->%v", edge["source"], edge["target"])] = fmt.Sprint(edge["label"])
	}
	if labels["1->2"] != "runs_on" || labels["9->1"] != "runs_on" {
		t.Fatalf("edge labels = %v", labels)
	}
	nodes, _ := got["nodes"].([]any)
	if len(nodes) != 3 {
		t.Fatalf("nodes = %d, want 3", len(nodes))
	}
}

func TestRelationGraphCountsUseFirstHopNumfound(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/cmdb/ci-types":
			_, _ = w.Write([]byte(`{"items":[]}`))
		case r.URL.Path == "/api/v1/cmdb/ci-type-relations":
			_, _ = w.Write([]byte(`{"items":[]}`))
		case r.URL.Path == "/api/v1/cmdb/ci-relations/1/children":
			_, _ = w.Write([]byte(`{"items":[{"relation_id":1,"ci_id":2,"type_id":3,"relation_type_id":1}],"numfound":5,"page":1}`))
		case r.URL.Path == "/api/v1/cmdb/ci-relations/1/parents":
			_, _ = w.Write([]byte(`{"items":[],"numfound":0,"page":1}`))
		case strings.HasPrefix(r.URL.Path, "/api/v1/cmdb/instances/"):
			id, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/api/v1/cmdb/instances/"))
			_ = json.NewEncoder(w).Encode(map[string]any{"ci_id": id, "type_id": 3, "values": map[string]any{}})
		default:
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
	})

	got := runTool(t, c, ToolNameRelationGraph, `{"ci_id":1,"direction":"down","depth":1}`)
	counts, _ := got["counts"].(map[string]any)
	if counts["downstream"] != float64(5) {
		t.Fatalf("downstream = %v, want 5 (numfound)", counts)
	}
	if got["truncated"] != true {
		t.Fatalf("truncated = %v, want true when numfound exceeds returned rows", got["truncated"])
	}
}

func TestRelationGraphResolvesRootByQuery(t *testing.T) {
	var searchHits int
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/cmdb/ci/s":
			searchHits++
			if r.URL.Query().Get("q") != "hostname:web-01" || r.URL.Query().Get("count") != "1" {
				t.Errorf("search query = %v", r.URL.Query())
			}
			_, _ = w.Write([]byte(`{"result":[{"_id":1}],"numfound":1,"page":1}`))
		case r.URL.Path == "/api/v1/cmdb/ci-types":
			_, _ = w.Write([]byte(`{"items":[]}`))
		case r.URL.Path == "/api/v1/cmdb/ci-type-relations":
			_, _ = w.Write([]byte(`{"items":[]}`))
		case strings.HasSuffix(r.URL.Path, "/children"), strings.HasSuffix(r.URL.Path, "/parents"):
			_, _ = w.Write([]byte(`{"items":[],"numfound":0,"page":1}`))
		case strings.HasPrefix(r.URL.Path, "/api/v1/cmdb/instances/"):
			id, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/api/v1/cmdb/instances/"))
			_ = json.NewEncoder(w).Encode(map[string]any{"ci_id": id, "type_id": 3, "values": map[string]any{"hostname": "web-01"}})
		default:
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
	})

	got := runTool(t, c, ToolNameRelationGraph, `{"q":"hostname:web-01","depth":1}`)
	if searchHits != 1 {
		t.Fatalf("search hits = %d, want 1", searchHits)
	}
	root, _ := got["root"].(map[string]any)
	if root["id"] != float64(1) {
		t.Fatalf("root = %v", root)
	}
}
