//go:build linux

package host_files

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestDefaultSandbox_DenylistShape pins the default denylist (revised
// 2026-05-08: read defaults to allow-everything-except-denylist instead
// of an explicit allow-list).
func TestDefaultSandbox_DenylistShape(t *testing.T) {
	sb := DefaultSandboxConfig()
	mustDeny := []string{"/proc", "/sys", "/dev", "/run", "/etc/shadow", "/etc/sudoers"}
	denied := map[string]bool{}
	for _, d := range sb.DeniedReadPaths {
		denied[d] = true
	}
	for _, d := range mustDeny {
		if !denied[d] {
			t.Errorf("DeniedReadPaths missing %q (have %v)", d, sb.DeniedReadPaths)
		}
	}
	if len(sb.AllowedReadPaths) != 0 {
		t.Errorf("AllowedReadPaths default should be empty (denylist alone), got %v", sb.AllowedReadPaths)
	}
}

// TestValidatePath_RejectsDeniedPaths pins that read-by-default still
// blocks virtual filesystems (/proc /sys /dev /run) and the small set
// of high-sensitivity files (/etc/shadow, /root/.ssh, /home/*/.gnupg).
func TestValidatePath_RejectsDeniedPaths(t *testing.T) {
	sb := DefaultSandboxConfig()
	mustReject := []string{
		"/proc/1/maps",
		"/sys/class/net",
		"/dev/sda",
		"/run/secrets",
		"/etc/shadow",
		"/etc/sudoers",
		"/etc/sudoers.d/01-ops",
		"/root/.ssh/id_rsa",
		"/root/.gnupg/private-keys-v1.d",
		"/home/alice/.ssh/known_hosts",
		"/home/bob/.gnupg/secring.gpg",
	}
	for _, bad := range mustReject {
		if err := sb.ValidatePath(bad); err == nil {
			t.Errorf("ValidatePath(%q) = nil, want rejection", bad)
		}
	}
}

// TestValidatePath_AcceptsRootAndCommonReads pins the new "default open"
// behaviour: read-only operations on / and most system paths must pass
// (du / on a dev box is a legit diagnostic).
func TestValidatePath_AcceptsRootAndCommonReads(t *testing.T) {
	sb := DefaultSandboxConfig()
	mustAccept := []string{
		"/",
		"/etc/hostname",
		"/etc/os-release",
		"/etc/nginx/nginx.conf",
		"/var",
		"/var/log",
		"/tmp/foo/bar",
		"/opt/app",
		"/usr/bin",
		"/usr/lib/x86_64-linux-gnu",
		"/home/alice/Documents",
		"/data",
		"/srv",
	}
	for _, ok := range mustAccept {
		if err := sb.ValidatePath(ok); err != nil {
			t.Errorf("ValidatePath(%q) = %v, want nil", ok, err)
		}
	}
}

func TestValidatePath_RejectsRelative(t *testing.T) {
	sb := DefaultSandboxConfig()
	for _, bad := range []string{"", "../etc/passwd", "var/log", "."} {
		if err := sb.ValidatePath(bad); err == nil {
			t.Errorf("ValidatePath(%q) = nil, want rejection", bad)
		}
	}
}

func TestValidatePath_TraversalToDenied(t *testing.T) {
	sb := DefaultSandboxConfig()
	// /var/../proc cleans to /proc which IS denied.
	if err := sb.ValidatePath("/var/../proc/1/maps"); err == nil {
		t.Errorf("ValidatePath traversal-to-/proc not rejected")
	}
}

func TestValidatePath_OptionalAllowList(t *testing.T) {
	// When operator additionally sets AllowedReadPaths, the path must
	// match in addition to passing the denylist.
	sb := &SandboxConfig{
		DeniedReadPaths:  DefaultDeniedReadPaths,
		AllowedReadPaths: []string{"/var", "/data"},
	}
	if err := sb.ValidatePath("/var/log/syslog"); err != nil {
		t.Errorf("ValidatePath /var/log/syslog rejected with explicit /var allow: %v", err)
	}
	if err := sb.ValidatePath("/etc/hostname"); err == nil {
		t.Errorf("ValidatePath /etc/hostname accepted but operator allow-list excludes it")
	}
}

func TestValidatePath_RejectsAdjacentPrefix(t *testing.T) {
	// /var must not authorise /var-evil — prefix-match must require a
	// path separator, not a substring match.
	sb := &SandboxConfig{
		DeniedReadPaths:  DefaultDeniedReadPaths,
		AllowedReadPaths: []string{"/var"},
	}
	if err := sb.ValidatePath("/var-evil/secret"); err == nil {
		t.Errorf("ValidatePath /var-evil/* not rejected against /var allow-list")
	}
}

func TestValidatePath_SymlinkToDenied(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks unreliable on windows")
	}
	// Cross-platform: deny a real, existing directory we control so
	// EvalSymlinks succeeds on the link target. (macOS has no /proc, so
	// we can't reuse the default denylist literally.)
	tmp := t.TempDir()
	forbidden := filepath.Join(tmp, "forbidden")
	if err := os.MkdirAll(forbidden, 0o755); err != nil {
		t.Fatalf("mkdir forbidden: %v", err)
	}
	canonForbidden, err := filepath.EvalSymlinks(forbidden)
	if err != nil {
		canonForbidden = forbidden
	}
	link := filepath.Join(tmp, "escape")
	if err := os.Symlink(forbidden, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	sb := &SandboxConfig{DeniedReadPaths: []string{canonForbidden}}
	if err := sb.ValidatePath(link); err == nil {
		t.Errorf("ValidatePath followed symlink-to-denied without rejecting")
	}
}

func TestResolveBinary(t *testing.T) {
	sb := &SandboxConfig{AllowedBinaries: map[string]string{
		"find": "/usr/bin/find",
	}}
	abs, err := sb.ResolveBinary("find")
	if err != nil || abs != "/usr/bin/find" {
		t.Errorf("ResolveBinary(find) = (%q, %v), want (/usr/bin/find, nil)", abs, err)
	}
	if _, err := sb.ResolveBinary("rm"); err == nil {
		t.Errorf("ResolveBinary(rm) returned nil error for non-allowed binary")
	}
	var nilSB *SandboxConfig
	if _, err := nilSB.ResolveBinary("find"); err == nil {
		t.Errorf("ResolveBinary on nil sandbox returned nil error")
	}
}

func TestValidate_RequiresPaths(t *testing.T) {
	sb := &SandboxConfig{}
	if err := sb.Validate(); err == nil {
		t.Errorf("Validate on empty sandbox returned nil")
	}
}

func TestValidate_RequiresBinaries(t *testing.T) {
	sb := &SandboxConfig{
		AllowedReadPaths: []string{"/var"},
		AllowedBinaries:  map[string]string{}, // missing find + du
	}
	err := sb.Validate()
	if err == nil {
		t.Fatalf("Validate with no binaries returned nil")
	}
	if !strings.Contains(err.Error(), "find") && !strings.Contains(err.Error(), "du") {
		t.Errorf("Validate error %q should mention find or du", err.Error())
	}
}

func TestValidate_OK(t *testing.T) {
	sb := &SandboxConfig{
		AllowedReadPaths: []string{"/var"},
		AllowedBinaries: map[string]string{
			"find": "/usr/bin/find",
			"du":   "/usr/bin/du",
		},
	}
	if err := sb.Validate(); err != nil {
		t.Errorf("Validate = %v, want nil", err)
	}
}

// TestValidatePath_WindowsDeniedPaths pins the Windows deny list. The
// cases run on Linux through the explicit Windows path semantics so the
// policy is covered on every CI host, not only on Windows runners.
func TestValidatePath_WindowsDeniedPaths(t *testing.T) {
	sb := DefaultSandboxConfig()
	ps := windowsPathSemantics()
	mustReject := []string{
		`C:\Users\alice\.ssh\id_rsa`,
		`C:\Users\alice\.gnupg\private-keys-v1.d`,
		`C:\Windows\System32\config\SAM`,
		`C:\Windows\System32\SAM`,
		`C:\Windows\System32\SECURITY`,
		`C:\Windows\System32\SYSTEM`,
		`C:\Windows\repair\SAM`,
		`C:\ProgramData\ssh\sshd_config`,
		`C:\ProgramData\Microsoft\Crypto\RSA\machinekeys`,
	}
	for _, bad := range mustReject {
		if err := sb.validatePathWith(ps, bad); err == nil {
			t.Errorf("ValidatePath(%q) = nil, want rejection", bad)
		}
	}
}

// TestValidatePath_WindowsCaseInsensitive pins that Windows prefix
// matching ignores case: differing letter case must not bypass a deny
// prefix (C:\Windows vs c:\windows, USERS vs users, ALICE vs alice).
func TestValidatePath_WindowsCaseInsensitive(t *testing.T) {
	sb := DefaultSandboxConfig()
	ps := windowsPathSemantics()
	mustReject := []string{
		`c:\users\ALICE\.ssh\id_rsa`,
		`c:\windows\system32\CONFIG\SAM`,
		`C:\PROGRAMDATA\SSH\sshd_config`,
		`c:\users\Alice\.GNUPG\secring.gpg`,
	}
	for _, bad := range mustReject {
		if err := sb.validatePathWith(ps, bad); err == nil {
			t.Errorf("ValidatePath(%q) = nil, want case-insensitive rejection", bad)
		}
	}
}

// TestValidatePath_WindowsAllowsBenignPaths pins that ordinary user
// documents still pass — the deny list must not over-block.
func TestValidatePath_WindowsAllowsBenignPaths(t *testing.T) {
	sb := DefaultSandboxConfig()
	ps := windowsPathSemantics()
	mustAccept := []string{
		`C:\Users\alice\Documents\notes.txt`,
		`C:\Users\alice\AppData\Local\Temp\log.txt`,
		`D:\data\exports\report.csv`,
		`C:\Windows\System32\drivers\etc\hosts`,
	}
	for _, ok := range mustAccept {
		if err := sb.validatePathWith(ps, ok); err != nil {
			t.Errorf("ValidatePath(%q) = %v, want nil", ok, err)
		}
	}
}

// TestValidatePath_WindowsAllowedReadPathsOverride verifies that an
// operator AllowedReadPaths entry does not weaken the denylist: a path
// under both lists is still denied.
func TestValidatePath_WindowsAllowedReadPathsOverride(t *testing.T) {
	sb := &SandboxConfig{
		DeniedReadPaths:  append([]string(nil), DefaultDeniedReadPaths...),
		AllowedReadPaths: []string{`C:\Users\alice`},
	}
	ps := windowsPathSemantics()
	if err := sb.validatePathWith(ps, `C:\Users\alice\Documents\notes.txt`); err != nil {
		t.Errorf("ValidatePath benign under allow-list = %v, want nil", err)
	}
	if err := sb.validatePathWith(ps, `C:\Users\alice\.ssh\id_rsa`); err == nil {
		t.Errorf("ValidatePath secret under allow-list = nil, want rejection (denylist must win)")
	}
}

// TestValidatePath_UnixCaseSensitive pins that Unix matching stays
// byte-exact: /etc/SHADOW is not covered by the /etc/shadow prefix.
func TestValidatePath_UnixCaseSensitive(t *testing.T) {
	sb := DefaultSandboxConfig()
	if err := sb.ValidatePath("/etc/SHADOW"); err != nil {
		t.Errorf("ValidatePath(/etc/SHADOW) = %v, want nil (Unix matching is case-sensitive)", err)
	}
}

func TestDiscoverBinaries(t *testing.T) {
	// `ls` is universal — every Linux/Darwin host has it. discoverBinaries
	// must find it via either LookPath or the fallback table.
	got := discoverBinaries([]string{"ls"})
	abs, ok := got["ls"]
	if !ok {
		t.Fatalf("discoverBinaries did not find ls; got map=%v", got)
	}
	if !filepath.IsAbs(abs) {
		t.Errorf("discoverBinaries returned non-absolute %q for ls", abs)
	}
}
