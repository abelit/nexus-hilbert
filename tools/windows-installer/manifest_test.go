package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
)

// validSHA256Fixture returns a real 64-character SHA-256 hex digest so the
// fixtures exercise the same validation path as production manifests.
func validSHA256Fixture(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	return hex.EncodeToString(sum[:])
}

func manifestFixture(t *testing.T) *Manifest {
	t.Helper()
	body := fmt.Sprintf(`{
		"schema": 1,
		"version": "v0.20.0",
		"variants": [
			{
				"id": "modern-amd64",
				"min_os": {"major": 10, "build": 14393},
				"files": [
					{"path": "ongrid-edge-supervisor.exe", "sha256": %q, "dest": "bin"},
					{"path": "ongrid-edge-worker.exe", "sha256": %q, "dest": "bin"},
					{"path": "plugins/windows_exporter.exe", "sha256": %q, "dest": "plugins"},
					{"path": "edge.conf", "sha256": %q, "dest": "etc"}
				]
			},
			{
				"id": "legacy-amd64",
				"min_os": {"major": 6, "minor": 1, "build": 7601},
				"files": [
					{"path": "ongrid-edge-supervisor.exe", "sha256": %q, "dest": "bin"}
				]
			}
		]
	}`,
		validSHA256Fixture("supervisor"),
		validSHA256Fixture("worker"),
		validSHA256Fixture("windows_exporter"),
		validSHA256Fixture("config"),
		validSHA256Fixture("legacy-supervisor"),
	)
	m, err := ParseManifest([]byte(body))
	if err != nil {
		t.Fatalf("ParseManifest(fixture) error: %v", err)
	}
	return m
}

func manifestWithFile(path, dest, sha string) string {
	return fmt.Sprintf(
		`{"schema":1,"variants":[{"id":"modern-amd64","files":[{"path":%q,"sha256":%q,"dest":%q}]}]}`,
		path, sha, dest,
	)
}

func TestParseManifestValid(t *testing.T) {
	m := manifestFixture(t)

	if m.Schema != 1 {
		t.Fatalf("Schema = %d, want 1", m.Schema)
	}
	if m.Version != "v0.20.0" {
		t.Fatalf("Version = %q, want v0.20.0", m.Version)
	}
	if len(m.Variants) != 2 {
		t.Fatalf("len(Variants) = %d, want 2", len(m.Variants))
	}
	if m.Variants[0].ID != "modern-amd64" {
		t.Fatalf("Variants[0].ID = %q", m.Variants[0].ID)
	}
	if got := len(m.Variants[0].Files); got != 4 {
		t.Fatalf("len(modern files) = %d, want 4", got)
	}
	if m.Variants[0].Files[2].Dest != "plugins" {
		t.Fatalf("dest = %q, want plugins", m.Variants[0].Files[2].Dest)
	}
	if len(m.Variants[0].Files[0].SHA256) != 64 {
		t.Fatalf("sha256 length = %d, want 64", len(m.Variants[0].Files[0].SHA256))
	}
}

func TestParseManifestAcceptsUppercaseSHA256(t *testing.T) {
	sha := strings.ToUpper(validSHA256Fixture("uppercase"))
	if _, err := ParseManifest([]byte(manifestWithFile("worker.exe", "bin", sha))); err != nil {
		t.Fatalf("ParseManifest() error = %v, want nil", err)
	}
}

func TestParseManifestRejectsInvalidManifest(t *testing.T) {
	sha := validSHA256Fixture("valid")

	tests := []struct {
		name string
		body string
	}{
		{
			name: "path traversal",
			body: manifestWithFile("../evil.exe", "bin", sha),
		},
		{
			name: "nested path traversal",
			body: manifestWithFile("plugins/../../evil.exe", "plugins", sha),
		},
		{
			name: "backslash path traversal",
			body: manifestWithFile(`plugins\..\..\evil.exe`, "plugins", sha),
		},
		{
			name: "traversal with trailing space normalized by win32",
			body: manifestWithFile(`.. \evil.exe`, "bin", sha),
		},
		{
			name: "dot component",
			body: manifestWithFile("plugins/./evil.exe", "plugins", sha),
		},
		{
			name: "empty component",
			body: manifestWithFile("plugins//evil.exe", "plugins", sha),
		},
		{
			name: "absolute unix path",
			body: manifestWithFile("/Windows/System32/evil.exe", "bin", sha),
		},
		{
			name: "absolute backslash path",
			body: manifestWithFile(`\Windows\System32\evil.exe`, "bin", sha),
		},
		{
			name: "unc path",
			body: manifestWithFile(`\\server\share\evil.exe`, "bin", sha),
		},
		{
			name: "windows drive path",
			body: manifestWithFile(`C:\Windows\System32\evil.exe`, "bin", sha),
		},
		{
			name: "windows drive path with forward slash",
			body: manifestWithFile("C:/Windows/System32/evil.exe", "bin", sha),
		},
		{
			name: "empty path",
			body: manifestWithFile("", "bin", sha),
		},
		{
			name: "directory path",
			body: manifestWithFile("plugins/", "plugins", sha),
		},
		{
			name: "dot path",
			body: manifestWithFile(".", "bin", sha),
		},
		{
			name: "unknown dest",
			body: manifestWithFile("worker.exe", "system32", sha),
		},
		{
			name: "empty dest",
			body: manifestWithFile("worker.exe", "", sha),
		},
		{
			name: "short sha256",
			body: manifestWithFile("worker.exe", "bin", sha[:63]),
		},
		{
			name: "long sha256",
			body: manifestWithFile("worker.exe", "bin", sha+"0"),
		},
		{
			name: "non-hex sha256",
			body: manifestWithFile("worker.exe", "bin", strings.Repeat("g", 64)),
		},
		{
			name: "empty sha256",
			body: manifestWithFile("worker.exe", "bin", ""),
		},
		{
			name: "missing schema",
			body: `{"variants":[{"id":"modern-amd64","files":[]}]}`,
		},
		{
			name: "wrong schema",
			body: `{"schema":2,"variants":[{"id":"modern-amd64","files":[]}]}`,
		},
		{
			name: "no variants",
			body: `{"schema":1,"variants":[]}`,
		},
		{
			name: "empty variant id",
			body: fmt.Sprintf(`{"schema":1,"variants":[{"id":"","files":[{"path":"worker.exe","sha256":%q,"dest":"bin"}]}]}`, sha),
		},
		{
			name: "unknown top-level field",
			body: fmt.Sprintf(`{"schema":1,"extra":true,"variants":[{"id":"modern-amd64","files":[{"path":"worker.exe","sha256":%q,"dest":"bin"}]}]}`, sha),
		},
		{
			name: "unknown variant field",
			body: fmt.Sprintf(`{"schema":1,"variants":[{"id":"modern-amd64","extra":true,"files":[{"path":"worker.exe","sha256":%q,"dest":"bin"}]}]}`, sha),
		},
		{
			name: "unknown file field",
			body: fmt.Sprintf(`{"schema":1,"variants":[{"id":"modern-amd64","files":[{"path":"worker.exe","sha256":%q,"dest":"bin","extra":true}]}]}`, sha),
		},
		{
			name: "malformed json",
			body: `{"schema":1,`,
		},
		{
			name: "trailing data",
			body: fmt.Sprintf(`{"schema":1,"variants":[{"id":"modern-amd64","files":[{"path":"worker.exe","sha256":%q,"dest":"bin"}]}]} {}`, sha),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := ParseManifest([]byte(tt.body)); err == nil {
				t.Fatalf("ParseManifest() succeeded, want error")
			}
		})
	}
}

func TestSelectVariant(t *testing.T) {
	m := manifestFixture(t)

	tests := []struct {
		name      string
		version   OSVersion
		requested string
		wantID    string
		wantErr   bool
	}{
		{
			name:      "auto modern minimum build",
			version:   OSVersion{Major: 10, Build: 14393},
			requested: "auto",
			wantID:    "modern-amd64",
		},
		{
			name:      "auto modern server 2019",
			version:   OSVersion{Major: 10, Build: 17763},
			requested: "auto",
			wantID:    "modern-amd64",
		},
		{
			name:      "auto modern major 11",
			version:   OSVersion{Major: 11, Build: 22621},
			requested: "auto",
			wantID:    "modern-amd64",
		},
		{
			name:      "auto legacy 2008 r2 sp1",
			version:   OSVersion{Major: 6, Minor: 1, Build: 7601},
			requested: "auto",
			wantID:    "legacy-amd64",
		},
		{
			name:      "auto legacy later build",
			version:   OSVersion{Major: 6, Minor: 1, Build: 7602},
			requested: "auto",
			wantID:    "legacy-amd64",
		},
		{
			name:      "empty requested means auto",
			version:   OSVersion{Major: 10, Build: 17763},
			requested: "",
			wantID:    "modern-amd64",
		},
		{
			name:      "explicit modern wins on legacy os",
			version:   OSVersion{Major: 6, Minor: 1, Build: 7601},
			requested: "modern-amd64",
			wantID:    "modern-amd64",
		},
		{
			name:      "explicit legacy wins on modern os",
			version:   OSVersion{Major: 10, Build: 17763},
			requested: "legacy-amd64",
			wantID:    "legacy-amd64",
		},
		{
			name:      "explicit modern short name",
			version:   OSVersion{Major: 10, Build: 17763},
			requested: "modern",
			wantID:    "modern-amd64",
		},
		{
			name:      "explicit legacy short name",
			version:   OSVersion{Major: 10, Build: 17763},
			requested: "legacy",
			wantID:    "legacy-amd64",
		},
		{
			name:      "unsupported 2008 r2 without sp1",
			version:   OSVersion{Major: 6, Minor: 1, Build: 7600},
			requested: "auto",
			wantErr:   true,
		},
		{
			name:      "unsupported 2012 r2",
			version:   OSVersion{Major: 6, Minor: 3, Build: 9600},
			requested: "auto",
			wantErr:   true,
		},
		{
			name:      "unsupported windows 10 pre 1607",
			version:   OSVersion{Major: 10, Build: 10240},
			requested: "auto",
			wantErr:   true,
		},
		{
			name:      "unsupported server 2003",
			version:   OSVersion{Major: 5, Minor: 2, Build: 3790},
			requested: "auto",
			wantErr:   true,
		},
		{
			name:      "zero version",
			version:   OSVersion{},
			requested: "auto",
			wantErr:   true,
		},
		{
			name:      "unknown requested variant",
			version:   OSVersion{Major: 10, Build: 17763},
			requested: "arm64",
			wantErr:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			v, err := m.SelectVariant(tt.version, tt.requested)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("SelectVariant() = %v, want error", v)
				}
				return
			}
			if err != nil {
				t.Fatalf("SelectVariant() error = %v", err)
			}
			if v.ID != tt.wantID {
				t.Fatalf("SelectVariant() ID = %q, want %q", v.ID, tt.wantID)
			}
		})
	}
}

func TestSelectVariantUnsupportedOSListsMatrix(t *testing.T) {
	m := manifestFixture(t)

	_, err := m.SelectVariant(OSVersion{Major: 6, Minor: 3, Build: 9600}, "auto")
	if err == nil {
		t.Fatal("SelectVariant() succeeded, want error")
	}
	msg := err.Error()
	for _, want := range []string{"modern-amd64", "legacy-amd64"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error %q does not mention supported variant %q", msg, want)
		}
	}
}

func TestSelectVariantRequiresRequestedVariantInManifest(t *testing.T) {
	body := fmt.Sprintf(
		`{"schema":1,"variants":[{"id":"modern-amd64","files":[{"path":"worker.exe","sha256":%q,"dest":"bin"}]}]}`,
		validSHA256Fixture("only-modern"),
	)
	m, err := ParseManifest([]byte(body))
	if err != nil {
		t.Fatalf("ParseManifest() error = %v", err)
	}

	tests := []struct {
		name      string
		version   OSVersion
		requested string
	}{
		{
			name:      "auto selects missing legacy variant",
			version:   OSVersion{Major: 6, Minor: 1, Build: 7601},
			requested: "auto",
		},
		{
			name:      "explicit missing legacy variant",
			version:   OSVersion{Major: 10, Build: 17763},
			requested: "legacy",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := m.SelectVariant(tt.version, tt.requested); err == nil {
				t.Fatal("SelectVariant() succeeded, want error")
			}
		})
	}
}
