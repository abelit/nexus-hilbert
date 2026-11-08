package aiops

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	cmdb "github.com/ongridio/ongrid/internal/manager/biz/aiops/tools/cmdb"
	"github.com/ongridio/ongrid/internal/pkg/llm"
	"github.com/ongridio/ongrid/internal/pkg/tenantctx"
)

type fakeFormLLM struct {
	reply      string
	err        error
	lastPrompt string
}

func (f *fakeFormLLM) Chat(_ context.Context, req llm.ChatReq) (*llm.ChatResp, error) {
	var all strings.Builder
	for _, message := range req.Messages {
		all.WriteString(message.Content)
		all.WriteString("\n")
	}
	f.lastPrompt = all.String()
	if f.err != nil {
		return nil, f.err
	}
	return &llm.ChatResp{Assistant: llm.Message{Role: "assistant", Content: f.reply}}, nil
}

const testAttributesJSON = `{"attributes":[
 {"id":1,"name":"hostname","alias":"主机名","value_type":"2","is_required":true},
 {"id":2,"name":"cpu","alias":"CPU","value_type":"0"},
 {"id":3,"name":"tags","alias":"标签","value_type":"2","is_list":true},
 {"id":4,"name":"secret","alias":"密码","value_type":"2","is_password":true},
 {"id":5,"name":"fingerprint","alias":"指纹","value_type":"2","is_computed":true},
 {"id":6,"name":"docs","alias":"文档链接","value_type":"2","is_link":true},
 {"id":7,"name":"owner","alias":"负责人","value_type":"2","is_reference":true}
]}`

const testModelsJSON = `{"items":[{"id":1,"name":"host","alias":"主机"},{"id":2,"name":"vm","alias":"虚拟机"}]}`

const testRelationTypesJSON = `{"items":[
 {"id":1,"name":"runs_on","color":"#6366f1"},
 {"id":2,"name":"depends_on","color":""}
]}`

func newFormAssistTestHandler(t *testing.T, llmClient llm.Client) *Handler {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/attributes"):
			_, _ = io.WriteString(w, testAttributesJSON)
		case strings.HasSuffix(r.URL.Path, "/relation-types"):
			_, _ = io.WriteString(w, testRelationTypesJSON)
		case strings.HasSuffix(r.URL.Path, "/ci-types"):
			_, _ = io.WriteString(w, testModelsJSON)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	client := cmdb.New(srv.URL, func(tenantctx.Tenant) (string, error) { return "test-token", nil }, srv.Client(), slog.Default())
	if client == nil {
		t.Fatal("cmdb client is nil")
	}
	h := NewHandler(nil)
	h.SetLLMClient(llmClient)
	h.SetCMDBFormAssist(client)
	return h
}

func postFormAssist(t *testing.T, h *Handler, tenant tenantctx.Tenant, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/aiops/cmdb/form-assist", strings.NewReader(body))
	req = req.WithContext(tenantctx.With(req.Context(), tenant))
	rec := httptest.NewRecorder()
	h.cmdbFormAssist(rec, req)
	return rec
}

func decodeFormAssist(t *testing.T, rec *httptest.ResponseRecorder) cmdbFormAssistResponse {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var out cmdbFormAssistResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	return out
}

func TestCMDBFormAssistInstanceFiltersWritableFields(t *testing.T) {
	fake := &fakeFormLLM{reply: `{"values":{"hostname":"web-01","cpu":8,"tags":["a","b"],"secret":"x","fingerprint":"y","docs":"https://example","owner":3,"bogus":"z"},"explanations":{"hostname":"ok"}}`}
	h := newFormAssistTestHandler(t, fake)

	rec := postFormAssist(t, h, tenantctx.Tenant{UserID: 1, Role: "viewer"},
		`{"kind":"instance","ci_type":"host","intent":"一台 web 服务器"}`)
	out := decodeFormAssist(t, rec)

	if out.Values["hostname"] != "web-01" {
		t.Fatalf("hostname = %v", out.Values["hostname"])
	}
	if _, ok := out.Values["cpu"].(float64); !ok {
		t.Fatalf("cpu = %v (%T)", out.Values["cpu"], out.Values["cpu"])
	}
	if _, ok := out.Values["tags"].([]any); !ok {
		t.Fatalf("tags = %v (%T)", out.Values["tags"], out.Values["tags"])
	}
	for _, field := range []string{"secret", "fingerprint", "docs", "owner", "bogus"} {
		if _, ok := out.Values[field]; ok {
			t.Fatalf("non-writable field %q leaked into values", field)
		}
	}
	if !strings.Contains(strings.Join(out.Warnings, " "), "bogus") {
		t.Fatalf("warnings = %v", out.Warnings)
	}
}

func TestCMDBFormAssistInstanceDropsWrongType(t *testing.T) {
	fake := &fakeFormLLM{reply: `{"values":{"hostname":5,"cpu":8}}`}
	h := newFormAssistTestHandler(t, fake)

	out := decodeFormAssist(t, postFormAssist(t, h, tenantctx.Tenant{UserID: 1, Role: "viewer"},
		`{"kind":"instance","ci_type":"host","intent":"fill"}`))

	if _, ok := out.Values["hostname"]; ok {
		t.Fatalf("wrong-typed hostname survived: %v", out.Values["hostname"])
	}
	if _, ok := out.Values["cpu"]; !ok {
		t.Fatalf("cpu missing: %v", out.Values)
	}
}

func TestCMDBFormAssistInstanceHonoursFieldWhitelist(t *testing.T) {
	fake := &fakeFormLLM{reply: `{"values":{"hostname":"web-01","cpu":8}}`}
	h := newFormAssistTestHandler(t, fake)

	out := decodeFormAssist(t, postFormAssist(t, h, tenantctx.Tenant{UserID: 1, Role: "viewer"},
		`{"kind":"instance","ci_type":"host","intent":"fill","fields":["hostname"]}`))

	if _, ok := out.Values["cpu"]; ok {
		t.Fatalf("cpu was not requested but returned: %v", out.Values)
	}
	if out.Values["hostname"] != "web-01" {
		t.Fatalf("hostname = %v", out.Values["hostname"])
	}
}

func TestCMDBFormAssistModelRequiresAdmin(t *testing.T) {
	fake := &fakeFormLLM{reply: `{"name":"k8s_node","alias":"K8s 节点"}`}
	h := newFormAssistTestHandler(t, fake)

	rec := postFormAssist(t, h, tenantctx.Tenant{UserID: 1, Role: "viewer"},
		`{"kind":"model","intent":"K8s 节点模型"}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body.String())
	}
}

func TestCMDBFormAssistModelSanitizesParents(t *testing.T) {
	fake := &fakeFormLLM{reply: `{"name":"k8s_node","alias":"K8s 节点","unique_key":"hostname","parent_ids":[1,99],"warnings":[]}`}
	h := newFormAssistTestHandler(t, fake)

	out := decodeFormAssist(t, postFormAssist(t, h, tenantctx.Tenant{UserID: 1, IsSuperuser: true},
		`{"kind":"model","intent":"K8s 节点模型"}`))

	if out.Name != "k8s_node" || out.Alias != "K8s 节点" || out.UniqueKey != "hostname" {
		t.Fatalf("model = %+v", out)
	}
	if len(out.ParentIDs) != 1 || out.ParentIDs[0] != 1 {
		t.Fatalf("parent ids = %v", out.ParentIDs)
	}
	if !strings.Contains(strings.Join(out.Warnings, " "), "99") {
		t.Fatalf("warnings = %v", out.Warnings)
	}
}

func TestCMDBFormAssistAttributeRejectsDuplicatesAndBadTypes(t *testing.T) {
	fake := &fakeFormLLM{reply: `{"attributes":[
	 {"name":"hostname","alias":"重复","value_type":"2"},
	 {"name":"cpu_cores","alias":"核心数","value_type":"0","is_required":true},
	 {"name":"bad_type","alias":"坏类型","value_type":"9"}
	],"warnings":[]}`}
	h := newFormAssistTestHandler(t, fake)

	out := decodeFormAssist(t, postFormAssist(t, h, tenantctx.Tenant{UserID: 1, IsSuperuser: true},
		`{"kind":"attribute","model_ref":"host","intent":"增加核心数"}`))

	if len(out.Attributes) != 1 {
		t.Fatalf("attributes = %v", out.Attributes)
	}
	if out.Attributes[0]["name"] != "cpu_cores" {
		t.Fatalf("attribute = %v", out.Attributes[0])
	}
	warnings := strings.Join(out.Warnings, " ")
	if !strings.Contains(warnings, "hostname") || !strings.Contains(warnings, "bad_type") {
		t.Fatalf("warnings = %v", out.Warnings)
	}
}

func TestCMDBFormAssistAttributeAllowsGlobalDictionary(t *testing.T) {
	fake := &fakeFormLLM{reply: `{"attributes":[{"name":"room","alias":"机房","value_type":"2"}]}`}
	h := newFormAssistTestHandler(t, fake)

	out := decodeFormAssist(t, postFormAssist(t, h, tenantctx.Tenant{UserID: 1, Role: "admin"},
		`{"kind":"attribute","intent":"增加机房属性"}`))

	if len(out.Attributes) != 1 || out.Attributes[0]["name"] != "room" {
		t.Fatalf("attributes = %v", out.Attributes)
	}
}

func TestCMDBFormAssistRelationTypeSanitizesColour(t *testing.T) {
	fake := &fakeFormLLM{reply: `{"name":"runs_on","color":"blue"}`}
	h := newFormAssistTestHandler(t, fake)

	out := decodeFormAssist(t, postFormAssist(t, h, tenantctx.Tenant{UserID: 1, IsSuperuser: true},
		`{"kind":"relation_type","intent":"主机运行虚拟机"}`))

	if out.Name != "runs_on" {
		t.Fatalf("name = %q", out.Name)
	}
	if out.Color != "" {
		t.Fatalf("invalid colour kept: %q", out.Color)
	}
	warnings := strings.Join(out.Warnings, " ")
	if !strings.Contains(warnings, "already exists") || !strings.Contains(warnings, "invalid colour") {
		t.Fatalf("warnings = %v", out.Warnings)
	}
}

func TestCMDBFormAssistRelationTypeRequiresAdmin(t *testing.T) {
	h := newFormAssistTestHandler(t, &fakeFormLLM{reply: `{"name":"runs_on"}`})
	rec := postFormAssist(t, h, tenantctx.Tenant{UserID: 1, Role: "viewer"},
		`{"kind":"relation_type","intent":"x"}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body.String())
	}
}

func TestCMDBFormAssistModelRelationResolvesNamesToIDs(t *testing.T) {
	fake := &fakeFormLLM{reply: `{
		"source_model":"主机","target_model":"vm","relation_type":"runs_on","constraint":"1",
		"parent_attributes":["hostname"],"child_attributes":["hostname"]
	}`}
	h := newFormAssistTestHandler(t, fake)

	out := decodeFormAssist(t, postFormAssist(t, h, tenantctx.Tenant{UserID: 1, Role: "admin"},
		`{"kind":"model_relation","intent":"主机运行虚拟机"}`))

	if out.SourceModelID != 1 || out.TargetModelID != 2 {
		t.Fatalf("models = %d → %d", out.SourceModelID, out.TargetModelID)
	}
	if out.RelationTypeID != 1 || out.Constraint != "1" {
		t.Fatalf("type/constraint = %d/%q", out.RelationTypeID, out.Constraint)
	}
	if len(out.ParentAttrIDs) != 1 || out.ParentAttrIDs[0] != 1 ||
		len(out.ChildAttrIDs) != 1 || out.ChildAttrIDs[0] != 1 {
		t.Fatalf("pairs = %v → %v", out.ParentAttrIDs, out.ChildAttrIDs)
	}
}

func TestCMDBFormAssistModelRelationDropsUnknownPairAndBadConstraint(t *testing.T) {
	fake := &fakeFormLLM{reply: `{
		"source_model":"host","target_model":"vm","relation_type":"2","constraint":"9",
		"parent_attributes":["nope"],"child_attributes":["missing"]
	}`}
	h := newFormAssistTestHandler(t, fake)

	out := decodeFormAssist(t, postFormAssist(t, h, tenantctx.Tenant{UserID: 1, IsSuperuser: true},
		`{"kind":"model_relation","intent":"x"}`))

	if out.Constraint != "0" {
		t.Fatalf("constraint = %q", out.Constraint)
	}
	if out.RelationTypeID != 2 {
		t.Fatalf("relation type = %d", out.RelationTypeID)
	}
	if len(out.ParentAttrIDs) != 0 || len(out.ChildAttrIDs) != 0 {
		t.Fatalf("unknown pair survived: %v → %v", out.ParentAttrIDs, out.ChildAttrIDs)
	}
	warnings := strings.Join(out.Warnings, " ")
	if !strings.Contains(warnings, "nope") || !strings.Contains(warnings, "constraint") {
		t.Fatalf("warnings = %v", out.Warnings)
	}
}

func TestCMDBFormAssistUnavailableWithoutClients(t *testing.T) {
	h := NewHandler(nil)
	rec := postFormAssist(t, h, tenantctx.Tenant{UserID: 1}, `{"kind":"instance","intent":"x"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}
