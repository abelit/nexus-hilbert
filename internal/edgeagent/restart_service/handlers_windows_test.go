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
	"time"

	"github.com/ongridio/ongrid/internal/pkg/tunnel"
)

const testScPath = `C:\Windows\System32\sc.exe`

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

// fakeExitError mimics *exec.ExitError for sc.exe exit-code handling.
type fakeExitError struct{ code int }

func (e fakeExitError) Error() string { return fmt.Sprintf("exit status %d", e.code) }
func (e fakeExitError) ExitCode() int { return e.code }

type scCall struct {
	name string
	args []string
}

// fakeRunner is the injectable sc.exe seam. It records every call and
// returns scripted query/stop/start results. queryOuts / startErrs are
// consumed in order; when they run out, the last entry repeats (queries)
// or the call succeeds (starts).
type fakeRunner struct {
	calls     []scCall
	queryOuts [][]byte
	queryErrs []error
	queryIdx  int
	stopOut   []byte
	stopErr   error
	startOut  []byte
	startErrs []error
	startIdx  int
}

func (f *fakeRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, scCall{name: name, args: append([]string(nil), args...)})
	if len(args) == 0 {
		return nil, nil
	}
	switch args[0] {
	case "query":
		i := f.queryIdx
		f.queryIdx++
		if i < len(f.queryErrs) && f.queryErrs[i] != nil {
			return nil, f.queryErrs[i]
		}
		if i < len(f.queryOuts) && f.queryOuts[i] != nil {
			return f.queryOuts[i], nil
		}
		if len(f.queryOuts) > 0 {
			if last := f.queryOuts[len(f.queryOuts)-1]; last != nil {
				return last, nil
			}
		}
		return scQueryOutput(args[1], scStateRunning), nil
	case "stop":
		return f.stopOut, f.stopErr
	case "start":
		i := f.startIdx
		f.startIdx++
		if i < len(f.startErrs) && f.startErrs[i] != nil {
			return f.startOut, f.startErrs[i]
		}
		return f.startOut, nil
	}
	return nil, nil
}

// scQueryOutput builds the shape sc.exe query emits for one service. The
// status word is deliberately not used by the parser; the numeric code is.
func scQueryOutput(name string, state int) []byte {
	return []byte(fmt.Sprintf(
		"SERVICE_NAME: %s\r\n"+
			"        TYPE               : 20  WIN32_SHARE_PROCESS\r\n"+
			"        STATE              : %d  RUNNING\r\n"+
			"                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)\r\n"+
			"        WIN32_EXIT_CODE    : 0  (0x0)\r\n"+
			"        SERVICE_EXIT_CODE  : 0  (0x0)\r\n"+
			"        CHECKPOINT         : 0x0\r\n"+
			"        WAIT_HINT          : 0x0\r\n",
		name, state))
}

// countingSleeper simulates the bounded poll clock: the first `limit`
// sleeps succeed and any further sleep reports the context deadline.
type countingSleeper struct {
	calls int
	limit int
}

func (s *countingSleeper) sleep(context.Context, time.Duration) error {
	s.calls++
	if s.calls > s.limit {
		return context.DeadlineExceeded
	}
	return nil
}

func invoke(t *testing.T, sb *SandboxConfig, seq *scSequencer, body string) (tunnel.RestartServiceResponse, error) {
	t.Helper()
	h := makeRestartHandlerWithSequencer(sb, seq, nil)
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

func callNames(r *fakeRunner) []string {
	out := make([]string, 0, len(r.calls))
	for _, c := range r.calls {
		out = append(out, strings.Join(c.args, " "))
	}
	return out
}

func TestHandler_AllowedServiceQueriesWaitsThenStarts(t *testing.T) {
	sb := DefaultSandboxConfig()
	sb.Mocked = false
	r := &fakeRunner{queryOuts: [][]byte{
		scQueryOutput("W3SVC", scStateRunning),
		scQueryOutput("W3SVC", scStateStopped),
	}}
	seq := newSCSequencer(r, testScPath)

	resp, err := invoke(t, sb, seq, `{"service":"w3svc","reason":"502s"}`)
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
	want := []string{"query W3SVC", "stop W3SVC", "query W3SVC", "start W3SVC"}
	if got := callNames(r); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("sc.exe calls = %v, want %v", got, want)
	}
	for _, c := range r.calls {
		if c.name != testScPath {
			t.Errorf("call %v used %q, want absolute %q", c.args, c.name, testScPath)
		}
	}
}

// TestHandler_WaitsForStopPendingBeforeStart is the regression test for the
// asynchronous sc.exe stop race: the first poll still reports STOP_PENDING
// and start must not run until a later poll reports STOPPED.
func TestHandler_WaitsForStopPendingBeforeStart(t *testing.T) {
	sb := DefaultSandboxConfig()
	sb.Mocked = false
	r := &fakeRunner{queryOuts: [][]byte{
		scQueryOutput("nginx", scStateRunning),
		scQueryOutput("nginx", scStateStopPending),
		scQueryOutput("nginx", scStateStopped),
	}}
	seq := newSCSequencer(r, testScPath)
	seq.sleep = func(context.Context, time.Duration) error { return nil }

	if _, err := invoke(t, sb, seq, `{"service":"nginx"}`); err != nil {
		t.Fatalf("handler error: %v", err)
	}
	want := []string{"query nginx", "stop nginx", "query nginx", "query nginx", "start nginx"}
	if got := callNames(r); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("sc.exe calls = %v, want %v", got, want)
	}
}

func TestHandler_TimeoutWaitingForStopDoesNotStart(t *testing.T) {
	sb := DefaultSandboxConfig()
	sb.Mocked = false
	r := &fakeRunner{queryOuts: [][]byte{
		scQueryOutput("nginx", scStateRunning),
		scQueryOutput("nginx", scStateStopPending),
	}}
	seq := newSCSequencer(r, testScPath)
	sleeper := &countingSleeper{limit: 2}
	seq.sleep = sleeper.sleep

	_, err := invoke(t, sb, seq, `{"service":"nginx"}`)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if !strings.Contains(err.Error(), "timed out waiting for state STOPPED") {
		t.Errorf("error should mention stop timeout: %v", err)
	}
	for _, c := range r.calls {
		if len(c.args) > 0 && c.args[0] == "start" {
			t.Fatalf("start must not run after a stop timeout: %v", callNames(r))
		}
	}
}

func TestHandler_AlreadyStoppedJustStarts(t *testing.T) {
	sb := DefaultSandboxConfig()
	sb.Mocked = false
	r := &fakeRunner{queryOuts: [][]byte{scQueryOutput("nginx", scStateStopped)}}
	seq := newSCSequencer(r, testScPath)

	if _, err := invoke(t, sb, seq, `{"service":"nginx"}`); err != nil {
		t.Fatalf("handler error: %v", err)
	}
	want := []string{"query nginx", "start nginx"}
	if got := callNames(r); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("sc.exe calls = %v, want %v", got, want)
	}
}

func TestHandler_DisallowedServiceDoesNotRun(t *testing.T) {
	sb := DefaultSandboxConfig()
	sb.Mocked = false
	r := &fakeRunner{}

	_, err := invoke(t, sb, newSCSequencer(r, testScPath), `{"service":"sshd"}`)
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

	resp, err := invoke(t, sb, newSCSequencer(r, testScPath), `{"service":"nginx"}`)
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
		if _, err := invoke(t, sb, newSCSequencer(r, testScPath), body); err == nil {
			t.Errorf("body %s should be rejected", body)
		}
		if len(r.calls) != 0 {
			t.Errorf("body %s must not run sc.exe", body)
		}
	}
}

// TestHandler_StopNotActiveIsBenign covers a service that stopped between
// the pre-stop query and the stop call.
func TestHandler_StopNotActiveIsBenign(t *testing.T) {
	sb := DefaultSandboxConfig()
	sb.Mocked = false
	r := &fakeRunner{
		queryOuts: [][]byte{
			scQueryOutput("nginx", scStateRunning),
			scQueryOutput("nginx", scStateStopped),
		},
		stopErr: fakeExitError{code: scErrServiceNotActive},
	}

	if _, err := invoke(t, sb, newSCSequencer(r, testScPath), `{"service":"nginx"}`); err != nil {
		t.Fatalf("benign stop exit should not fail: %v", err)
	}
	want := []string{"query nginx", "stop nginx", "query nginx", "start nginx"}
	if got := callNames(r); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("sc.exe calls = %v, want %v", got, want)
	}
}

func TestHandler_StartAlreadyRunningBenignOnlyWhenWasRunning(t *testing.T) {
	t.Run("was running", func(t *testing.T) {
		sb := DefaultSandboxConfig()
		sb.Mocked = false
		r := &fakeRunner{
			queryOuts: [][]byte{
				scQueryOutput("nginx", scStateRunning),
				scQueryOutput("nginx", scStateStopped),
			},
			startErrs: []error{fakeExitError{code: scErrServiceAlreadyRunning}},
		}
		if _, err := invoke(t, sb, newSCSequencer(r, testScPath), `{"service":"nginx"}`); err != nil {
			t.Fatalf("1056 after a known-running stop race should be benign: %v", err)
		}
	})

	t.Run("was stopped", func(t *testing.T) {
		sb := DefaultSandboxConfig()
		sb.Mocked = false
		r := &fakeRunner{
			queryOuts: [][]byte{scQueryOutput("nginx", scStateStopped)},
			startErrs: []error{fakeExitError{code: scErrServiceAlreadyRunning}},
		}
		if _, err := invoke(t, sb, newSCSequencer(r, testScPath), `{"service":"nginx"}`); err == nil {
			t.Fatal("1056 for a service that was not previously running must fail")
		}
	})
}

// TestHandler_StartCannotAcceptControlIsRetried covers the mid-stop 1061
// race: the start is retried once the SCM reports STOPPED again.
func TestHandler_StartCannotAcceptControlIsRetried(t *testing.T) {
	sb := DefaultSandboxConfig()
	sb.Mocked = false
	r := &fakeRunner{
		queryOuts: [][]byte{
			scQueryOutput("nginx", scStateRunning),
			scQueryOutput("nginx", scStateStopped),
			scQueryOutput("nginx", scStateStopped),
		},
		startErrs: []error{fakeExitError{code: scErrServiceCannotAcceptCtrl}, nil},
	}
	seq := newSCSequencer(r, testScPath)
	seq.sleep = func(context.Context, time.Duration) error { return nil }

	if _, err := invoke(t, sb, seq, `{"service":"nginx"}`); err != nil {
		t.Fatalf("1061 should be retried, not fatal: %v", err)
	}
	want := []string{
		"query nginx", "stop nginx", "query nginx",
		"start nginx", "query nginx", "start nginx",
	}
	if got := callNames(r); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("sc.exe calls = %v, want %v", got, want)
	}
}

func TestHandler_QueryUnknownServiceFails(t *testing.T) {
	sb := DefaultSandboxConfig()
	sb.Mocked = false
	r := &fakeRunner{queryErrs: []error{fakeExitError{code: scErrServiceDoesNotExist}}}

	if _, err := invoke(t, sb, newSCSequencer(r, testScPath), `{"service":"nginx"}`); err == nil {
		t.Fatal("service-not-found must fail the restart")
	}
	if len(r.calls) != 1 {
		t.Errorf("unknown service must fail at the first query, got %v", callNames(r))
	}
}

func TestParseServiceState(t *testing.T) {
	multi := []byte(
		"SERVICE_NAME: W3SVC\r\n" +
			"        STATE              : 4  RUNNING\r\n" +
			"SERVICE_NAME: W3SVCX\r\n" +
			"        STATE              : 1  STOPPED\r\n")

	cases := []struct {
		name    string
		out     []byte
		service string
		want    int
		ok      bool
	}{
		{"running", scQueryOutput("nginx", scStateRunning), "nginx", scStateRunning, true},
		{"stopped", scQueryOutput("nginx", scStateStopped), "nginx", scStateStopped, true},
		{"stop pending", scQueryOutput("nginx", scStateStopPending), "nginx", scStateStopPending, true},
		{
			name: "localised labels and status word",
			out: []byte("NOM_SERVICE: Redis\r\n" +
				"        TYPE               : 10  WIN32_OWN_PROCESS\r\n" +
				"        ETAT               : 3  ARRET_EN_COURS\r\n" +
				"        WIN32_EXIT_CODE    : 0  (0x0)\r\n"),
			service: "Redis",
			want:    scStateStopPending,
			ok:      true,
		},
		{"first of multiple blocks", multi, "W3SVC", scStateRunning, true},
		{"second of multiple blocks", multi, "W3SVCX", scStateStopped, true},
		{"no matching block", multi, "other", 0, false},
		{"no state line", []byte("SERVICE_NAME: nginx\r\n        TYPE : 20  WIN32_SHARE_PROCESS\r\n"), "nginx", 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseServiceState(tc.out, tc.service)
			if ok != tc.ok || got != tc.want {
				t.Errorf("parseServiceState() = (%d, %v), want (%d, %v)", got, ok, tc.want, tc.ok)
			}
		})
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
		t.Error("service name at limit should be accepted")
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
