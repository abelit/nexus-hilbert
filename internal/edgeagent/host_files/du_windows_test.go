//go:build windows

package host_files

import (
	"context"
	"path/filepath"
	"testing"
)

// TestRunDuOnePathWindows_Smoke exercises the Windows entry point so the
// build-tagged wrapper is covered when the suite runs on Windows. The
// traversal logic itself is shared with the cross-platform tests in
// du_walk_test.go.
func TestRunDuOnePathWindows_Smoke(t *testing.T) {
	tmp := t.TempDir()
	writeFile(t, filepath.Join(tmp, "a", "f.bin"), 3*testMiB)
	writeFile(t, filepath.Join(tmp, "b", "f.bin"), 1*testMiB)

	root := canon(t, tmp)
	sb := &SandboxConfig{AllowedReadPaths: []string{root}}
	entry := runDuOnePathWindows(context.Background(), sb, root, 1)
	if entry.Error != "" {
		t.Fatalf("entry error: %s", entry.Error)
	}
	if len(entry.Subpaths) != 2 {
		t.Fatalf("got %d subpaths, want 2: %+v", len(entry.Subpaths), entry.Subpaths)
	}
	if entry.TotalSizeBytes != 4*testMiB {
		t.Errorf("total = %d, want %d", entry.TotalSizeBytes, 4*testMiB)
	}
}
