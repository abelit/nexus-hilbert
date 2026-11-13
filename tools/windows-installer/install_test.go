package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// testSystem32 is the deterministic System32 path the test resolver returns,
// so command assertions do not depend on the host environment.
const testSystem32 = `C:\Windows\System32`

func TestMain(m *testing.M) {
	systemToolFn = func(name string) (string, error) {
		return testSystem32 + `\` + name, nil
	}
	os.Exit(m.Run())
}

func TestResolveSystemToolUsesSystemRoot(t *testing.T) {
	root := t.TempDir()
	system32 := filepath.Join(root, "System32")
	if err := os.MkdirAll(system32, 0755); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(system32, "icacls.exe")
	if err := os.WriteFile(want, []byte("fake"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SystemRoot", root)
	got, err := resolveSystemTool("icacls.exe")
	if err != nil {
		t.Fatalf("resolveSystemTool() error: %v", err)
	}
	if got != want {
		t.Fatalf("resolveSystemTool() = %q, want %q", got, want)
	}
}

func TestResolveSystemToolRequiresSystemRoot(t *testing.T) {
	t.Setenv("SystemRoot", "")
	t.Setenv("windir", "")
	if _, err := resolveSystemTool("sc.exe"); err == nil {
		t.Fatal("resolveSystemTool() error = nil, want missing SystemRoot error")
	}
}

// recordedCommand is one command captured by fakeRunner.
type recordedCommand struct {
	name string
	args []string
}

// fakeRunner records every command and optionally fails it.
type fakeRunner struct {
	mu    sync.Mutex
	calls []recordedCommand
	run   func(name string, args []string) error
}

func (f *fakeRunner) Run(name string, args ...string) error {
	f.mu.Lock()
	f.calls = append(f.calls, recordedCommand{name: name, args: append([]string(nil), args...)})
	f.mu.Unlock()
	if f.run != nil {
		return f.run(name, args)
	}
	return nil
}

func (f *fakeRunner) snapshot() []recordedCommand {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recordedCommand(nil), f.calls...)
}

// testDeployPaths returns deployPaths rooted in a temporary directory so the
// orchestration tests never touch the real Program Files or ProgramData trees.
func testDeployPaths(t *testing.T) deployPaths {
	t.Helper()
	root := t.TempDir()
	installRoot := filepath.Join(root, "Program Files", "ongrid-edge")
	dataDir := filepath.Join(root, "ProgramData", "ongrid-edge")
	return deployPaths{
		InstallRoot:   installRoot,
		BinDir:        filepath.Join(installRoot, "bin"),
		PluginBinDir:  filepath.Join(installRoot, "plugins"),
		EtcDir:        filepath.Join(installRoot, "etc"),
		DataDir:       dataDir,
		PluginWorkDir: filepath.Join(dataDir, "plugins"),
		StageDir:      filepath.Join(dataDir, "upgrade"),
		HealthFile:    filepath.Join(dataDir, "health.json"),
		SecretsFile:   filepath.Join(dataDir, "secrets.enc"),
	}
}

func TestRunSecureDirBuildsIcaclsCommand(t *testing.T) {
	runner := &fakeRunner{}
	dir := `C:\Program Files\ongrid-edge\bin`
	if err := runSecureDir(runner, dir); err != nil {
		t.Fatalf("runSecureDir() error: %v", err)
	}

	calls := runner.snapshot()
	if len(calls) != 1 {
		t.Fatalf("commands = %d, want 1: %+v", len(calls), calls)
	}
	if calls[0].name != testSystem32+`\icacls.exe` {
		t.Fatalf("command = %q, want absolute System32 icacls", calls[0].name)
	}
	want := []string{
		dir,
		"/inheritance:r",
		"/grant:r",
		"*S-1-5-18:(OI)(CI)(F)",
		"*S-1-5-32-544:(OI)(CI)(F)",
	}
	if strings.Join(calls[0].args, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("args = %v, want %v", calls[0].args, want)
	}
}

func TestRunSecureDirPropagatesFailure(t *testing.T) {
	runner := &fakeRunner{run: func(string, []string) error {
		return errors.New("access denied")
	}}
	if err := runSecureDir(runner, `C:\ProgramData\ongrid-edge`); err == nil {
		t.Fatal("runSecureDir() error = nil, want error")
	}
}

func TestInstallServiceInvokesSupervisorConfigFile(t *testing.T) {
	runner := &fakeRunner{}
	supervisorPath := `C:\Program Files\ongrid-edge\bin\ongrid-edge-supervisor.exe`
	configPath := `C:\ProgramData\ongrid-edge\install-123.json`
	if err := installService(runner, supervisorPath, configPath); err != nil {
		t.Fatalf("installService() error: %v", err)
	}

	calls := runner.snapshot()
	if len(calls) != 1 {
		t.Fatalf("commands = %d, want 1", len(calls))
	}
	if calls[0].name != supervisorPath {
		t.Fatalf("command = %q, want %q", calls[0].name, supervisorPath)
	}
	want := []string{"--install", "--config-file", configPath}
	if strings.Join(calls[0].args, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("args = %v, want %v", calls[0].args, want)
	}
}

func TestInstallServicePropagatesExitAndStderr(t *testing.T) {
	runner := &fakeRunner{run: func(name string, args []string) error {
		return &commandError{
			name:   name,
			args:   args,
			stderr: "config rejected",
			err:    errors.New("exit status 1"),
		}
	}}
	err := installService(runner, "supervisor.exe", "config.json")
	if err == nil {
		t.Fatal("installService() error = nil, want error")
	}
	if !strings.Contains(err.Error(), "config rejected") {
		t.Fatalf("error = %v, want stderr surfaced", err)
	}
}

func existingSupervisor(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ongrid-edge-supervisor.exe")
	if err := os.WriteFile(path, []byte("supervisor"), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestUninstallServiceToleratesMissingService(t *testing.T) {
	runner := &fakeRunner{run: func(name string, args []string) error {
		return &commandError{
			name:   name,
			args:   args,
			stderr: "[SC] OpenService FAILED 1060: The specified service does not exist as an installed service.",
			err:    errors.New("exit status 1"),
		}
	}}
	if err := uninstallService(runner, existingSupervisor(t)); err != nil {
		t.Fatalf("uninstallService() error = %v, want nil for missing service", err)
	}
}

// TestUninstallServiceMissingSupervisorIsSuccess covers a host where the
// installer never ran: there is no binary to delegate to, and that is already
// the desired end state.
func TestUninstallServiceMissingSupervisorIsSuccess(t *testing.T) {
	runner := &fakeRunner{}
	missing := filepath.Join(t.TempDir(), "ongrid-edge-supervisor.exe")
	if err := uninstallService(runner, missing); err != nil {
		t.Fatalf("uninstallService() error = %v, want nil for missing supervisor", err)
	}
	if calls := runner.snapshot(); len(calls) != 0 {
		t.Fatalf("runner should not be called when the supervisor is absent: %+v", calls)
	}
}

// TestUninstallServiceFilesNotFoundIsSuccess covers a supervisor path that
// disappears between the stat and the exec.
func TestUninstallServiceFilesNotFoundIsSuccess(t *testing.T) {
	runner := &fakeRunner{run: func(string, []string) error {
		return &commandError{err: exec.ErrNotFound}
	}}
	if err := uninstallService(runner, existingSupervisor(t)); err != nil {
		t.Fatalf("uninstallService() error = %v, want nil for exec.ErrNotFound", err)
	}
}

func TestUninstallServicePropagatesOtherFailures(t *testing.T) {
	runner := &fakeRunner{run: func(string, []string) error {
		return &commandError{stderr: "access denied", err: errors.New("exit status 5")}
	}}
	if err := uninstallService(runner, existingSupervisor(t)); err == nil {
		t.Fatal("uninstallService() error = nil, want non-nil")
	}
}

func TestDownloadArtifactDeletesFileOnSHA256Mismatch(t *testing.T) {
	payload := []byte("tampered artifact")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(payload)
	}))
	defer server.Close()

	dest := filepath.Join(t.TempDir(), "artifact.exe")
	err := downloadArtifact(context.Background(), server.Client(), server.URL, dest, strings.Repeat("a", 64))
	if err == nil {
		t.Fatal("downloadArtifact() error = nil, want sha256 mismatch")
	}
	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Fatalf("artifact still exists after mismatch: %v", statErr)
	}
}

// installFixture serves a manifest and artifacts, and records download order.
type installFixture struct {
	server *httptest.Server
	events []string
	mu     sync.Mutex
}

func newInstallFixture(t *testing.T, files map[string][]byte, dests map[string]string) *installFixture {
	t.Helper()
	fixture := &installFixture{}
	fixture.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fixture.mu.Lock()
		fixture.events = append(fixture.events, "download:"+r.URL.Path)
		fixture.mu.Unlock()

		if r.URL.Path == "/edge/windows/manifest.json" {
			_, _ = io.WriteString(w, fixtureManifest(files, dests))
			return
		}
		const prefix = "/edge/windows/"
		if strings.HasPrefix(r.URL.Path, prefix) {
			name := strings.TrimPrefix(r.URL.Path, prefix)
			payload, ok := files[name]
			if !ok {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write(payload)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(fixture.server.Close)
	return fixture
}

func fixtureManifest(files map[string][]byte, dests map[string]string) string {
	var entries []string
	for name, payload := range files {
		entries = append(entries, fmt.Sprintf(
			`{"path":%q,"sha256":%q,"dest":%q}`,
			name, sha256Hex(payload), dests[name],
		))
	}
	return fmt.Sprintf(`{"schema":1,"version":"v1.0.0","variants":[{"id":"windows-amd64","min_os":{"major":10,"build":14393},"files":[%s]}]}`,
		strings.Join(entries, ","))
}

func TestInstallSecuresBeforeDownloadAndPlacesArtifacts(t *testing.T) {
	files := map[string][]byte{
		"ongrid-edge-supervisor.exe":   []byte("supervisor-binary"),
		"ongrid-edge-worker.exe":       []byte("worker-binary"),
		"plugins/windows_exporter.exe": []byte("plugin-binary"),
		"edge.conf":                    []byte("conf-binary"),
	}
	dests := map[string]string{
		"ongrid-edge-supervisor.exe":   "bin",
		"ongrid-edge-worker.exe":       "bin",
		"plugins/windows_exporter.exe": "plugins",
		"edge.conf":                    "etc",
	}
	fixture := newInstallFixture(t, files, dests)

	paths := testDeployPaths(t)
	var (
		eventMu sync.Mutex
		events  []string
	)
	record := func(event string) {
		eventMu.Lock()
		events = append(events, event)
		eventMu.Unlock()
	}
	// Merge download events recorded by the fixture into the same timeline.
	fixtureEvents := func() []string {
		fixture.mu.Lock()
		defer fixture.mu.Unlock()
		return append([]string(nil), fixture.events...)
	}

	var (
		capturedSupervisor string
		capturedConfigPath string
		capturedConfig     []byte
	)
	runner := &fakeRunner{}
	deps := installDeps{
		paths:  paths,
		runner: runner,
		secureDir: func(dir string) error {
			record("secure:" + dir)
			return nil
		},
		installService: func(supervisorPath, configPath string) error {
			capturedSupervisor = supervisorPath
			capturedConfigPath = configPath
			data, err := os.ReadFile(configPath)
			if err != nil {
				return fmt.Errorf("read config file: %w", err)
			}
			capturedConfig = data
			record("install")
			// Simulate the service writing a fresh health file before readiness polling.
			if err := os.WriteFile(paths.HealthFile, []byte(`{"healthy":true}`), 0600); err != nil {
				return err
			}
			return nil
		},
		client:        fixture.server.Client(),
		hostInfo:      func() (HostInfo, error) { return fixedHostInfo(), nil },
		osVersion:     func() (OSVersion, error) { return OSVersion{Major: 10, Build: 17763}, nil },
		fetchManifest: fetchManifest,
		now:           time.Now,
		sleep:         func(time.Duration) {},
		readyTimeout:  time.Second,
		pollInterval:  time.Millisecond,
		agentVersion:  "v1.0.0",
	}
	opts := Options{
		ManagerURL:     fixture.server.URL,
		AccessKey:      "ak_test",
		SecretKey:      "sk_super_secret",
		ServerEdgeAddr: "edge.example.com:40012",
		Variant:        "auto",
	}

	if err := Install(context.Background(), opts, deps); err != nil {
		t.Fatalf("Install() error: %v", err)
	}

	// Every install root and the staging directory must be hardened.
	eventMu.Lock()
	secureEvents := make([]string, 0, len(events))
	installSeen := false
	for _, event := range events {
		if strings.HasPrefix(event, "secure:") {
			secureEvents = append(secureEvents, event)
		}
		if event == "install" {
			installSeen = true
		}
	}
	eventMu.Unlock()
	if !installSeen {
		t.Fatal("supervisor install was not invoked")
	}
	if len(secureEvents) < 7 {
		t.Fatalf("secure events = %v, want install roots plus staging", secureEvents)
	}
	// The staging directory must be one of the secured paths.
	foundStaging := false
	for _, event := range secureEvents {
		if strings.Contains(event, "download-") {
			foundStaging = true
		}
	}
	if !foundStaging {
		t.Fatalf("staging directory was not secured: %v", secureEvents)
	}
	if len(fixtureEvents()) == 0 {
		t.Fatal("no downloads recorded")
	}

	// Placement.
	for name, dest := range dests {
		dir := map[string]string{"bin": paths.BinDir, "plugins": paths.PluginBinDir, "etc": paths.EtcDir}[dest]
		placed := filepath.Join(dir, filepath.Base(name))
		got, err := os.ReadFile(placed)
		if err != nil {
			t.Fatalf("read placed %s: %v", placed, err)
		}
		if string(got) != string(files[name]) {
			t.Fatalf("placed %s = %q, want %q", placed, got, files[name])
		}
	}

	if capturedSupervisor != paths.supervisorPath() {
		t.Fatalf("supervisor path = %q, want %q", capturedSupervisor, paths.supervisorPath())
	}

	// Config contents.
	var config supervisorConfig
	if err := json.Unmarshal(capturedConfig, &config); err != nil {
		t.Fatalf("decode captured config: %v", err)
	}
	if config.CloudAddr != opts.ServerEdgeAddr {
		t.Errorf("cloud_addr = %q, want %q", config.CloudAddr, opts.ServerEdgeAddr)
	}
	if config.AccessKey != opts.AccessKey || config.SecretKey != opts.SecretKey {
		t.Errorf("credentials not written to config: %+v", config)
	}
	if config.CollectorMode != "off" {
		t.Errorf("collector_mode = %q, want off", config.CollectorMode)
	}
	if config.PluginBinDir != paths.PluginBinDir {
		t.Errorf("plugin_bin_dir = %q, want %q", config.PluginBinDir, paths.PluginBinDir)
	}
	if config.PluginWorkDir != paths.PluginWorkDir {
		t.Errorf("plugin_work_dir = %q, want %q", config.PluginWorkDir, paths.PluginWorkDir)
	}
	if config.ScrapeConfigFile != filepath.Join(paths.DataDir, "scrape.yaml") {
		t.Errorf("scrape_config_file = %q", config.ScrapeConfigFile)
	}

	// The secret must never appear in a command line.
	for _, call := range runner.snapshot() {
		for _, arg := range call.args {
			if strings.Contains(arg, opts.SecretKey) {
				t.Fatalf("secret leaked into argv: %s %v", call.name, call.args)
			}
		}
	}
	if len(runner.snapshot()) == 0 {
		t.Fatal("expected sc.exe query poll commands")
	}

	// The config file is deleted after a successful install.
	if _, err := os.Stat(capturedConfigPath); !os.IsNotExist(err) {
		t.Fatalf("config file still exists after install: %v", err)
	}
}

// orderingRecorder is a small shared timeline used by the ACL ordering test.
type orderingRecorder struct {
	mu     sync.Mutex
	events []string
}

func (r *orderingRecorder) add(event string) {
	r.mu.Lock()
	r.events = append(r.events, event)
	r.mu.Unlock()
}

func (r *orderingRecorder) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.events...)
}

func TestInstallSecuresStagingBeforeAgentDownload(t *testing.T) {
	files := map[string][]byte{
		"ongrid-edge-supervisor.exe": []byte("supervisor-binary"),
		"ongrid-edge-worker.exe":     []byte("worker-binary"),
	}
	dests := map[string]string{
		"ongrid-edge-supervisor.exe": "bin",
		"ongrid-edge-worker.exe":     "bin",
	}
	recorder := &orderingRecorder{}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".exe") {
			recorder.add("download:" + r.URL.Path)
		}
		if r.URL.Path == "/edge/windows/manifest.json" {
			_, _ = io.WriteString(w, fixtureManifest(files, dests))
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/edge/windows/")
		payload, ok := files[name]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(payload)
	}))
	defer server.Close()

	paths := testDeployPaths(t)
	deps := installDeps{
		paths:  paths,
		runner: &fakeRunner{},
		secureDir: func(dir string) error {
			recorder.add("secure:" + dir)
			return nil
		},
		installService: func(string, string) error {
			recorder.add("install")
			if err := os.WriteFile(paths.HealthFile, []byte(`{}`), 0600); err != nil {
				return err
			}
			return nil
		},
		client:        server.Client(),
		hostInfo:      func() (HostInfo, error) { return fixedHostInfo(), nil },
		osVersion:     func() (OSVersion, error) { return OSVersion{Major: 10, Build: 17763}, nil },
		fetchManifest: fetchManifest,
		now:           time.Now,
		sleep:         func(time.Duration) {},
		readyTimeout:  time.Second,
		pollInterval:  time.Millisecond,
	}
	opts := Options{
		ManagerURL:     server.URL,
		AccessKey:      "ak_test",
		SecretKey:      "sk_test",
		ServerEdgeAddr: "edge.example.com:40012",
		Variant:        "auto",
	}
	if err := Install(context.Background(), opts, deps); err != nil {
		t.Fatalf("Install() error: %v", err)
	}

	events := recorder.snapshot()
	lastSecure := -1
	firstDownload := -1
	for i, event := range events {
		if strings.HasPrefix(event, "secure:") {
			lastSecure = i
		}
		if strings.HasPrefix(event, "download:") && firstDownload == -1 {
			firstDownload = i
		}
	}
	if lastSecure == -1 || firstDownload == -1 {
		t.Fatalf("missing events: %v", events)
	}
	if lastSecure > firstDownload {
		t.Fatalf("download happened before staging was secured: %v", events)
	}
}

// TestInstallStopsExistingServiceBeforePlacement verifies a reinstall stops
// the running service (releasing binary locks) before files are replaced.
func TestInstallStopsExistingServiceBeforePlacement(t *testing.T) {
	files := map[string][]byte{
		"ongrid-edge-supervisor.exe": []byte("supervisor-binary"),
		"ongrid-edge-worker.exe":     []byte("worker-binary"),
	}
	dests := map[string]string{
		"ongrid-edge-supervisor.exe": "bin",
		"ongrid-edge-worker.exe":     "bin",
	}
	fixture := newInstallFixture(t, files, dests)
	paths := testDeployPaths(t)

	var (
		stopCommands     []recordedCommand
		placedAtStop     bool
		supervisorPlaced = filepath.Join(paths.BinDir, "ongrid-edge-supervisor.exe")
	)
	runner := &fakeRunner{run: func(name string, args []string) error {
		if name == testSystem32+`\sc.exe` && len(args) > 0 && args[0] == "stop" {
			stopCommands = append(stopCommands, recordedCommand{name: name, args: append([]string(nil), args...)})
			if _, err := os.Stat(supervisorPlaced); err == nil {
				placedAtStop = true
			}
		}
		return nil
	}}
	deps := installDeps{
		paths:     paths,
		runner:    runner,
		secureDir: func(string) error { return nil },
		installService: func(string, string) error {
			if err := os.WriteFile(paths.HealthFile, []byte(`{}`), 0600); err != nil {
				return err
			}
			return nil
		},
		client:        fixture.server.Client(),
		hostInfo:      func() (HostInfo, error) { return fixedHostInfo(), nil },
		osVersion:     func() (OSVersion, error) { return OSVersion{Major: 10, Build: 17763}, nil },
		fetchManifest: fetchManifest,
		now:           time.Now,
		sleep:         func(time.Duration) {},
		readyTimeout:  time.Second,
		pollInterval:  time.Millisecond,
	}
	opts := Options{
		ManagerURL:     fixture.server.URL,
		AccessKey:      "ak",
		SecretKey:      "sk",
		ServerEdgeAddr: "edge.example.com:40012",
		Variant:        "auto",
	}
	if err := Install(context.Background(), opts, deps); err != nil {
		t.Fatalf("Install() error: %v", err)
	}
	if len(stopCommands) != 1 {
		t.Fatalf("stop commands = %+v, want exactly one", stopCommands)
	}
	if strings.Join(stopCommands[0].args, " ") != "stop ongrid-edge" {
		t.Fatalf("stop args = %v, want [stop ongrid-edge]", stopCommands[0].args)
	}
	if placedAtStop {
		t.Fatal("supervisor binary was placed before the existing service was stopped")
	}
	if _, err := os.Stat(supervisorPlaced); err != nil {
		t.Fatalf("supervisor binary missing after install: %v", err)
	}
}

func TestStopExistingServiceToleratesNotInstalled(t *testing.T) {
	runner := &fakeRunner{run: func(name string, args []string) error {
		if name == testSystem32+`\sc.exe` && len(args) > 0 && args[0] == "stop" {
			return &commandError{stderr: "[SC] OpenService FAILED 1060: The specified service does not exist as an installed service.", err: errors.New("exit status 1")}
		}
		return nil
	}}
	if err := stopExistingService(runner); err != nil {
		t.Fatalf("stopExistingService() error = %v, want nil for missing service", err)
	}
}

func TestStopExistingServiceToleratesNotRunning(t *testing.T) {
	runner := &fakeRunner{run: func(string, []string) error {
		return &commandError{stderr: "[SC] ControlService FAILED 1062: The service has not been started.", err: errors.New("exit status 1")}
	}}
	if err := stopExistingService(runner); err != nil {
		t.Fatalf("stopExistingService() error = %v, want nil for stopped service", err)
	}
}

func TestInstallRequiresSupervisorArtifact(t *testing.T) {
	files := map[string][]byte{"ongrid-edge-worker.exe": []byte("worker")}
	dests := map[string]string{"ongrid-edge-worker.exe": "bin"}
	fixture := newInstallFixture(t, files, dests)
	paths := testDeployPaths(t)

	deps := installDeps{
		paths:          paths,
		runner:         &fakeRunner{},
		secureDir:      func(string) error { return nil },
		installService: func(string, string) error { return nil },
		client:         fixture.server.Client(),
		hostInfo:       func() (HostInfo, error) { return fixedHostInfo(), nil },
		osVersion:      func() (OSVersion, error) { return OSVersion{Major: 10, Build: 17763}, nil },
		fetchManifest:  fetchManifest,
		now:            time.Now,
		sleep:          func(time.Duration) {},
		readyTimeout:   time.Second,
		pollInterval:   time.Millisecond,
	}
	opts := Options{
		ManagerURL:     fixture.server.URL,
		AccessKey:      "ak",
		SecretKey:      "sk",
		ServerEdgeAddr: "edge.example.com:40012",
		Variant:        "auto",
	}
	err := Install(context.Background(), opts, deps)
	if err == nil {
		t.Fatal("Install() error = nil, want missing supervisor error")
	}
}

// enrollmentFixture returns a 201 enrollment payload.
func enrollmentServer(t *testing.T, body string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestResolveCredentialsRejectsZeroEdgeID(t *testing.T) {
	server := enrollmentServer(t, `{"edge_id":0,"access_key":"ak","secret_key":"sk","cloud_addr":"edge:40012"}`)
	opts := Options{
		ManagerURL:      server.URL,
		EnrollmentToken: "token",
		ServerEdgeAddr:  "edge.example.com:40012",
	}
	_, err := resolveCredentials(context.Background(), server.Client(), opts,
		func() (HostInfo, error) { return fixedHostInfo(), nil }, "v1")
	if err == nil || !strings.Contains(err.Error(), "edge_id") {
		t.Fatalf("error = %v, want zero edge_id rejection", err)
	}
}

func TestResolveCredentialsValidEnrollment(t *testing.T) {
	server := enrollmentServer(t, `{"edge_id":42,"access_key":"ak_enroll","secret_key":"sk_enroll","cloud_addr":"edge.example.com:40012"}`)
	opts := Options{
		ManagerURL:      server.URL,
		EnrollmentToken: "token",
		ServerEdgeAddr:  "fallback.example.com:40012",
	}
	cred, err := resolveCredentials(context.Background(), server.Client(), opts,
		func() (HostInfo, error) { return fixedHostInfo(), nil }, "v1")
	if err != nil {
		t.Fatalf("resolveCredentials() error: %v", err)
	}
	if cred.EdgeID != 42 || cred.AccessKey != "ak_enroll" || cred.SecretKey != "sk_enroll" {
		t.Fatalf("credentials = %+v", cred)
	}
	if cred.CloudAddr != "edge.example.com:40012" {
		t.Fatalf("cloud addr = %q, want enrollment value", cred.CloudAddr)
	}
}

func TestResolveCredentialsCloudAddrFallback(t *testing.T) {
	cases := []struct {
		name      string
		cloudAddr string
		fallback  string
		want      string
		wantErr   bool
	}{
		{name: "empty falls back", cloudAddr: "", fallback: "fallback.example.com:40012", want: "fallback.example.com:40012"},
		{name: "malformed falls back", cloudAddr: "not-an-address", fallback: "fallback.example.com:40012", want: "fallback.example.com:40012"},
		{name: "missing port falls back", cloudAddr: "edge.example.com", fallback: "fallback.example.com:40012", want: "fallback.example.com:40012"},
		{name: "valid enrollment wins", cloudAddr: "edge.example.com:40012", fallback: "fallback.example.com:40012", want: "edge.example.com:40012"},
		{name: "both invalid", cloudAddr: "bad", fallback: "also-bad", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeCloudAddr(tc.cloudAddr, tc.fallback)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("normalizeCloudAddr(%q, %q) error = nil, want error", tc.cloudAddr, tc.fallback)
				}
				return
			}
			if err != nil {
				t.Fatalf("normalizeCloudAddr() error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("normalizeCloudAddr() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestResolveCredentialsUsesCLICredentialsWithoutEnrollment(t *testing.T) {
	opts := Options{
		AccessKey:      "ak_cli",
		SecretKey:      "sk_cli",
		ServerEdgeAddr: "edge.example.com:40012",
	}
	cred, err := resolveCredentials(context.Background(), nil, opts, nil, "v1")
	if err != nil {
		t.Fatalf("resolveCredentials() error: %v", err)
	}
	if cred.AccessKey != "ak_cli" || cred.SecretKey != "sk_cli" || cred.CloudAddr != opts.ServerEdgeAddr {
		t.Fatalf("credentials = %+v", cred)
	}
}

func TestUninstallPreservesDataAndBinariesByDefault(t *testing.T) {
	paths := testDeployPaths(t)
	for _, dir := range []string{paths.BinDir, paths.DataDir, paths.PluginBinDir, paths.PluginWorkDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(paths.BinDir, "ongrid-edge-supervisor.exe"), []byte("bin"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.SecretsFile, []byte("encrypted"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(paths.DataDir, "supervisor.log"), []byte("log"), 0644); err != nil {
		t.Fatal(err)
	}

	called := false
	deps := uninstallDeps{
		paths:            paths,
		uninstallService: func() error { called = true; return nil },
	}
	if err := Uninstall(deps, false); err != nil {
		t.Fatalf("Uninstall() error: %v", err)
	}
	if !called {
		t.Fatal("service uninstall was not invoked")
	}
	if _, err := os.Stat(paths.SecretsFile); !os.IsNotExist(err) {
		t.Fatalf("secrets.enc was not removed: %v", err)
	}
	for _, path := range []string{
		filepath.Join(paths.BinDir, "ongrid-edge-supervisor.exe"),
		filepath.Join(paths.DataDir, "supervisor.log"),
	} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("default uninstall must preserve %s: %v", path, err)
		}
	}
}

func TestUninstallPurgeRemovesInstallerArtifactsAndData(t *testing.T) {
	paths := testDeployPaths(t)
	for _, dir := range []string{paths.BinDir, paths.DataDir, paths.PluginBinDir, paths.PluginWorkDir, paths.EtcDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(paths.BinDir, "ongrid-edge-supervisor.exe"), []byte("bin"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(paths.PluginBinDir, "windows_exporter.exe"), []byte("plugin"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.SecretsFile, []byte("encrypted"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(paths.DataDir, "supervisor.log"), []byte("log"), 0644); err != nil {
		t.Fatal(err)
	}

	deps := uninstallDeps{
		paths:            paths,
		uninstallService: func() error { return nil },
	}
	if err := Uninstall(deps, true); err != nil {
		t.Fatalf("Uninstall(purge) error: %v", err)
	}
	for _, path := range []string{paths.BinDir, paths.PluginBinDir, paths.EtcDir, paths.DataDir} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("purge must remove %s", path)
		}
	}
}

func TestNewInstallerHTTPClientAppliesTLSOptions(t *testing.T) {
	client, err := newInstallerHTTPClient(Options{
		TLSInsecure:   true,
		TLSServerName: "manager.internal",
	})
	if err != nil {
		t.Fatalf("newInstallerHTTPClient() error: %v", err)
	}
	if client.Timeout <= 0 {
		t.Fatalf("timeout = %v, want positive", client.Timeout)
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport = %T, want *http.Transport", client.Transport)
	}
	if transport.TLSClientConfig == nil || !transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("TLSInsecure was not applied")
	}
	if transport.TLSClientConfig.ServerName != "manager.internal" {
		t.Fatalf("ServerName = %q", transport.TLSClientConfig.ServerName)
	}
}

func TestNewInstallerHTTPClientRejectsInvalidCA(t *testing.T) {
	caFile := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(caFile, []byte("not a certificate"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := newInstallerHTTPClient(Options{TLSCAFile: caFile}); err == nil {
		t.Fatal("newInstallerHTTPClient() error = nil, want invalid CA error")
	}
}

func TestUninstallPropagatesServiceFailure(t *testing.T) {
	paths := testDeployPaths(t)
	deps := uninstallDeps{
		paths:            paths,
		uninstallService: func() error { return errors.New("service failure") },
	}
	if err := Uninstall(deps, false); err == nil {
		t.Fatal("Uninstall() error = nil, want service failure")
	}
}

func TestInstalledName(t *testing.T) {
	tests := []struct {
		name string
		file File
		want string
	}{
		{
			name: "defaults to the path basename",
			file: File{Path: "plugins/windows_exporter.exe"},
			want: "windows_exporter.exe",
		},
		{
			name: "install_as wins over the flat distribution name",
			file: File{
				Path:      "ongrid-edge-supervisor-windows-amd64.exe",
				InstallAs: "ongrid-edge-supervisor.exe",
			},
			want: "ongrid-edge-supervisor.exe",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := installedName(tt.file); got != tt.want {
				t.Fatalf("installedName() = %q, want %q", got, tt.want)
			}
		})
	}
}
