// Package host_files's sandbox.go declares the path / binary allow-list
// gates that wrap the three filesystem-inspection handlers. Real
// kernel-level isolation (seccomp / cgroups / chroot) is out of scope —
// runtime documents the long-term wasmtime/MCP path.
// Until that lands, defense-in-depth here is two-fold:
//
//  1. Path validator: every path arriving from the LLM is canonicalised
//     (filepath.Abs + EvalSymlinks) and required to live under one of
//     AllowedReadPaths. `..` traversal, symlinks pointing outside, and
//     bare relative paths all reject. Empty path also rejects — every
//     handler that accepts a path requires it explicitly.
//
//  2. Binary allow-list: only commands in AllowedBinaries are resolvable.
//     The handler asks the sandbox for
//     a binary by short name; the sandbox returns the absolute path
//     resolved at startup. Anything not in the allow-list errors.
package host_files

import (
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// SandboxConfig defines what the host_files plugin is allowed to access.
// Defaults are defined below and may be overridden at edge boot.
//
// Path policy (revised 2026-05-08): read operations default to "ALLOW
// everything except DeniedReadPaths". The previous allowlist semantics
// (only /data /var /opt /home /tmp /srv) was over-conservative — it
// blocked legitimate diagnostic targets like `du /` (root scan to find
// where disk went) and `find /usr -size +100M`. Read-only by definition
// can't damage the host, so the policy is now denylist-driven:
//
//   - DeniedReadPaths: virtual filesystems that du/find can't usefully
//     traverse anyway (/proc /sys /dev /run) plus a few high-sensitivity
//     leak vectors (/etc/shadow /root/.ssh ...). When the requested path
//     is exactly or under any denied prefix, the call is refused.
//
//   - AllowedReadPaths: kept as an OPTIONAL allowlist. When non-empty
//     the path must additionally match one of these; when empty the
//     denylist is the only constraint. Operators who want stricter
//     containment than the default can still set this.
//
// AllowedBinaries maps short name → resolved absolute path discovered
// via exec.LookPath at construction time.
type SandboxConfig struct {
	// DeniedReadPaths is the canonical absolute prefix denylist applied
	// to every read operation. Empty allows everything on Unix (use only
	// in dev / tests); on Windows the validator always additionally
	// applies WindowsDeniedReadPaths.
	DeniedReadPaths []string

	// AllowedReadPaths is an optional additional allowlist. When
	// non-empty the path must match in addition to passing the denylist.
	// Default is empty (denylist alone).
	AllowedReadPaths []string

	AllowedBinaries map[string]string
}

// DefaultDeniedReadPaths is the conservative baseline: virtual
// filesystems (du / find against these never finishes) + a small set of
// high-sensitivity files that an LLM should never need to read for a
// legitimate diagnostic.
var DefaultDeniedReadPaths = []string{
	// Virtual / pseudo filesystems — du / find traverse forever
	"/proc",
	"/sys",
	"/dev",
	"/run",
	// Hot password / key material
	"/etc/shadow",
	"/etc/gshadow",
	"/etc/sudoers",
	"/etc/sudoers.d",
	// Per-user SSH and GPG private state — globbed at validation time
	// via dynamic prefix match, but listed here for documentation.
	"/root/.ssh",
	"/root/.gnupg",
	// kernel-image / firmware blobs aren't writable but are large and
	// uninteresting; not denied — operators may want to inspect.
}

// WindowsDeniedReadPaths is the Windows-specific deny list. It mirrors
// the Unix baseline's intent — credential stores and key material an
// LLM-driven diagnostic never needs — for the Windows filesystem layout.
// The validator applies it whenever it runs with Windows path semantics
// (runtime.GOOS == "windows"), in addition to any configured
// DeniedReadPaths. Prefix matching on Windows is case-insensitive, so a
// differently-cased path cannot slip past these entries.
//
// Per-user `C:\Users\<user>\.ssh` and `.gnupg` are matched dynamically
// by matchesPerUserSensitiveWindows; the drive-letter entries below are
// the machine-wide locations.
var WindowsDeniedReadPaths = []string{
	// SAM / SECURITY / SYSTEM hives plus the registry transaction logs.
	`C:\Windows\System32\config`,
	`C:\Windows\System32\SAM`,
	`C:\Windows\System32\SECURITY`,
	`C:\Windows\System32\SYSTEM`,
	// Backup copies of the hives created by repair / recovery.
	`C:\Windows\repair`,
	// OpenSSH host keys and sshd configuration.
	`C:\ProgramData\ssh`,
	// Machine-wide CNG / CryptoAPI key containers.
	`C:\ProgramData\Microsoft\Crypto`,
}

// DefaultSandboxConfig allows reads except for DefaultDeniedReadPaths
// (plus WindowsDeniedReadPaths on Windows).
// Binary discovery best-efforts each candidate; missing binaries simply
// do not appear in AllowedBinaries (calls to ResolveBinary then error
// cleanly with a message the LLM can render).
//
// On Windows find_large_files / du_summary use Go-native walkers, so no
// binaries are required (and Windows' find.exe is a different tool that
// must not be allow-listed).
func DefaultSandboxConfig() *SandboxConfig {
	denied := append([]string(nil), DefaultDeniedReadPaths...)
	if runtime.GOOS == "windows" {
		// Surface the platform baseline in the config; matchesDenied also
		// applies it for operator-built configs on Windows.
		denied = append(denied, WindowsDeniedReadPaths...)
	}
	cfg := &SandboxConfig{
		DeniedReadPaths: denied,
		// AllowedReadPaths intentionally empty — denylist alone.
	}
	if runtime.GOOS != "windows" {
		// `df` is added for the coverage hint in du_summary — read-only,
		// no path argument unless we pass one explicitly, fits the same
		// "host triage primitive" envelope as du/find/stat.
		cfg.AllowedBinaries = discoverBinaries([]string{"find", "du", "df", "stat", "ls"})
	}
	return cfg
}

// Validate performs startup-time invariants on the sandbox.
//
// Required:
//   - find + du resolved (stat is Go-native via os.Stat so it is not required)
//
// Windows is exempt: find_large_files / du_summary use the Go-native
// walkers there, and Windows' find.exe/du.exe are absent or unrelated.
//
// AllowedReadPaths can be empty (denylist alone is the policy);
// DeniedReadPaths can be empty in dev / tests but defaults to the
// virtual-fs + sensitive-file baseline (see DefaultDeniedReadPaths).
//
// On failure Register propagates the error to main.go; main.go logs and
// continues without the host_files capability — better to boot the edge
// without the tool than to crash the whole agent.
func (s *SandboxConfig) Validate() error {
	if s == nil {
		return errors.New("host_files sandbox: config is nil")
	}
	if runtime.GOOS == "windows" {
		return nil
	}
	for _, name := range []string{"find", "du"} {
		if _, ok := s.AllowedBinaries[name]; !ok {
			return fmt.Errorf("host_files sandbox: required binary %q not found in PATH or fallback locations", name)
		}
	}
	return nil
}

// ValidatePath returns nil if `path` is under one of the AllowedReadPaths
// after lexical cleaning AND, when the path exists, symlink resolution.
// Empty path → error. Outside allow-list → error. Symlink-to-outside →
// error. The function is canonical-tolerant: it does not require the
// path to exist (find_large_files may scan a path the user just got
// wrong; we let the find subprocess surface that, not the validator).
//
// The check runs with the host's path semantics (see
// runtimePathSemantics): Unix matching is byte-exact, while Windows
// matching is case-insensitive and applies WindowsDeniedReadPaths.
//
// Decision matrix:
//   - Path exists + EvalSymlinks succeeds → the resolved form must be
//     in the symlink-resolved allow-list. This is the strict path: it
//     catches adversarial symlinks (/tmp/escape -> /etc) and tolerates
//     OS-canonical differences (macOS /var → /private/var, t.TempDir()
//     under /var/folders → /private/var/folders).
//   - Path doesn't exist (or resolution fails) → fall back to the
//     lexical check against the raw allow-list. This is the loose
//     path; it accepts not-yet-created paths under a whitelisted
//     prefix without failing the call up front.
func (s *SandboxConfig) ValidatePath(path string) error {
	return s.validatePathWith(runtimePathSemantics(), path)
}

// validatePathWith is ValidatePath parameterised on path semantics so the
// platform policy — including the Windows deny list and case-insensitive
// matching — is testable on any host.
func (s *SandboxConfig) validatePathWith(ps pathSemantics, path string) error {
	if s == nil {
		return errors.New("host_files sandbox: not configured")
	}
	if path == "" {
		return errors.New("host_files sandbox: path is required")
	}
	if !ps.isAbs(path) {
		return fmt.Errorf("host_files sandbox: path %q is not absolute", path)
	}
	clean := ps.clean(path)

	// Resolve symlinks when possible so an adversarial /tmp/escape →
	// /etc/shadow gets caught by the denylist on the resolved form.
	// Only meaningful for the host's own semantics; a Windows path can't
	// be resolved by a Unix host (and vice versa).
	resolved := clean
	if ps.native() {
		if r, err := filepath.EvalSymlinks(clean); err == nil {
			resolved = r
		}
	}

	// Step 1: denylist check (always applies). Reject when either the
	// raw path or its resolved form is exactly or under a denied prefix.
	if denied, hit := s.matchesDenied(ps, clean, resolved); denied {
		return fmt.Errorf("host_files sandbox: path %q is denied for read (matches deny prefix %q — virtual filesystem or sensitive material)",
			path, hit)
	}
	// Step 2: per-user .ssh / .gnupg are denied as a glob — the static
	// list catches the system-wide locations, this catches user profiles.
	if hit, denied := matchesPerUserSensitive(ps, resolved); denied {
		return fmt.Errorf("host_files sandbox: path %q (resolves to %q) is denied: %s — per-user secret material",
			path, resolved, hit)
	}

	// Step 3: optional allowlist. When AllowedReadPaths is non-empty the
	// path must additionally land under one of those prefixes. The
	// denylist above already ran, so an override cannot unlock a denied
	// path.
	if len(s.AllowedReadPaths) > 0 {
		if !s.lexicalInAllowList(ps, clean) && !s.resolvedInAllowList(ps, resolved) {
			return fmt.Errorf("host_files sandbox: path %q is outside the operator-set allow-list (%s)",
				path, strings.Join(s.AllowedReadPaths, " "))
		}
	}
	return nil
}

// pathSemantics captures the platform rules that differ between Unix and
// Windows path handling: separator, absolute-path syntax, cleaning, and
// case sensitivity. Parameterising the validator keeps the Windows policy
// testable on Linux, where runtime.GOOS != "windows".
type pathSemantics struct {
	separator       string
	caseInsensitive bool
	windows         bool
}

func unixPathSemantics() pathSemantics {
	return pathSemantics{separator: "/"}
}

func windowsPathSemantics() pathSemantics {
	return pathSemantics{separator: `\`, caseInsensitive: true, windows: true}
}

// native reports whether the semantics describe the host running this
// process. Only native paths can be resolved through filepath.EvalSymlinks.
func (ps pathSemantics) native() bool {
	return ps.windows == (runtime.GOOS == "windows")
}

func (ps pathSemantics) isAbs(p string) bool {
	if ps.windows {
		return isAbsWindows(p)
	}
	return filepath.IsAbs(p)
}

func (ps pathSemantics) clean(p string) string {
	if ps.windows {
		return cleanWindowsPath(p)
	}
	return filepath.Clean(p)
}

// equal compares two paths under the platform's case rule: byte-exact on
// Unix, case-insensitive on Windows.
func (ps pathSemantics) equal(a, b string) bool {
	if ps.caseInsensitive {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func (ps pathSemantics) hasPrefix(p, prefix string) bool {
	if ps.caseInsensitive {
		return len(p) >= len(prefix) && strings.EqualFold(p[:len(prefix)], prefix)
	}
	return strings.HasPrefix(p, prefix)
}

// isAbsWindows accepts drive-letter absolute paths (C:\ or C:/) and UNC
// paths. Drive-relative forms such as C:foo are rejected.
func isAbsWindows(p string) bool {
	if len(p) >= 3 && isASCIILetter(p[0]) && p[1] == ':' && (p[2] == '\\' || p[2] == '/') {
		return true
	}
	return strings.HasPrefix(p, `\\`) || strings.HasPrefix(p, `//`)
}

func isASCIILetter(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// cleanWindowsPath lexically cleans a Windows path independently of the
// host OS. Forward slashes are normalised to backslashes; "." segments are
// dropped and ".." segments are collapsed without escaping a rooted,
// drive-qualified, or UNC path.
func cleanWindowsPath(p string) string {
	p = strings.ReplaceAll(p, "/", `\`)
	unc := strings.HasPrefix(p, `\\`)
	var drive string
	rest := p
	switch {
	case unc:
		rest = p[2:]
	case len(p) >= 2 && isASCIILetter(p[0]) && p[1] == ':':
		drive = p[:2]
		rest = p[2:]
	}
	rooted := unc || strings.HasPrefix(rest, `\`)
	stack := make([]string, 0, 8)
	for _, part := range strings.Split(rest, `\`) {
		switch part {
		case "", ".":
			continue
		case "..":
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			} else if !rooted && drive == "" {
				stack = append(stack, part)
			}
		default:
			stack = append(stack, part)
		}
	}
	var b strings.Builder
	b.WriteString(drive)
	if unc {
		b.WriteString(`\\`)
	} else if rooted {
		b.WriteString(`\`)
	}
	b.WriteString(strings.Join(stack, `\`))
	out := b.String()
	if out == "" {
		return `\`
	}
	if drive != "" && len(stack) == 0 && !strings.HasSuffix(out, `\`) {
		out += `\`
	}
	return out
}

// matchesDenied returns (true, prefix) when clean OR resolved is exactly
// equal to or under any DeniedReadPaths prefix. On Windows semantics the
// WindowsDeniedReadPaths baseline is included automatically and all
// comparisons are case-insensitive; Unix comparisons stay byte-exact.
func (s *SandboxConfig) matchesDenied(ps pathSemantics, candidates ...string) (bool, string) {
	denied := s.DeniedReadPaths
	if ps.windows {
		// Copy so appending the platform baseline never mutates the
		// caller's slice.
		denied = append(append([]string(nil), denied...), WindowsDeniedReadPaths...)
	}
	for _, prefix := range denied {
		d := ps.clean(prefix)
		for _, candidate := range candidates {
			if ps.equal(candidate, d) || ps.hasPrefix(candidate, d+ps.separator) {
				return true, d
			}
		}
	}
	return false, ""
}

// matchesPerUserSensitive catches the per-user secret directories:
// /home/<user>/.ssh and /home/<user>/.gnupg on Unix (with /root handled
// by the static DeniedReadPaths list), and C:\Users\<user>\.ssh /
// .gnupg on Windows.
func matchesPerUserSensitive(ps pathSemantics, p string) (string, bool) {
	if ps.windows {
		return matchesPerUserSensitiveWindows(p)
	}
	if !strings.HasPrefix(p, "/home/") {
		return "", false
	}
	parts := strings.Split(p, ps.separator)
	// /home/<user>/.ssh → ["", "home", "<user>", ".ssh", ...]
	if len(parts) < 4 {
		return "", false
	}
	switch parts[3] {
	case ".ssh", ".gnupg":
		return "/home/" + parts[2] + "/" + parts[3], true
	}
	return "", false
}

// matchesPerUserSensitiveWindows recognises <drive>:\Users\<user>\.ssh
// and .gnupg regardless of letter case. Any drive letter is accepted so
// a relocated user profile is still covered.
func matchesPerUserSensitiveWindows(p string) (string, bool) {
	parts := strings.Split(strings.ReplaceAll(p, "/", `\`), `\`)
	// C:\Users\<user>\.ssh → ["C:", "Users", "<user>", ".ssh", ...]
	if len(parts) < 4 {
		return "", false
	}
	if len(parts[0]) != 2 || parts[0][1] != ':' || !isASCIILetter(parts[0][0]) {
		return "", false
	}
	if !strings.EqualFold(parts[1], "Users") {
		return "", false
	}
	if !strings.EqualFold(parts[3], ".ssh") && !strings.EqualFold(parts[3], ".gnupg") {
		return "", false
	}
	return parts[0] + `\` + parts[1] + `\` + parts[2] + `\` + parts[3], true
}

// lexicalInAllowList performs the cheap prefix-match against the raw
// (unresolved) allow-list. Trailing separator on the prefix prevents
// /var-evil from matching /var.
func (s *SandboxConfig) lexicalInAllowList(ps pathSemantics, p string) bool {
	for _, allowed := range s.AllowedReadPaths {
		a := ps.clean(allowed)
		if ps.equal(p, a) || ps.hasPrefix(p, a+ps.separator) {
			return true
		}
	}
	return false
}

// resolvedInAllowList performs the prefix-match against the
// symlink-resolved allow-list — i.e. each entry passed through
// EvalSymlinks. Used as a second pass when the requested path's
// resolved form differs from its cleaned form.
func (s *SandboxConfig) resolvedInAllowList(ps pathSemantics, p string) bool {
	for _, allowed := range s.AllowedReadPaths {
		a := ps.clean(allowed)
		if ps.native() {
			if r, err := filepath.EvalSymlinks(a); err == nil {
				a = r
			}
		}
		if ps.equal(p, a) || ps.hasPrefix(p, a+ps.separator) {
			return true
		}
	}
	return false
}

// ResolveBinary returns the absolute path of `name` from the allow-list
// or an error. Used by the handlers when they need to spawn find/du.
// The lookup is O(1) (map) so calling this on every handler invocation
// is fine — re-lookup also defends against a node where /usr/bin/find
// got replaced after agent startup (if the original entry no longer
// exists exec.Command will fail at run time and we propagate cleanly).
func (s *SandboxConfig) ResolveBinary(name string) (string, error) {
	if s == nil {
		return "", errors.New("host_files sandbox: not configured")
	}
	abs, ok := s.AllowedBinaries[name]
	if !ok {
		return "", fmt.Errorf("host_files sandbox: binary %q not in allow-list", name)
	}
	return abs, nil
}

// discoverBinaries resolves each name via exec.LookPath, falling back to
// the conventional Linux/Darwin locations when LookPath fails (root's
// PATH on a stripped systemd unit may not include /usr/local/bin).
// Missing binaries simply do not appear in the map; callers see a clean
// "binary not in allow-list" error.
func discoverBinaries(names []string) map[string]string {
	out := make(map[string]string, len(names))
	for _, n := range names {
		if abs, err := exec.LookPath(n); err == nil {
			out[n] = abs
			continue
		}
		for _, prefix := range []string{"/usr/bin", "/bin", "/usr/local/bin", "/sbin", "/usr/sbin"} {
			candidate := filepath.Join(prefix, n)
			if _, err := exec.LookPath(candidate); err == nil {
				out[n] = candidate
				break
			}
		}
	}
	return out
}
