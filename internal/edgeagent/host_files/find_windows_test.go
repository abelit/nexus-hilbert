//go:build windows

package host_files

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ongridio/ongrid/internal/pkg/tunnel"
)

// TestRunFindOnePathWindows_Smoke exercises the Windows entry point so the
// build-tagged wrapper is covered when the suite runs on Windows. The
// traversal logic itself is shared with the cross-platform tests in
// find_walk_test.go.
func TestRunFindOnePathWindows_Smoke(t *testing.T) {
	tmp := t.TempDir()
	writeFile(t, filepath.Join(tmp, "big.bin"), 2*testMiB)
	writeFile(t, filepath.Join(tmp, "small.bin"), 100*1024)

	root := canon(t, tmp)
	sb := &SandboxConfig{AllowedReadPaths: []string{root}}
	entry := runFindOnePathWindows(context.Background(), sb, root, tunnel.FindLargeFilesRequest{
		TopN:         20,
		MinSizeBytes: 1 * testMiB,
	})
	if entry.Error != "" {
		t.Fatalf("entry error: %s", entry.Error)
	}
	if len(entry.Files) != 1 {
		t.Fatalf("got %d files, want 1: %+v", len(entry.Files), entry.Files)
	}
	if !strings.HasSuffix(entry.Files[0].Path, "big.bin") {
		t.Errorf("unexpected file: %q", entry.Files[0].Path)
	}
}
