package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func TestDownloadFileWritesArtifact(t *testing.T) {
	payload := []byte("installer artifact bytes\x00\x01")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != "/artifact.exe" {
			t.Errorf("path = %q, want /artifact.exe", r.URL.Path)
		}
		_, _ = w.Write(payload)
	}))
	defer server.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "artifact.exe")
	if err := DownloadFile(context.Background(), server.Client(), server.URL+"/artifact.exe", dest); err != nil {
		t.Fatalf("DownloadFile() error: %v", err)
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read downloaded file: %v", err)
	}
	if string(got) != string(payload) {
		t.Fatalf("downloaded %q, want %q", got, payload)
	}
	if err := VerifySHA256(dest, sha256Hex(payload)); err != nil {
		t.Fatalf("VerifySHA256() error: %v", err)
	}
}

func TestDownloadFileNon2xx(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "artifact not found", http.StatusNotFound)
	}))
	defer server.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "artifact.exe")
	err := DownloadFile(context.Background(), server.Client(), server.URL+"/artifact.exe", dest)
	if err == nil {
		t.Fatal("DownloadFile() error = nil, want error")
	}
	if !strings.Contains(err.Error(), "404") {
		t.Fatalf("error = %v, want HTTP 404 mentioned", err)
	}
	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Fatalf("destination exists after failed download: %v", statErr)
	}

	entries, readErr := os.ReadDir(dir)
	if readErr != nil {
		t.Fatalf("read temp dir: %v", readErr)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("failed download left temporary files: %v", names)
	}
}

func TestDownloadFileRedirectIsFollowedByClient(t *testing.T) {
	payload := []byte("redirected artifact")
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(payload)
	}))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer redirect.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "artifact.exe")
	// Redirect handling is delegated to the supplied client. The standard
	// client follows redirects, which this test documents.
	if err := DownloadFile(context.Background(), redirect.Client(), redirect.URL, dest); err != nil {
		t.Fatalf("DownloadFile() with redirect error: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read downloaded file: %v", err)
	}
	if string(got) != string(payload) {
		t.Fatalf("downloaded %q, want %q", got, payload)
	}
}

func TestDownloadFileHonorsCanceledContext(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("unused"))
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	dir := t.TempDir()
	err := DownloadFile(ctx, server.Client(), server.URL, filepath.Join(dir, "artifact.exe"))
	if err == nil {
		t.Fatal("DownloadFile() error = nil, want context error")
	}
}

func TestVerifySHA256Matches(t *testing.T) {
	payload := []byte("verified payload")
	dir := t.TempDir()
	path := filepath.Join(dir, "payload.bin")
	if err := os.WriteFile(path, payload, 0600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	digest := sha256Hex(payload)
	if err := VerifySHA256(path, digest); err != nil {
		t.Fatalf("VerifySHA256(lowercase) error: %v", err)
	}
	if err := VerifySHA256(path, strings.ToUpper(digest)); err != nil {
		t.Fatalf("VerifySHA256(uppercase) error: %v", err)
	}
}

func TestVerifySHA256Mismatch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "payload.bin")
	if err := os.WriteFile(path, []byte("actual payload"), 0600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	expected := sha256Hex([]byte("expected payload"))
	err := VerifySHA256(path, expected)
	if err == nil {
		t.Fatal("VerifySHA256() error = nil, want mismatch error")
	}
	if !strings.Contains(err.Error(), path) {
		t.Fatalf("error = %v, want file path mentioned", err)
	}
	if strings.Contains(err.Error(), expected) {
		t.Fatalf("error = %v, must not contain the expected digest", err)
	}
}

func TestVerifySHA256RejectsMalformedDigest(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "payload.bin")
	if err := os.WriteFile(path, []byte("payload"), 0600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	cases := map[string]string{
		"too short": "abc123",
		"too long":  strings.Repeat("a", 65),
		"non-hex":   strings.Repeat("z", 64),
	}
	for name, digest := range cases {
		t.Run(name, func(t *testing.T) {
			if err := VerifySHA256(path, digest); err == nil {
				t.Fatalf("VerifySHA256(%q) error = nil, want error", digest)
			}
		})
	}
}

func TestVerifySHA256MissingFile(t *testing.T) {
	err := VerifySHA256(filepath.Join(t.TempDir(), "missing.bin"), strings.Repeat("a", 64))
	if err == nil {
		t.Fatal("VerifySHA256() error = nil, want error for missing file")
	}
}
