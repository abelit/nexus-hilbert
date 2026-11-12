package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func fixedHostInfo() HostInfo {
	return HostInfo{
		Hostname:            "web-01",
		OS:                  "windows",
		Arch:                "amd64",
		KernelVersion:       "10.0.14393",
		CPUCount:            8,
		MemTotalBytes:       16 << 30,
		Fingerprint:         "machine-guid",
		HardwareFingerprint: "machine-guid",
		IPAddress:           "10.0.0.10",
	}
}

func TestEnrollSucceedsOnCreated(t *testing.T) {
	var (
		gotMethod string
		gotPath   string
		gotAuth   string
		gotType   string
		gotBody   enrollRequest
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotType = r.Header.Get("Content-Type")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"edge_id":42,"access_key":"ak_test-1","secret_key":"sk_test_2",`+
			`"cloud_addr":"edge.example.com:40012","manager_public_url":"https://manager.example.com"}`)
	}))
	defer server.Close()

	creds, err := Enroll(context.Background(), server.Client(), server.URL+"/", "oen_secret_token", fixedHostInfo(), "v1.2.3")
	if err != nil {
		t.Fatalf("Enroll() error: %v", err)
	}

	if gotMethod != http.MethodPost {
		t.Fatalf("method = %s, want POST", gotMethod)
	}
	if gotPath != "/internal/edge/enroll" {
		t.Fatalf("path = %q, want /internal/edge/enroll", gotPath)
	}
	if gotAuth != "Bearer oen_secret_token" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
	if gotType != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", gotType)
	}
	if gotBody.AgentVersion != "v1.2.3" {
		t.Fatalf("agent_version = %q, want v1.2.3", gotBody.AgentVersion)
	}
	if !reflect.DeepEqual(gotBody.HostInfo, fixedHostInfo()) {
		t.Fatalf("host_info = %+v, want %+v", gotBody.HostInfo, fixedHostInfo())
	}

	want := &Credentials{
		EdgeID:           42,
		AccessKey:        "ak_test-1",
		SecretKey:        "sk_test_2",
		CloudAddr:        "edge.example.com:40012",
		ManagerPublicURL: "https://manager.example.com",
	}
	if !reflect.DeepEqual(creds, want) {
		t.Fatalf("credentials = %+v, want %+v", creds, want)
	}
}

func TestEnrollNonCreatedStatus(t *testing.T) {
	const token = "oen_secret_token"
	const secret = "sk_should_not_leak"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":"invalid enrollment token"}`)
	}))
	defer server.Close()

	_, err := Enroll(context.Background(), server.Client(), server.URL, token, fixedHostInfo(), "v1.2.3")
	if err == nil {
		t.Fatal("Enroll() error = nil, want error")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Fatalf("error = %v, want HTTP 401", err)
	}
	if !strings.Contains(err.Error(), "invalid enrollment token") {
		t.Fatalf("error = %v, want response body surfaced", err)
	}
	if strings.Contains(err.Error(), token) || strings.Contains(err.Error(), secret) {
		t.Fatalf("error leaks a credential: %v", err)
	}
}

func TestEnrollRejectsMalformedCredentials(t *testing.T) {
	const token = "oen_secret_token"
	cases := map[string]string{
		"missing access key":     `{"edge_id":1,"secret_key":"sk_valid"}`,
		"missing secret key":     `{"edge_id":1,"access_key":"ak_valid"}`,
		"empty access key":       `{"edge_id":1,"access_key":"","secret_key":"sk_valid"}`,
		"space in access key":    `{"edge_id":1,"access_key":"ak invalid","secret_key":"sk_valid"}`,
		"slash in secret key":    `{"edge_id":1,"access_key":"ak_valid","secret_key":"sk/invalid"}`,
		"malformed json":         `not json`,
		"json with wrong fields": `{"edge_id":1,"access_key":null,"secret_key":"sk_valid"}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusCreated)
				_, _ = io.WriteString(w, body)
			}))
			defer server.Close()

			_, err := Enroll(context.Background(), server.Client(), server.URL, token, fixedHostInfo(), "")
			if err == nil {
				t.Fatal("Enroll() error = nil, want error")
			}
			if strings.Contains(err.Error(), token) || strings.Contains(err.Error(), "sk_valid") {
				t.Fatalf("error leaks a credential: %v", err)
			}
		})
	}
}

func TestEnrollValidatesInputs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("server must not be called for invalid input")
	}))
	defer server.Close()

	host := fixedHostInfo()
	missingHostname := host
	missingHostname.Hostname = "  "
	missingFingerprint := host
	missingFingerprint.Fingerprint = ""
	missingFingerprint.HardwareFingerprint = ""

	cases := []struct {
		name       string
		managerURL string
		token      string
		host       HostInfo
	}{
		{name: "empty token", managerURL: server.URL, token: "", host: host},
		{name: "empty manager url", managerURL: "", token: "oen_token", host: host},
		{name: "bad scheme", managerURL: "ftp://manager.example.com", token: "oen_token", host: host},
		{name: "empty hostname", managerURL: server.URL, token: "oen_token", host: missingHostname},
		{name: "missing fingerprint", managerURL: server.URL, token: "oen_token", host: missingFingerprint},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Enroll(context.Background(), server.Client(), tc.managerURL, tc.token, tc.host, ""); err == nil {
				t.Fatal("Enroll() error = nil, want validation error")
			}
		})
	}
}

func TestEnrollmentTimeoutIsTwentySeconds(t *testing.T) {
	if enrollmentTimeout != 20*time.Second {
		t.Fatalf("enrollmentTimeout = %v, want 20s", enrollmentTimeout)
	}
}

func TestHostInfoJSONShape(t *testing.T) {
	data, err := json.Marshal(fixedHostInfo())
	if err != nil {
		t.Fatalf("marshal HostInfo: %v", err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("unmarshal HostInfo: %v", err)
	}

	wantKeys := []string{
		"hostname", "os", "arch", "kernel_version", "cpu_count",
		"mem_total_bytes", "fingerprint", "hardware_fingerprint", "ip_address",
	}
	if len(raw) != len(wantKeys) {
		t.Fatalf("HostInfo has %d JSON keys, want %d: %s", len(raw), len(wantKeys), data)
	}
	for _, key := range wantKeys {
		if _, ok := raw[key]; !ok {
			t.Fatalf("HostInfo JSON is missing %q: %s", key, data)
		}
	}
}

func TestBuildHostInfoUsesMachineIDAsFingerprint(t *testing.T) {
	probes := hostInfoProbes{
		Hostname:      func() (string, error) { return "win-host ", nil },
		MachineID:     func() (string, error) { return " 11111111-2222-3333-4444-555555555555 ", nil },
		GOARCH:        "amd64",
		NumCPU:        4,
		KernelVersion: "10.0.14393",
	}
	host, err := buildHostInfo(probes)
	if err != nil {
		t.Fatalf("buildHostInfo() error: %v", err)
	}

	want := HostInfo{
		Hostname:            "win-host",
		OS:                  "windows",
		Arch:                "amd64",
		KernelVersion:       "10.0.14393",
		CPUCount:            4,
		MemTotalBytes:       0,
		Fingerprint:         "11111111-2222-3333-4444-555555555555",
		HardwareFingerprint: "11111111-2222-3333-4444-555555555555",
	}
	if !reflect.DeepEqual(host, want) {
		t.Fatalf("host = %+v, want %+v", host, want)
	}
}

func TestBuildHostInfoFallsBackToHostname(t *testing.T) {
	cases := map[string]func() (string, error){
		"machine id error": func() (string, error) { return "", errors.New("registry unavailable") },
		"machine id empty": func() (string, error) { return "   ", nil },
	}
	for name, machineID := range cases {
		t.Run(name, func(t *testing.T) {
			host, err := buildHostInfo(hostInfoProbes{
				Hostname:  func() (string, error) { return "win-host", nil },
				MachineID: machineID,
				GOARCH:    "amd64",
				NumCPU:    2,
			})
			if err != nil {
				t.Fatalf("buildHostInfo() error: %v", err)
			}
			if host.Fingerprint != "win-host" || host.HardwareFingerprint != "win-host" {
				t.Fatalf("fingerprints = %q/%q, want hostname fallback", host.Fingerprint, host.HardwareFingerprint)
			}
		})
	}
}

func TestBuildHostInfoRejectsEmptyHostname(t *testing.T) {
	_, err := buildHostInfo(hostInfoProbes{
		Hostname:  func() (string, error) { return "  ", nil },
		MachineID: func() (string, error) { return "guid", nil },
	})
	if err == nil {
		t.Fatal("buildHostInfo() error = nil, want error")
	}

	_, err = buildHostInfo(hostInfoProbes{
		Hostname: func() (string, error) { return "", errors.New("no hostname") },
	})
	if err == nil {
		t.Fatal("buildHostInfo() with hostname error = nil, want error")
	}
}

func TestCollectHostInfoUnavailableOffWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("non-Windows behavior")
	}
	if _, err := CollectHostInfo(); err == nil {
		t.Fatal("CollectHostInfo() error = nil, want a clear non-Windows error")
	}
}

func TestNormalizeEnrollmentManagerURLRejectsRemotePlaintext(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{name: "remote https", raw: "https://manager.example.com", wantErr: false},
		{name: "remote http", raw: "http://manager.example.com", wantErr: true},
		{name: "non-loopback ip http", raw: "http://10.0.0.5:8080", wantErr: true},
		{name: "loopback ipv4 http", raw: "http://127.0.0.1:8080", wantErr: false},
		{name: "loopback localhost http", raw: "http://localhost:8080", wantErr: false},
		{name: "loopback ipv6 http", raw: "http://[::1]:8080", wantErr: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := normalizeEnrollmentManagerURL(tc.raw)
			if tc.wantErr && err == nil {
				t.Fatalf("normalizeEnrollmentManagerURL(%q) error = nil, want error", tc.raw)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("normalizeEnrollmentManagerURL(%q) error: %v", tc.raw, err)
			}
		})
	}
}

// TestEnrollRejectsRemotePlaintextBeforeRequest verifies the loopback rule is
// enforced at the Enroll boundary, not only in ParseArgs.
func TestEnrollRejectsRemotePlaintextBeforeRequest(t *testing.T) {
	_, err := Enroll(context.Background(), nil, "http://manager.example.com", "token", fixedHostInfo(), "v1")
	if err == nil {
		t.Fatal("Enroll() error = nil, want loopback rejection")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "loopback") {
		t.Fatalf("error = %v, want loopback mention", err)
	}
}
