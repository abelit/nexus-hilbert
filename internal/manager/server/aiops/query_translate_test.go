package aiops

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ongridio/ongrid/internal/pkg/tenantctx"
)

func TestQueryTranslateAcceptsCMDBDialect(t *testing.T) {
	fake := &fakeFormLLM{reply: `{"query":"env:生产,cpu:>8","explanation":"生产环境 8 核以上"}`}
	h := NewHandler(nil)
	h.SetLLMClient(fake)

	req := httptest.NewRequest(http.MethodPost, "/v1/aiops/query-translate",
		strings.NewReader(`{"dialect":"cmdb","prompt":"生产环境 8 核以上的主机"}`))
	req = req.WithContext(tenantctx.With(req.Context(), tenantctx.Tenant{UserID: 1}))
	rec := httptest.NewRecorder()
	h.queryTranslate(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var out queryTranslateResp
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Query != "env:生产,cpu:>8" || out.Dialect != "cmdb" {
		t.Fatalf("resp = %+v", out)
	}
	if !strings.Contains(fake.lastPrompt, "attr:(v1;v2)") {
		t.Fatalf("cmdb guide missing from prompt: %s", fake.lastPrompt)
	}
}

func TestQueryTranslateRejectsUnknownDialect(t *testing.T) {
	h := NewHandler(nil)
	h.SetLLMClient(&fakeFormLLM{reply: `{"query":"x"}`})

	req := httptest.NewRequest(http.MethodPost, "/v1/aiops/query-translate",
		strings.NewReader(`{"dialect":"sql","prompt":"x"}`))
	req = req.WithContext(tenantctx.With(req.Context(), tenantctx.Tenant{UserID: 1}))
	rec := httptest.NewRecorder()
	h.queryTranslate(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body.String())
	}
}
