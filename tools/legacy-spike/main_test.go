package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"
)

func clearProbeEnv(t *testing.T) {
	t.Helper()
	t.Setenv("ONGRID_MANAGER_URL", "")
	t.Setenv("ONGRID_FRONTIER_ADDR", "")
}

func TestHealthURL(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "bare origin",
			raw:  "https://manager.example.com",
			want: "https://manager.example.com/healthz",
		},
		{
			name: "trailing slash",
			raw:  "https://manager.example.com/",
			want: "https://manager.example.com/healthz",
		},
		{
			name: "base path",
			raw:  "https://manager.example.com/ongrid",
			want: "https://manager.example.com/ongrid/healthz",
		},
		{
			name: "already healthz",
			raw:  "https://manager.example.com/healthz",
			want: "https://manager.example.com/healthz",
		},
		{
			name: "already healthz with trailing slash",
			raw:  "https://manager.example.com/healthz/",
			want: "https://manager.example.com/healthz",
		},
		{
			name: "http with port",
			raw:  "http://127.0.0.1:8080",
			want: "http://127.0.0.1:8080/healthz",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := healthURL(tt.raw)
			if err != nil {
				t.Fatalf("healthURL(%q) error: %v", tt.raw, err)
			}
			if got != tt.want {
				t.Fatalf("healthURL(%q) = %q, want %q", tt.raw, got, tt.want)
			}
		})
	}
}

func TestHealthURLRejectsBadInput(t *testing.T) {
	tests := []string{
		"manager.example.com",
		"ftp://manager.example.com",
		"https://",
		"://missing-scheme",
	}
	for _, raw := range tests {
		t.Run(raw, func(t *testing.T) {
			if _, err := healthURL(raw); err == nil {
				t.Fatalf("healthURL(%q) succeeded, want error", raw)
			}
		})
	}
}

func TestParseConfigFlags(t *testing.T) {
	clearProbeEnv(t)

	cfg, err := parseConfig([]string{
		"-manager", "https://manager.example.com",
		"-frontier", "frontier.example.com:2379",
		"-timeout", "3s",
	}, io.Discard)
	if err != nil {
		t.Fatalf("parseConfig error: %v", err)
	}
	if cfg.managerURL != "https://manager.example.com/healthz" {
		t.Fatalf("managerURL = %q", cfg.managerURL)
	}
	if cfg.frontierAddr != "frontier.example.com:2379" {
		t.Fatalf("frontierAddr = %q", cfg.frontierAddr)
	}
	if cfg.timeout != 3*time.Second {
		t.Fatalf("timeout = %s", cfg.timeout)
	}
}

func TestParseConfigEnvFallback(t *testing.T) {
	t.Setenv("ONGRID_MANAGER_URL", "https://env-manager.example.com")
	t.Setenv("ONGRID_FRONTIER_ADDR", "env-frontier.example.com:8443")

	cfg, err := parseConfig(nil, io.Discard)
	if err != nil {
		t.Fatalf("parseConfig error: %v", err)
	}
	if cfg.managerURL != "https://env-manager.example.com/healthz" {
		t.Fatalf("managerURL = %q", cfg.managerURL)
	}
	if cfg.frontierAddr != "env-frontier.example.com:8443" {
		t.Fatalf("frontierAddr = %q", cfg.frontierAddr)
	}
}

func TestParseConfigErrors(t *testing.T) {
	clearProbeEnv(t)

	tests := []struct {
		name string
		args []string
	}{
		{name: "bad manager scheme", args: []string{"-manager", "manager.example.com"}},
		{name: "frontier without port", args: []string{"-frontier", "frontier.example.com"}},
		{name: "non-positive timeout", args: []string{"-timeout", "0s"}},
		{name: "unknown flag", args: []string{"-bogus"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := parseConfig(tt.args, io.Discard); err == nil {
				t.Fatalf("parseConfig(%v) succeeded, want error", tt.args)
			}
		})
	}
}

func TestTLSVersionName(t *testing.T) {
	tests := map[uint16]string{
		0:                "none",
		tls.VersionTLS10: "TLS 1.0",
		tls.VersionTLS11: "TLS 1.1",
		tls.VersionTLS12: "TLS 1.2",
		tls.VersionTLS13: "TLS 1.3",
		0x1234:           "0x1234",
	}
	for version, want := range tests {
		if got := tlsVersionName(version); got != want {
			t.Errorf("tlsVersionName(0x%04x) = %q, want %q", version, got, want)
		}
	}
}

func TestCheckManagerTLS12(t *testing.T) {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	srv.TLS = &tls.Config{MaxVersion: tls.VersionTLS12}
	srv.StartTLS()
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	res, err := checkManager(ctx, srv.Client(), srv.URL+"/healthz")
	if err != nil {
		t.Fatalf("checkManager error: %v", err)
	}
	if res.statusCode != http.StatusOK {
		t.Fatalf("statusCode = %d, want 200", res.statusCode)
	}
	if res.tlsVersion != tls.VersionTLS12 {
		t.Fatalf("tlsVersion = %s, want TLS 1.2", tlsVersionName(res.tlsVersion))
	}
	if res.cipherSuite == 0 {
		t.Fatal("cipherSuite was not reported")
	}
}

func TestCheckManagerReportsTLSOnBadStatus(t *testing.T) {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not ready", http.StatusServiceUnavailable)
	}))
	srv.TLS = &tls.Config{MaxVersion: tls.VersionTLS12}
	srv.StartTLS()
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	res, err := checkManager(ctx, srv.Client(), srv.URL+"/healthz")
	if err == nil {
		t.Fatal("checkManager succeeded on 503, want error")
	}
	if res.statusCode != http.StatusServiceUnavailable {
		t.Fatalf("statusCode = %d, want 503", res.statusCode)
	}
	if res.tlsVersion != tls.VersionTLS12 {
		t.Fatalf("tlsVersion = %s, want TLS 1.2 to be retained", tlsVersionName(res.tlsVersion))
	}
}

func TestRunWithoutTargets(t *testing.T) {
	clearProbeEnv(t)

	var stdout, stderr bytes.Buffer
	if code := run(nil, &stdout, &stderr); code != 0 {
		t.Fatalf("run exit code = %d, stderr = %q", code, stderr.String())
	}
	out := stdout.String()
	if !strings.Contains(out, "runtime: "+runtime.Version()) {
		t.Fatalf("stdout missing runtime line:\n%s", out)
	}
	if !strings.Contains(out, "manager: SKIP") {
		t.Fatalf("stdout missing manager SKIP:\n%s", out)
	}
	if !strings.Contains(out, "frontier: SKIP") {
		t.Fatalf("stdout missing frontier SKIP:\n%s", out)
	}
}
