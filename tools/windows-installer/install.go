package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// The installer manages one Windows service; the name is shared with the
// supervisor and the Manager enrollment contract.
const (
	serviceName          = "ongrid-edge"
	supervisorBinaryName = "ongrid-edge-supervisor.exe"
	workerBinaryName     = "ongrid-edge-worker.exe"
)

const (
	// defaultReadyTimeout bounds how long the installer waits for the service
	// to report SCM state and write a fresh health.json after installation.
	defaultReadyTimeout = 2 * time.Minute
	// defaultPollInterval is the pause between readiness probes.
	defaultPollInterval = 2 * time.Second
	// manifestBodyLimit bounds the manifest response. Manifests are a few KiB.
	manifestBodyLimit = 4 << 20
)

// ErrUnsupportedPlatform is returned by the platform-gated ACL and service
// helpers when the installer is built for a non-Windows host.
var ErrUnsupportedPlatform = errors.New("windows installer: unsupported platform (Windows only)")

// systemToolFn resolves privileged Windows executables. The installer is
// normally launched elevated from %TEMP%, so a bare "icacls" or "sc.exe" could
// be satisfied by a planted file in the working directory. Resolving under
// %SystemRoot%\System32 prevents that PATH/current-directory hijack. It is a
// package variable so tests can inject deterministic paths.
var systemToolFn = resolveSystemTool

// resolveSystemTool returns the absolute path of a system executable.
func resolveSystemTool(name string) (string, error) {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = os.Getenv("windir")
	}
	if root == "" {
		return "", fmt.Errorf("resolve %s: SystemRoot is not set", name)
	}
	path := filepath.Join(root, "System32", name)
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("resolve %s: %w", name, err)
	}
	return path, nil
}

// Runner executes one external command. Installer tests substitute a fake so
// no real ACL or Windows service change happens on the test host.
type Runner interface {
	Run(name string, args ...string) error
}

// commandError carries the command's stderr so callers can propagate the
// Windows service error text (including "service does not exist" on uninstall).
type commandError struct {
	name   string
	args   []string
	stderr string
	err    error
}

func (e *commandError) Error() string {
	command := e.name
	if len(e.args) > 0 {
		command += " " + strings.Join(e.args, " ")
	}
	if e.stderr != "" {
		return fmt.Sprintf("%s: %v: %s", command, e.err, e.stderr)
	}
	return fmt.Sprintf("%s: %v", command, e.err)
}

func (e *commandError) Unwrap() error { return e.err }

// execRunner is the production Runner. stderr receives a copy of the failed
// command output for the installer log; secrets are never passed on argv.
type execRunner struct {
	stderr io.Writer
}

func (r execRunner) Run(name string, args ...string) error {
	command := exec.Command(name, args...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		runErr := &commandError{
			name:   name,
			args:   append([]string(nil), args...),
			stderr: strings.TrimSpace(stderr.String()),
			err:    err,
		}
		if r.stderr != nil {
			fmt.Fprintf(r.stderr, "ongrid-edge-installer: %s\n", runErr.Error())
		}
		return runErr
	}
	return nil
}

// deployPaths describes every location the installer writes. It is a struct
// (not constants) so tests can point the orchestration at a temp directory.
type deployPaths struct {
	InstallRoot   string
	BinDir        string
	PluginBinDir  string
	EtcDir        string
	DataDir       string
	PluginWorkDir string
	StageDir      string
	HealthFile    string
	SecretsFile   string
}

// defaultDeployPaths returns the Windows production layout. The bin/plugin
// directories live under Program Files, data and health under ProgramData, and
// they match internal/edgeagent/edgedirs.
func defaultDeployPaths() deployPaths {
	installRoot := `C:\Program Files\ongrid-edge`
	dataDir := `C:\ProgramData\ongrid-edge`
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

func (p deployPaths) supervisorPath() string {
	return filepath.Join(p.BinDir, supervisorBinaryName)
}

// ensureDirs creates the install roots before any file is placed or secured.
func (p deployPaths) ensureDirs() error {
	for _, dir := range []string{
		p.InstallRoot,
		p.BinDir,
		p.PluginBinDir,
		p.EtcDir,
		p.DataDir,
		p.PluginWorkDir,
		p.StageDir,
	} {
		if dir == "" {
			continue
		}
		if err := os.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("create directory %s: %w", dir, err)
		}
	}
	return nil
}

// secureDirArgs builds the icacls argument list. Inheritance is removed and
// only SYSTEM (S-1-5-18) and Administrators (S-1-5-32-544) receive full
// control, including files created later.
func secureDirArgs(path string) []string {
	return []string{
		path,
		"/inheritance:r",
		"/grant:r",
		"*S-1-5-18:(OI)(CI)(F)",
		"*S-1-5-32-544:(OI)(CI)(F)",
	}
}

func runSecureDir(runner Runner, path string) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("secure dir: path is empty")
	}
	icacls, err := systemToolFn("icacls.exe")
	if err != nil {
		return fmt.Errorf("secure %s: %w", path, err)
	}
	if err := runner.Run(icacls, secureDirArgs(path)...); err != nil {
		return fmt.Errorf("secure %s: %w", path, err)
	}
	return nil
}

// installService hands installation to the placed supervisor. The supervisor
// owns DPAPI secret storage, sc.exe create, recovery actions, and sc start; the
// installer must not duplicate that logic. The secret is in the config file,
// never on this command line.
func installService(runner Runner, supervisorPath, configPath string) error {
	if strings.TrimSpace(supervisorPath) == "" {
		return errors.New("install service: supervisor path is empty")
	}
	if strings.TrimSpace(configPath) == "" {
		return errors.New("install service: config path is empty")
	}
	if err := runner.Run(supervisorPath, "--install", "--config-file", configPath); err != nil {
		return fmt.Errorf("install service: %w", err)
	}
	return nil
}

// uninstallService stops and deletes the service through the installed
// supervisor. A service that was never installed is treated as success so
// uninstall stays idempotent.
func uninstallService(runner Runner, supervisorPath string) error {
	if strings.TrimSpace(supervisorPath) == "" {
		return errors.New("uninstall service: supervisor path is empty")
	}
	// A host where the installer never ran has no supervisor binary. That is
	// already the desired end state, so let the caller continue with secret
	// removal (and purge) instead of failing.
	if _, err := os.Stat(supervisorPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("uninstall service: stat supervisor: %w", err)
	}
	if err := runner.Run(supervisorPath, "--uninstall"); err != nil {
		if isServiceNotInstalled(err) || errors.Is(err, exec.ErrNotFound) {
			return nil
		}
		return fmt.Errorf("uninstall service: %w", err)
	}
	return nil
}

// stopExistingService stops a running service before binaries are replaced.
// A missing service or an already-stopped service is success: both mean no
// process holds the binary locks we are about to replace.
func stopExistingService(runner Runner) error {
	sc, err := systemToolFn("sc.exe")
	if err != nil {
		return err
	}
	if err := runner.Run(sc, "stop", serviceName); err != nil {
		if isServiceNotInstalled(err) || isServiceNotRunning(err) {
			return nil
		}
		return fmt.Errorf("stop existing %s service: %w", serviceName, err)
	}
	return nil
}

func isServiceNotInstalled(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "1060") ||
		strings.Contains(text, "does not exist as an installed service") ||
		strings.Contains(text, "service does not exist")
}

func isServiceNotRunning(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "1062") ||
		strings.Contains(text, "not active") ||
		strings.Contains(text, "has not been started")
}

// downloadArtifact downloads one manifest file, verifies its SHA-256, and
// removes it again on mismatch so an untrusted artifact is never placed.
func downloadArtifact(ctx context.Context, client *http.Client, rawURL, dest, expectedSHA256 string) error {
	if err := DownloadFile(ctx, client, rawURL, dest); err != nil {
		return err
	}
	if err := VerifySHA256(dest, expectedSHA256); err != nil {
		if removeErr := os.Remove(dest); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return fmt.Errorf("%w (also failed to remove the rejected artifact: %v)", err, removeErr)
		}
		return err
	}
	return nil
}

// supervisorConfig is the JSON document handed to
// supervisor.exe --install --config-file. The secret is read from this file so
// it never appears in argv.
type supervisorConfig struct {
	CloudAddr        string `json:"cloud_addr"`
	AccessKey        string `json:"access_key"`
	SecretKey        string `json:"secret_key"`
	CollectorMode    string `json:"collector_mode"`
	PluginBinDir     string `json:"plugin_bin_dir"`
	PluginWorkDir    string `json:"plugin_work_dir"`
	TLSCAFile        string `json:"tls_ca_file"`
	TLSServerName    string `json:"tls_server_name"`
	ScrapeConfigFile string `json:"scrape_config_file"`
}

// deviceCredential is the per-device identity used for one installation.
type deviceCredential struct {
	EdgeID    uint64
	AccessKey string
	SecretKey string
	CloudAddr string
}

// resolveCredentials applies either the batch enrollment result or the
// single-device CLI credentials. Enrollment requires a real edge id and falls
// back to --server-edge-addr when the Manager response has no usable address.
func resolveCredentials(
	ctx context.Context,
	client *http.Client,
	opts Options,
	hostInfo func() (HostInfo, error),
	agentVersion string,
) (deviceCredential, error) {
	if strings.TrimSpace(opts.EnrollmentToken) == "" {
		if opts.AccessKey == "" || opts.SecretKey == "" {
			return deviceCredential{}, errors.New("install: access_key and secret_key are required")
		}
		if err := validateServerEdgeAddr(opts.ServerEdgeAddr); err != nil {
			return deviceCredential{}, err
		}
		return deviceCredential{
			AccessKey: opts.AccessKey,
			SecretKey: opts.SecretKey,
			CloudAddr: opts.ServerEdgeAddr,
		}, nil
	}

	if hostInfo == nil {
		return deviceCredential{}, errors.New("install: host info is required for enrollment")
	}
	host, err := hostInfo()
	if err != nil {
		return deviceCredential{}, fmt.Errorf("collect host info: %w", err)
	}
	creds, err := Enroll(ctx, client, opts.ManagerURL, opts.EnrollmentToken, host, agentVersion)
	if err != nil {
		return deviceCredential{}, err
	}
	if creds.EdgeID == 0 {
		return deviceCredential{}, errors.New("install: enrollment response has edge_id 0")
	}
	cloudAddr, err := normalizeCloudAddr(creds.CloudAddr, opts.ServerEdgeAddr)
	if err != nil {
		return deviceCredential{}, err
	}
	return deviceCredential{
		EdgeID:    creds.EdgeID,
		AccessKey: creds.AccessKey,
		SecretKey: creds.SecretKey,
		CloudAddr: cloudAddr,
	}, nil
}

// normalizeCloudAddr prefers the Manager-provided address and falls back to
// the operator-supplied --server-edge-addr when the response is empty or
// malformed. The result is always a valid host:port pair.
func normalizeCloudAddr(candidate, fallback string) (string, error) {
	candidate = strings.TrimSpace(candidate)
	if candidate != "" && validateServerEdgeAddr(candidate) == nil {
		return candidate, nil
	}
	fallback = strings.TrimSpace(fallback)
	if fallback == "" {
		return "", fmt.Errorf("install: enrollment cloud_addr %q is invalid and no --server-edge-addr fallback was provided", candidate)
	}
	if err := validateServerEdgeAddr(fallback); err != nil {
		return "", fmt.Errorf("install: enrollment cloud_addr %q is invalid and --server-edge-addr %q is invalid: %w", candidate, fallback, err)
	}
	return fallback, nil
}

// managerAssetURL joins a Manager root (with an optional path prefix) and one
// installer asset path. Plaintext HTTP is accepted only for loopback hosts.
func managerAssetURL(managerURL string, parts ...string) (string, error) {
	raw := strings.TrimRight(strings.TrimSpace(managerURL), "/")
	if raw == "" {
		return "", errors.New("install: manager URL is required")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("install: invalid manager URL")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", fmt.Errorf("install: unsupported manager URL scheme %q", scheme)
	}
	if scheme == "http" && !isLoopbackHost(parsed.Hostname()) {
		return "", errors.New("install: http is only allowed for loopback manager hosts")
	}
	segments := append([]string{"edge", "windows"}, parts...)
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/" + strings.Join(segments, "/")
	parsed.RawPath = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

// fetchManifest downloads and validates /edge/windows/manifest.json.
func fetchManifest(ctx context.Context, client *http.Client, managerURL string) (*Manifest, error) {
	manifestURL, err := managerAssetURL(managerURL, "manifest.json")
	if err != nil {
		return nil, err
	}
	if client == nil {
		client = newDownloadClient()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, manifestURL, nil)
	if err != nil {
		return nil, fmt.Errorf("fetch manifest: build request: %w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("fetch manifest: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, downloadErrorBodyLimit))
		detail := strings.TrimSpace(string(body))
		if detail != "" {
			return nil, fmt.Errorf("fetch manifest: HTTP %d: %s", response.StatusCode, detail)
		}
		return nil, fmt.Errorf("fetch manifest: HTTP %d", response.StatusCode)
	}

	data, err := io.ReadAll(io.LimitReader(response.Body, manifestBodyLimit))
	if err != nil {
		return nil, fmt.Errorf("fetch manifest: read body: %w", err)
	}
	return ParseManifest(data)
}

// writeSupervisorConfig writes the install JSON into the already-secured data
// directory. The file inherits the restricted directory ACL and is removed as
// soon as the supervisor returns.
func writeSupervisorConfig(directory string, config supervisorConfig) (string, error) {
	data, err := json.Marshal(config)
	if err != nil {
		return "", fmt.Errorf("encode supervisor config: %w", err)
	}
	file, err := os.CreateTemp(directory, "install-*.json")
	if err != nil {
		return "", fmt.Errorf("create supervisor config: %w", err)
	}
	name := file.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(name)
		}
	}()

	if err := file.Chmod(0600); err != nil {
		_ = file.Close()
		return "", fmt.Errorf("restrict supervisor config: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return "", fmt.Errorf("write supervisor config: %w", err)
	}
	if err := file.Close(); err != nil {
		return "", fmt.Errorf("close supervisor config: %w", err)
	}
	cleanup = false
	return name, nil
}

// destDirFor maps a manifest destination to the install tree.
func destDirFor(paths deployPaths, dest string) (string, error) {
	switch dest {
	case "bin":
		return paths.BinDir, nil
	case "plugins":
		return paths.PluginBinDir, nil
	case "etc":
		return paths.EtcDir, nil
	default:
		return "", fmt.Errorf("install: unknown artifact destination %q", dest)
	}
}

// moveFile places src at dst. The destination is removed first because
// Windows os.Rename does not overwrite an existing file. When the rename
// crosses volumes it falls back to a copy.
func moveFile(src, dst string) error {
	if err := os.Remove(dst); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove stale destination %s: %w", dst, err)
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	if err := copyFile(src, dst); err != nil {
		return err
	}
	if err := os.Remove(src); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove staged file %s: %w", src, err)
	}
	return nil
}

func copyFile(src, dst string) error {
	source, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open %s: %w", src, err)
	}
	defer source.Close()

	target, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return fmt.Errorf("create %s: %w", dst, err)
	}
	if _, err := io.Copy(target, source); err != nil {
		_ = target.Close()
		_ = os.Remove(dst)
		return fmt.Errorf("copy to %s: %w", dst, err)
	}
	if err := target.Close(); err != nil {
		_ = os.Remove(dst)
		return fmt.Errorf("close %s: %w", dst, err)
	}
	return nil
}

// pollOptions are the readiness-polling seams.
type pollOptions struct {
	timeout  time.Duration
	interval time.Duration
	now      func() time.Time
	sleep    func(time.Duration)
}

// waitForReady polls sc.exe query and health.json. Both must agree before the
// install is reported as successful, which keeps a stale health file from
// masking a service that failed to start.
func waitForReady(ctx context.Context, runner Runner, healthFile string, opts pollOptions) error {
	if opts.now == nil {
		opts.now = time.Now
	}
	if opts.sleep == nil {
		opts.sleep = time.Sleep
	}
	if opts.interval <= 0 {
		opts.interval = defaultPollInterval
	}
	if opts.timeout <= 0 {
		opts.timeout = defaultReadyTimeout
	}
	sc, err := systemToolFn("sc.exe")
	if err != nil {
		return err
	}
	deadline := opts.now().Add(opts.timeout)

	var lastErr error
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if queryErr := runner.Run(sc, "query", serviceName); queryErr == nil {
			if info, statErr := os.Stat(healthFile); statErr == nil && !info.IsDir() {
				return nil
			} else if statErr != nil {
				lastErr = fmt.Errorf("health file %s is not ready: %w", healthFile, statErr)
			} else {
				lastErr = fmt.Errorf("health path %s is a directory", healthFile)
			}
		} else {
			lastErr = queryErr
		}

		if !opts.now().Before(deadline) {
			if lastErr == nil {
				lastErr = errors.New("no readiness signal")
			}
			return fmt.Errorf("service %s did not become ready within %s: %w", serviceName, opts.timeout, lastErr)
		}
		opts.sleep(opts.interval)
	}
}

// installDeps is the injectable environment of Install. Production uses
// defaultInstallDeps; tests replace the runner, ACL, service, and clock seams.
type installDeps struct {
	paths          deployPaths
	runner         Runner
	secureDir      func(string) error
	installService func(supervisorPath, configPath string) error
	client         *http.Client
	hostInfo       func() (HostInfo, error)
	osVersion      func() (OSVersion, error)
	fetchManifest  func(context.Context, *http.Client, string) (*Manifest, error)
	now            func() time.Time
	sleep          func(time.Duration)
	readyTimeout   time.Duration
	pollInterval   time.Duration
	agentVersion   string
}

// newInstallerHTTPClient builds the client used for manifest, artifact, and
// enrollment requests. The caller's --tls-ca-file / --tls-server-name /
// --tls-insecure options apply here as well as to the supervisor config,
// because the same Manager may be self-signed during testing.
func newInstallerHTTPClient(opts Options) (*http.Client, error) {
	client := newDownloadClient()
	if !opts.TLSInsecure && opts.TLSCAFile == "" && opts.TLSServerName == "" {
		return client, nil
	}

	transport, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return nil, errors.New("install: default HTTP transport has an unexpected type")
	}
	cloned := transport.Clone()
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if opts.TLSInsecure {
		// Self-signed testing only; the flag is explicit on the command line.
		tlsConfig.InsecureSkipVerify = true
	}
	if opts.TLSCAFile != "" {
		pem, err := os.ReadFile(opts.TLSCAFile)
		if err != nil {
			return nil, fmt.Errorf("read TLS CA file: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("parse TLS CA file %s: no certificates found", opts.TLSCAFile)
		}
		tlsConfig.RootCAs = pool
	}
	if opts.TLSServerName != "" {
		tlsConfig.ServerName = opts.TLSServerName
	}
	cloned.TLSClientConfig = tlsConfig
	client.Transport = cloned
	return client, nil
}

func defaultInstallDeps(opts Options) (installDeps, error) {
	client, err := newInstallerHTTPClient(opts)
	if err != nil {
		return installDeps{}, err
	}
	return installDeps{
		paths:          defaultDeployPaths(),
		runner:         execRunner{stderr: os.Stderr},
		secureDir:      SecureDir,
		installService: InstallService,
		client:         client,
		hostInfo:       CollectHostInfo,
		osVersion:      WindowsVersion,
		fetchManifest:  fetchManifest,
		now:            time.Now,
		sleep:          time.Sleep,
		readyTimeout:   defaultReadyTimeout,
		pollInterval:   defaultPollInterval,
		agentVersion:   version,
	}, nil
}

func (d *installDeps) applyDefaults() {
	if d.paths == (deployPaths{}) {
		d.paths = defaultDeployPaths()
	}
	if d.runner == nil {
		d.runner = execRunner{stderr: os.Stderr}
	}
	if d.secureDir == nil {
		d.secureDir = SecureDir
	}
	if d.installService == nil {
		d.installService = InstallService
	}
	if d.client == nil {
		d.client = newDownloadClient()
	}
	if d.hostInfo == nil {
		d.hostInfo = CollectHostInfo
	}
	if d.osVersion == nil {
		d.osVersion = WindowsVersion
	}
	if d.fetchManifest == nil {
		d.fetchManifest = fetchManifest
	}
	if d.now == nil {
		d.now = time.Now
	}
	if d.sleep == nil {
		d.sleep = time.Sleep
	}
	if d.readyTimeout <= 0 {
		d.readyTimeout = defaultReadyTimeout
	}
	if d.pollInterval <= 0 {
		d.pollInterval = defaultPollInterval
	}
}

// Install runs the full installation: secure the destination tree, download
// and verify artifacts into a fresh staging directory, resolve credentials,
// place the binaries, hand the config file to the supervisor, and wait for
// health. Failures preserve the scene; the staging directory is always
// removed and the secret-bearing config file is always deleted.
func Install(ctx context.Context, opts Options, deps installDeps) error {
	deps.applyDefaults()

	if err := deps.paths.ensureDirs(); err != nil {
		return err
	}

	// A fresh staging directory per run avoids stale artifacts and sidesteps
	// Windows os.Rename refusing to overwrite an existing destination.
	stagingDir, err := os.MkdirTemp(deps.paths.DataDir, "download-*")
	if err != nil {
		return fmt.Errorf("create staging directory: %w", err)
	}
	defer os.RemoveAll(stagingDir)

	// Harden every install root and the staging directory before the first
	// byte is downloaded. A user-writable staging tree would defeat SHA-256.
	for _, dir := range []string{
		deps.paths.InstallRoot,
		deps.paths.BinDir,
		deps.paths.PluginBinDir,
		deps.paths.EtcDir,
		deps.paths.DataDir,
		deps.paths.PluginWorkDir,
		deps.paths.StageDir,
		stagingDir,
	} {
		if dir == "" {
			continue
		}
		if err := deps.secureDir(dir); err != nil {
			return fmt.Errorf("secure install directory %s: %w", dir, err)
		}
	}

	manifest, err := deps.fetchManifest(ctx, deps.client, opts.ManagerURL)
	if err != nil {
		return err
	}
	windowsVersion, err := deps.osVersion()
	if err != nil {
		return fmt.Errorf("detect windows version: %w", err)
	}
	variant, err := manifest.SelectVariant(windowsVersion, opts.Variant)
	if err != nil {
		return err
	}
	if len(variant.Files) == 0 {
		return fmt.Errorf("install: variant %q contains no files", variant.ID)
	}

	staged := make(map[string]string, len(variant.Files))
	for _, file := range variant.Files {
		stagedPath := filepath.Join(stagingDir, filepath.FromSlash(file.Path))
		if err := os.MkdirAll(filepath.Dir(stagedPath), 0755); err != nil {
			return fmt.Errorf("create staging path for %s: %w", file.Path, err)
		}
		artifactURL, err := managerAssetURL(opts.ManagerURL, variant.ID, file.Path)
		if err != nil {
			return err
		}
		if err := downloadArtifact(ctx, deps.client, artifactURL, stagedPath, file.SHA256); err != nil {
			return fmt.Errorf("download %s: %w", file.Path, err)
		}
		staged[file.Path] = stagedPath
	}

	credential, err := resolveCredentials(ctx, deps.client, opts, deps.hostInfo, deps.agentVersion)
	if err != nil {
		return err
	}

	// Reinstalls must not fail on locked binaries and must not destroy an
	// existing credential: stop the current service before replacing files,
	// and let the supervisor's Create treat "already exists" as success.
	if err := stopExistingService(deps.runner); err != nil {
		return err
	}

	for _, file := range variant.Files {
		destinationDir, err := destDirFor(deps.paths, file.Dest)
		if err != nil {
			return err
		}
		destination := filepath.Join(destinationDir, filepath.Base(filepath.FromSlash(file.Path)))
		if err := moveFile(staged[file.Path], destination); err != nil {
			return fmt.Errorf("place %s: %w", file.Path, err)
		}
	}

	supervisorPath := deps.paths.supervisorPath()
	if _, err := os.Stat(supervisorPath); err != nil {
		return fmt.Errorf("install: supervisor binary is missing after placement: %w", err)
	}
	workerPath := filepath.Join(deps.paths.BinDir, workerBinaryName)
	if _, err := os.Stat(workerPath); err != nil {
		return fmt.Errorf("install: worker binary is missing after placement: %w", err)
	}

	configPath, err := writeSupervisorConfig(deps.paths.DataDir, supervisorConfig{
		CloudAddr:        credential.CloudAddr,
		AccessKey:        credential.AccessKey,
		SecretKey:        credential.SecretKey,
		CollectorMode:    "off",
		PluginBinDir:     deps.paths.PluginBinDir,
		PluginWorkDir:    deps.paths.PluginWorkDir,
		TLSCAFile:        opts.TLSCAFile,
		TLSServerName:    opts.TLSServerName,
		ScrapeConfigFile: filepath.Join(deps.paths.DataDir, "scrape.yaml"),
	})
	if err != nil {
		return err
	}
	// The supervisor reads the secret during --install; no path may outlive
	// this function, successful or not.
	defer os.Remove(configPath)

	// Remove a stale health file so readiness reflects this install rather
	// than a previous service run.
	if err := os.Remove(deps.paths.HealthFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove stale health file: %w", err)
	}

	if err := deps.installService(supervisorPath, configPath); err != nil {
		return err
	}
	if err := os.Remove(configPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("delete supervisor config: %w", err)
	}

	return waitForReady(ctx, deps.runner, deps.paths.HealthFile, pollOptions{
		timeout:  deps.readyTimeout,
		interval: deps.pollInterval,
		now:      deps.now,
		sleep:    deps.sleep,
	})
}

// uninstallDeps is the injectable environment of Uninstall.
type uninstallDeps struct {
	paths            deployPaths
	uninstallService func() error
}

func defaultUninstallDeps() uninstallDeps {
	return uninstallDeps{
		paths:            defaultDeployPaths(),
		uninstallService: UninstallService,
	}
}

// Uninstall removes the service and the DPAPI secret. Data, logs, and placed
// binaries survive a normal uninstall; --purge removes the installer-owned
// trees as well.
func Uninstall(deps uninstallDeps, purge bool) error {
	if deps.paths == (deployPaths{}) {
		deps.paths = defaultDeployPaths()
	}
	if deps.uninstallService == nil {
		deps.uninstallService = UninstallService
	}

	if err := deps.uninstallService(); err != nil {
		return err
	}
	if deps.paths.SecretsFile != "" {
		if err := os.Remove(deps.paths.SecretsFile); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove secrets file: %w", err)
		}
	}
	if !purge {
		return nil
	}

	for _, dir := range []string{
		deps.paths.BinDir,
		deps.paths.PluginBinDir,
		deps.paths.EtcDir,
		deps.paths.PluginWorkDir,
		deps.paths.StageDir,
		deps.paths.DataDir,
	} {
		if dir == "" {
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			return fmt.Errorf("purge %s: %w", dir, err)
		}
	}
	// Remove the install root only when it is empty.
	_ = os.Remove(deps.paths.InstallRoot)
	return nil
}
