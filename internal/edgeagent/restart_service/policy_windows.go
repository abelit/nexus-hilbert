//go:build windows

// This file holds the Windows edge-side policy for restart_service.
//
// The Linux implementation (handlers.go) works with systemd unit
// short-names. Windows has no systemd: the closest primitive is the
// Service Control Manager, driven through sc.exe, and the allow-list
// therefore contains Windows service names (W3SVC, MySQL, ...) rather
// than unit names. The wire method and request/response shapes are
// unchanged, so the manager-side BaseTool and reviewer flow work as-is.
//
// Policy file: C:\ProgramData\ongrid-edge\restart-policy.json
//
//	{
//	  "allowed_services": ["W3SVC", "MySQL", "Redis", "nginx", "ongrid"],
//	  "mocked": false
//	}
//
// A missing file falls back to DefaultSandboxConfig(). A present but
// malformed file is an error: silently substituting the defaults could
// re-enable a service the operator meant to remove.
package restart_service

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	// defaultPolicyPath is the operator-owned restart allow-list. The
	// installer creates C:\ProgramData\ongrid-edge with a SYSTEM +
	// Administrators ACL, so a standard user cannot widen the list.
	defaultPolicyPath = `C:\ProgramData\ongrid-edge\restart-policy.json`

	// maxServiceNameLen bounds the canonicalised name. Windows SCM allows
	// up to 256 characters; the edge is deliberately stricter because no
	// default allow-list entry comes close.
	maxServiceNameLen = 128
)

// SandboxConfig is the Windows edge-side allow-list for restart_service.
// AllowedServices holds Windows service names (not display names, not
// systemd units). Mocked=true returns the audit-friendly pretend restart
// without invoking sc.exe; the production default is false because the
// Windows implementation performs a real stop/start.
type SandboxConfig struct {
	// AllowedServices is the canonical allow-list. Matching is
	// case-insensitive and ignores an optional ".exe"/".service" suffix.
	AllowedServices []string

	// Mocked = true → return success without invoking sc.exe. Defaults
	// to false; tests and dry-run labs may set it true.
	Mocked bool

	// once/allowed cache the canonical → original-spelling mapping so a
	// lookup never re-parses the configured slice.
	once    sync.Once
	allowed map[string]string
}

// DefaultSandboxConfig returns the production-default Windows allow-list.
// The entries are the services most often restarted during on-call work on
// the supported Windows Server matrix. The list is intentionally narrow:
// the worst blast radius is restarting one of these local services.
func DefaultSandboxConfig() *SandboxConfig {
	return &SandboxConfig{
		AllowedServices: []string{
			"W3SVC",
			"MySQL",
			"Redis",
			"nginx",
			"ongrid",
		},
		Mocked: false,
	}
}

// ensure precomputes the canonical → configured-spelling map on first use.
// When two entries canonicalise to the same value the first one wins; that
// is operator error and does not change the allow/deny decision.
func (s *SandboxConfig) ensure() {
	s.once.Do(func() {
		s.allowed = make(map[string]string, len(s.AllowedServices))
		for _, name := range s.AllowedServices {
			canonical := canonicalServiceName(name)
			if canonical == "" {
				continue
			}
			if _, exists := s.allowed[canonical]; !exists {
				s.allowed[canonical] = name
			}
		}
	})
}

// Validate returns nil when the sandbox is internally consistent. An empty
// or unusable allow-list errors so a misconfigured override cannot widen
// the capability to "everything".
func (s *SandboxConfig) Validate() error {
	if s == nil {
		return errors.New("restart_service sandbox: config is nil")
	}
	if len(s.AllowedServices) == 0 {
		return errors.New("restart_service sandbox: AllowedServices must contain at least one entry")
	}
	for _, name := range s.AllowedServices {
		if canonicalServiceName(name) == "" {
			return fmt.Errorf("restart_service sandbox: invalid service name %q", name)
		}
	}
	return nil
}

// Allows reports whether service is allow-listed under Windows
// canonicalisation (case-insensitive, whitespace-trimmed, suffix-stripped).
func (s *SandboxConfig) Allows(service string) bool {
	_, ok := s.Resolve(service)
	return ok
}

// Resolve returns the configured spelling of an allow-listed service. The
// configured spelling is what sc.exe receives, preserving the operator's
// casing (SCM is case-insensitive, but logs and audit rows stay readable).
func (s *SandboxConfig) Resolve(service string) (string, bool) {
	if s == nil {
		return "", false
	}
	canonical := canonicalServiceName(service)
	if canonical == "" {
		return "", false
	}
	s.ensure()
	configured, ok := s.allowed[canonical]
	return configured, ok
}

// canonicalServiceName normalises a Windows service name: trim whitespace,
// lower-case, drop a trailing ".exe" or ".service" suffix, and drop a
// trailing parenthesised display suffix ("MySQL (MySQL Server)" → "mysql").
// Names containing a path separator or control character are rejected
// (return ""). An empty result is never a valid allow-list match.
func canonicalServiceName(service string) string {
	s := strings.TrimSpace(service)
	if s == "" || len(s) > maxServiceNameLen {
		return ""
	}
	// Display names sometimes arrive as "<service> (<description>)".
	if i := strings.LastIndex(s, " ("); i > 0 && strings.HasSuffix(s, ")") {
		s = strings.TrimSpace(s[:i])
	}
	s = strings.ToLower(s)
	s = strings.TrimSuffix(s, ".exe")
	s = strings.TrimSuffix(s, ".service")
	s = strings.TrimSpace(s)
	if s == "" || len(s) > maxServiceNameLen {
		return ""
	}
	if strings.ContainsAny(s, "/\\") {
		return ""
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return ""
		}
	}
	return s
}

// policyFile is the on-disk JSON shape. AllowedServices is a pointer-free
// slice so JSON null / an absent key leaves it nil (→ keep defaults) while
// an explicit [] stays non-nil (→ validate and reject an empty list).
type policyFile struct {
	AllowedServices []string `json:"allowed_services"`
	Mocked          bool     `json:"mocked"`
}

// loadSandboxConfig reads the policy at path. A missing file is the normal
// first-boot state and yields the defaults. Any other read/parse/validate
// error is returned so the caller can decide to boot without the capability.
func loadSandboxConfig(path string) (*SandboxConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return DefaultSandboxConfig(), nil
		}
		return nil, fmt.Errorf("restart_service: read policy %q: %w", path, err)
	}
	var raw policyFile
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("restart_service: parse policy %q: %w", path, err)
	}
	cfg := DefaultSandboxConfig()
	if raw.AllowedServices != nil {
		cfg.AllowedServices = raw.AllowedServices
	}
	cfg.Mocked = raw.Mocked
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("restart_service: policy %q: %w", path, err)
	}
	return cfg, nil
}

// resolveScExe returns the absolute path to sc.exe under
// %SystemRoot%\System32, falling back to %windir%. An absolute path is a
// hard requirement: the Edge worker runs as LocalSystem and inherits the
// system PATH, where third-party software may inject a user-writable
// directory. Resolving a bare "sc.exe" would let such a planted binary run
// as LocalSystem (same rationale as internal/edgeagent/install/acl_windows.go).
func resolveScExe() (string, error) {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = os.Getenv("windir")
	}
	if root == "" {
		return "", errors.New("restart_service: SystemRoot/windir is not set; cannot resolve sc.exe")
	}
	if !filepath.IsAbs(root) {
		return "", fmt.Errorf("restart_service: SystemRoot/windir %q is not absolute; refusing to resolve sc.exe", root)
	}
	return filepath.Join(root, "System32", "sc.exe"), nil
}
