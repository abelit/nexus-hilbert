//go:build windows

package host_files

import (
	"context"

	"github.com/ongridio/ongrid/internal/pkg/tunnel"
)

// runDuOnePathWindows is the Windows entry point for du_summary. There
// is no du.exe on Windows, so the handler bypasses ResolveBinary and
// uses the Go-native walker in du_walk.go. The wrapper is intentionally
// thin: the traversal itself stays platform-neutral and is covered by
// tests that run on every OS.
func runDuOnePathWindows(ctx context.Context, sb *SandboxConfig, path string, depth int) tunnel.DuSummaryResultEntry {
	return runDuOnePathGo(ctx, sb, path, depth)
}
