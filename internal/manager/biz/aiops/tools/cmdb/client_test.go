package cmdb

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ongridio/ongrid/internal/pkg/auth"
	"github.com/ongridio/ongrid/internal/pkg/tenantctx"
)

func callerCtx() context.Context {
	return tenantctx.With(context.Background(), tenantctx.Tenant{UserID: 7, Role: "user"})
}

func TestClientRequiresCaller(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	c := New(srv.URL, func(tenantctx.Tenant) (string, error) { return "tok", nil }, nil, nil)
	_, err := c.Get(context.Background(), "/ci/s", nil)
	if !errors.Is(err, ErrNoCaller) {
		t.Fatalf("err = %v, want ErrNoCaller", err)
	}
	if got := atomic.LoadInt32(&calls); got != 0 {
		t.Fatalf("server calls = %d, want 0", got)
	}
}

func TestClientSendsBearerAndAPIPrefix(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/cmdb/ci/s" {
			t.Errorf("path = %q, want /api/v1/cmdb/ci/s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer tok" {
			t.Errorf("Authorization = %q", got)
		}
		if got := r.URL.Query().Get("q"); got != "host" {
			t.Errorf("q = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := New(srv.URL+"/", func(tenantctx.Tenant) (string, error) { return "tok", nil }, nil, nil)
	got, err := c.Get(callerCtx(), "/ci/s", url.Values{"q": {"host"}})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]bool
	if err := json.Unmarshal(got, &out); err != nil || !out["ok"] {
		t.Fatalf("body = %s (err %v)", got, err)
	}
}

func TestClientTranslatesForbidden(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "forbidden by acl", http.StatusForbidden)
	}))
	defer srv.Close()

	c := New(srv.URL, func(tenantctx.Tenant) (string, error) { return "tok", nil }, nil, nil)
	_, err := c.Get(callerCtx(), "/ci/s", nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusForbidden {
		t.Fatalf("err = %v, want APIError 403", err)
	}
	if !strings.Contains(strings.ToLower(err.Error()), "not allowed") {
		t.Fatalf("err = %v, want an actionable permission message", err)
	}
}

func TestClientTranslatesServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := New(srv.URL, func(tenantctx.Tenant) (string, error) { return "tok", nil }, nil, nil)
	_, err := c.Get(callerCtx(), "/ci/s", nil)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "unavailable") {
		t.Fatalf("err = %v, want an unavailable message", err)
	}
}

func TestSignerMinterCarriesCaller(t *testing.T) {
	signer := auth.NewSigner("test-secret", time.Minute, time.Hour)
	mint := NewSignerMinter(signer, time.Minute)
	tok, err := mint(tenantctx.Tenant{UserID: 42, Email: "ops@example.com", Role: "admin", IsSuperuser: true})
	if err != nil {
		t.Fatal(err)
	}
	claims, err := signer.Verify(tok)
	if err != nil {
		t.Fatal(err)
	}
	if claims.UserID != 42 || claims.Role != "admin" || !claims.IsSuperuser || claims.Email != "ops@example.com" {
		t.Fatalf("claims = %+v", claims)
	}
	ttl := time.Until(claims.ExpiresAt.Time)
	if ttl < 50*time.Second || ttl > 70*time.Second {
		t.Fatalf("ttl = %v, want about 1m", ttl)
	}
}
