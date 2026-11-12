//go:build windows

package restart_service

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/ongridio/ongrid/internal/pkg/tunnel"
)

// fakeClient is a tunnel.Client stub. The Linux test file is build-tagged
// linux, so the Windows suite carries its own copy.
type fakeClient struct {
	mu       sync.Mutex
	handlers map[string]tunnel.Handler
}

func newFakeClient() *fakeClient { return &fakeClient{handlers: map[string]tunnel.Handler{}} }

func (f *fakeClient) Dial(_ context.Context) error                     { return nil }
func (f *fakeClient) Call(_ context.Context, _ string, _, _ any) error { return nil }
func (f *fakeClient) OnReconnect(_ func())                             {}
func (f *fakeClient) Close() error                                     { return nil }
func (f *fakeClient) AcceptStream() (tunnel.StreamConn, error)         { return nil, nil }
func (f *fakeClient) RegisterHandler(method string, h tunnel.Handler) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.handlers[method] = h
}
func (f *fakeClient) handler(method string) tunnel.Handler {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.handlers[method]
}

const testScPath = `C:\Windows\System32\sc.exe`

// fakeExitError mimics *exec.ExitError for sc.exe exit-code handling.
type fakeExitError struct{ code int }

func (e fakeExitError) Error() string { return fmt.Sprintf("exit status %d", e.code) }
func (e fakeExitError) ExitCode() int { return e.code }

type scCall struct {
	name string
	args []string
}

// fakeRunner is the injectable sc.exe seam. It records every call so the
// tests can assert the exact stop-then-start sequence and that disallowed
// or mocked calls never reach the runner.
type fakeRunner struct {
	calls    []scCall
	stopOut  []byte
	stopErr  error
	startOut []byte
	startErr error
}

func (f *fakeRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, scCall{name: name, args: append([]string(nil), args...)})
	if len(args) > 0 {
		switch args[0] {
		case "stop":
			return f.stopOut, f.stopErr
		case "start":
			return f.startOut, f.startErr
		}
	}
	return nil, nil
}

func invoke(t *testing.T, sb *SandboxConfig, r runner, body string) (tunnel.RestartServiceResponse, error) {
	t.Helper()
	h := makeRestartHandler(sb, r, testScPath, nil)
	raw, err := h(context.Background(), tunnel.Session{}, tunnel.MethodRestartService, []byte(body))
	if err != nil {
		return tunnel.RestartServiceResponse{}, err
	}
	var resp tunnel.RestartServiceResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return resp, nil
}

func TestHandler_AllowedServiceRunsStopThenStart(t *testing.T) {
	sb := DefaultSandboxConfig()
	sb.Mocked = false
	r := &fakeRunner{}

	resp, err := invoke(t, sb, r, `{"service":"w3svc","reason":"502s"}`)
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	if !resp.Restarted {
		t.Error("Restarted should be true")
	}
	if resp.Mocked {
		t.Error("Mocked should be false for a real restart")
	}
	if resp.Service != "W3SVC" {
		t.Errorf("Service echo = %q, want allow-list spelling W3SVC", resp.Service)
	}
	if resp.StartedAt.After(resp.EndedAt) {
		t.Error("StartedAt should be <= EndedAt")
	}
	if len(r.calls) != 2 {
		t.Fatalf("sc.exe calls = %d, want 2 (stop, start)", len(r.calls))
	}
	if r.calls[0].name != testScPath {
		t.Errorf("stop used %q, want absolute %q", r.calls[0].name, testScPath)
	}
	if got := strings.Join(r.calls[0].args, " "); got != "stop W3SVC" {
		t.Errorf("first call args = %q, want %q", got, "stop W3SVC")
	}
	if r.calls[1].name != testScPath {
		t.Errorf("start used %q, want absolute %q", r.calls[1].name, testScPath)
	}
	if got := strings.Join(r.calls[1].args, " "); got != "start W3SVC" {
		t.Errorf("second call args = %q, want %q", got, "start W3SVC")
	}
}

func TestHandler_DisallowedServiceDoesNotRun(t *testing.T) {
	sb := DefaultSandboxConfig()
	sb.Mocked = false
	r := &fakeRunner{}

	_, err := invoke(t, sb, r, `{"service":"sshd"}`)
	if err == nil {
		t.Fatal("expected allow-list rejection")
	}
	if !strings.Contains(err.Error(), "allow-list") {
		t.Errorf("error should mention allow-list: %v", err)
	}
	if len(r.calls) != 0 {
		t.Errorf("disallowed service must not run sc.exe, got %d calls", len(r.calls))
	}
}

func TestHandler_MockedDoesNotRun(t *testing.T) {
	sb := DefaultSandboxConfig()
	sb.Mocked = true
	r := &fakeRunner{}

	resp, err := invoke(t, sb, r, `{"service":"nginx"}`)
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	if !resp.Restarted || !resp.Mocked {
		t.Errorf("mocked restart response = %+v, want Restarted=true Mocked=true", resp)
	}
	if len(r.calls) != 0 {
		t.Errorf("mocked mode must not run sc.exe, got %d calls", len(r.calls))
	}
}

func TestHandler_RejectsEmptyOrInvalidService(t *testing.T) {
	sb := DefaultSandboxConfig()
	sb.Mocked = false
	for _, body := range []string{`{"service":""}`, `{"service":"   "}`, `{"service":"..\\evil"}`} {
		r := &fakeRunner{}
		if _, err := invoke(t, sb, r, body); err == nil {
			t.Errorf("body %s should be rejected", body)
		}
		if len(r.calls) != 0 {
			t.Errorf("body %s must not run sc.exe", body)
		}
	}
}

// TestHandler_ToleratesBenignSCErrors keeps the stop-then-start sequence
// robust when the service is already stopped or already running. sc.exe
// query output is localised, so state is inferred from exit codes instead.
func TestHandler_ToleratesBenignSCErrors(t *testing.T) {
	cases := []struct {
		name string
		r    *fakeRunner
	}{
		{"stop not active", &fakeRunner{stopErr: fakeExitError{code: scErrServiceNotActive}}},
		{"start already running", &fakeRunner{startErr: fakeExitError{code: scErrServiceAlreadyRunning}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sb := DefaultSandboxConfig()
			sb.Mocked = false
			resp, err := invoke(t, sb, tc.r, `{"service":"nginx"}`)
			if err != nil {
				t.Fatalf("benign sc.exe exit should not fail: %v", err)
			}
			if !resp.Restarted {
				t.Error("Restarted should be true after benign exit codes")
			}
			if len(tc.r.calls) != 2 {
				t.Errorf("both stop and start should run, got %d calls", len(tc.r.calls))
			}
		})
	}
}

func TestHandler_StopUnknownServiceFailsBeforeStart(t *testing.T) {
	sb := DefaultSandboxConfig()
	sb.Mocked = false
	r := &fakeRunner{stopErr: fakeExitError{code: scErrServiceDoesNotExist}}

	if _, err := invoke(t, sb, r, `{"service":"nginx"}`); err == nil {
		t.Fatal("service-not-found must fail the restart")
	}
	if len(r.calls) != 1 {
		t.Errorf("unknown service must not reach start, got %d calls", len(r.calls))
	}
}

func TestCanonicalServiceName(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"W3SVC", "w3svc"},
		{"w3svc", "w3svc"},
		{"  W3SVC  ", "w3svc"},
		{"Nginx.EXE", "nginx"},
		{"Redis.service", "redis"},
		{"MySQL (MySQL Server)", "mysql"},
		{"", ""},
		{"   ", ""},
		{`..\evil`, ""},
		{"/bin/sh", ""},
	}
	for _, tc := range cases {
		if got := canonicalServiceName(tc.input); got != tc.want {
			t.Errorf("canonicalServiceName(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestCanonicalServiceName_LengthLimit(t *testing.T) {
	long := strings.Repeat("a", maxServiceNameLen+1)
	if got := canonicalServiceName(long); got != "" {
		t.Errorf("overlong service name should canonicalize to empty, got %d chars", len(got))
	}
	atLimit := strings.Repeat("a", maxServiceNameLen)
	if got := canonicalServiceName(atLimit); got != atLimit {
		t.Errorf("service name at limit should be accepted")
	}
}

func TestSandbox_AllowsCanonicalForms(t *testing.T) {
	sb := DefaultSandboxConfig()
	for _, in := range []string{"W3SVC", "w3svc", " W3SVC ", "W3SVC.exe", "MySQL", "redis", "nginx", "ongrid"} {
		if !sb.Allows(in) {
			t.Errorf("Allows(%q) = false, want true", in)
		}
	}
	for _, in := range []string{"", "sshd", "nginx; rm -rf /"} {
		if sb.Allows(in) {
			t.Errorf("Allows(%q) = true, want false", in)
		}
	}
}

func TestLoadSandboxConfig_MissingUsesDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "restart-policy.json")
	sb, err := loadSandboxConfig(path)
	if err != nil {
		t.Fatalf("missing policy should fall back to defaults: %v", err)
	}
	if got := strings.Join(sb.AllowedServices, ","); got != "W3SVC,MySQL,Redis,nginx,ongrid" {
		t.Errorf("default allow-list = %q", got)
	}
	if sb.Mocked {
		t.Error("mocked default must be false on Windows")
	}
}

func TestLoadSandboxConfig_ReadsOverride(t *testing.T) {
	path := filepath.Join(t.TempDir(), "restart-policy.json")
	body := `{"allowed_services":["Foo","bar.exe"],"mocked":true}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	sb, err := loadSandboxConfig(path)
	if err != nil {
		t.Fatalf("load policy: %v", err)
	}
	if got := strings.Join(sb.AllowedServices, ","); got != "Foo,bar.exe" {
		t.Errorf("allowed_services = %q", got)
	}
	if !sb.Mocked {
		t.Error("mocked should be true from policy file")
	}
	if !sb.Allows("foo") || !sb.Allows("BAR") {
		t.Error("policy entries should match case-insensitively")
	}
}

func TestLoadSandboxConfig_PartialFileKeepsDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "restart-policy.json")
	if err := os.WriteFile(path, []byte(`{"mocked":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	sb, err := loadSandboxConfig(path)
	if err != nil {
		t.Fatalf("load policy: %v", err)
	}
	if !sb.Allows("W3SVC") {
		t.Error("absent allowed_services should keep the default allow-list")
	}
	if !sb.Mocked {
		t.Error("mocked should come from the file")
	}
}

func TestLoadSandboxConfig_RejectsEmptyAndMalformed(t *testing.T) {
	cases := map[string]string{
		"empty allow-list": `{"allowed_services":[]}`,
		"malformed json":   `{"allowed_services":`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "restart-policy.json")
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := loadSandboxConfig(path); err == nil {
				t.Errorf("%s should be rejected", name)
			}
		})
	}
}

func TestResolveScExe_PrefersSystemRoot(t *testing.T) {
	root := `C:\FakeWindows`
	t.Setenv("SystemRoot", root)
	t.Setenv("windir", `C:\Other`)
	got, err := resolveScExe()
	if err != nil {
		t.Fatalf("resolveScExe: %v", err)
	}
	want := filepath.Join(root, "System32", "sc.exe")
	if got != want {
		t.Errorf("resolveScExe = %q, want %q", got, want)
	}
	if !filepath.IsAbs(got) {
		t.Errorf("resolved sc.exe must be absolute: %q", got)
	}
}

func TestResolveScExe_FallsBackToWindir(t *testing.T) {
	root := `D:\Windows`
	t.Setenv("SystemRoot", "")
	t.Setenv("windir", root)
	got, err := resolveScExe()
	if err != nil {
		t.Fatalf("resolveScExe: %v", err)
	}
	want := filepath.Join(root, "System32", "sc.exe")
	if got != want {
		t.Errorf("resolveScExe = %q, want %q", got, want)
	}
}

func TestResolveScExe_RejectsMissingOrRelativeRoot(t *testing.T) {
	t.Setenv("SystemRoot", "")
	t.Setenv("windir", "")
	if _, err := resolveScExe(); err == nil {
		t.Error("missing SystemRoot/windir should error")
	}
	t.Setenv("SystemRoot", "relative-root")
	if _, err := resolveScExe(); err == nil {
		t.Error("relative SystemRoot should be rejected")
	}
}

func TestRegister_RegistersMethod(t *testing.T) {
	// Any absolute root suffices for path construction; resolveScExe does
	// not stat the binary here. registerWith takes the policy path directly
	// so the test never reads the machine's real ProgramData file.
	t.Setenv("SystemRoot", t.TempDir())
	policyPath := filepath.Join(t.TempDir(), "restart-policy.json")
	c := newFakeClient()
	if err := registerWith(c, nil, policyPath); err != nil {
		t.Fatalf("registerWith: %v", err)
	}
	if c.handler(tunnel.MethodRestartService) == nil {
		t.Fatalf("handler not registered for %q", tunnel.MethodRestartService)
	}
}
