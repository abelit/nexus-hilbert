//go:build windows

package host_files

import (
	"context"

	"github.com/ongridio/ongrid/internal/pkg/tunnel"
)

// runFindOnePathWindows is the Windows entry point for find_large_files.
// Windows ships a different `find.exe` and no `du.exe`, so the handler
// bypasses ResolveBinary and uses the Go-native walker in find_walk.go.
// The wrapper is intentionally thin: the traversal itself stays
// platform-neutral and is covered by tests that run on every OS.
func runFindOnePathWindows(ctx context.Context, sb *SandboxConfig, path string, req tunnel.FindLargeFilesRequest) tunnel.FindLargeFilesResultEntry {
	return runFindOnePathGo(ctx, sb, path, req)
}
