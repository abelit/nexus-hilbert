//go:build !windows

package host_files

import (
	"context"

	"github.com/ongridio/ongrid/internal/pkg/tunnel"
)

// runDuOnePathWindows exists so the untagged handler compiles on
// non-Windows platforms. The handler's runtime.GOOS guard makes it
// unreachable there; Windows builds use du_windows.go instead.
func runDuOnePathWindows(ctx context.Context, sb *SandboxConfig, path string, depth int) tunnel.DuSummaryResultEntry {
	return runDuOnePathGo(ctx, sb, path, depth)
}
