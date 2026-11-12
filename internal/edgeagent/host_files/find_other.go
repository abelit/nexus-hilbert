//go:build !windows

package host_files

import (
	"context"

	"github.com/ongridio/ongrid/internal/pkg/tunnel"
)

// runFindOnePathWindows exists so the untagged handler compiles on
// non-Windows platforms. The handler's runtime.GOOS guard makes it
// unreachable there; Windows builds use find_windows.go instead.
func runFindOnePathWindows(ctx context.Context, sb *SandboxConfig, path string, req tunnel.FindLargeFilesRequest) tunnel.FindLargeFilesResultEntry {
	return runFindOnePathGo(ctx, sb, path, req)
}
