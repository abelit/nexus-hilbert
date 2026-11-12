package host_files

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ongridio/ongrid/internal/pkg/tunnel"
)

const testMiB = 1024 * 1024

// walkTestSandbox builds a sandbox for the Go-native walk tests without
// requiring external binaries (the walker does not shell out). Deny and
// allow paths are canonicalised so they match what ValidatePath resolves.
func walkTestSandbox(t *testing.T, allow, deny []string) *SandboxConfig {
	t.Helper()
	sb := &SandboxConfig{}
	for _, p := range deny {
		sb.DeniedReadPaths = append(sb.DeniedReadPaths, canon(t, p))
	}
	for _, p := range allow {
		sb.AllowedReadPaths = append(sb.AllowedReadPaths, canon(t, p))
	}
	return sb
}

func TestRunFindOnePathGo_Basic(t *testing.T) {
	tmp := t.TempDir()
	writeFile(t, filepath.Join(tmp, "biggest.bin"), 4*testMiB)
	writeFile(t, filepath.Join(tmp, "sub", "middle.bin"), 2*testMiB)
	writeFile(t, filepath.Join(tmp, "small.bin"), 512*1024)

	sb := walkTestSandbox(t, []string{tmp}, nil)
	root := canon(t, tmp)
	entry := runFindOnePathGo(context.Background(), sb, root, tunnel.FindLargeFilesRequest{
		TopN:         20,
		MinSizeBytes: 1 * testMiB,
	})
	if entry.Error != "" {
		t.Fatalf("entry error: %s", entry.Error)
	}
	if entry.ScannedPath != root {
		t.Errorf("ScannedPath = %q, want %q", entry.ScannedPath, root)
	}
	if len(entry.Files) != 2 {
		t.Fatalf("got %d files, want 2 (1 MiB min excludes small.bin): %+v", len(entry.Files), entry.Files)
	}
	// Sorted descending by size.
	if entry.Files[0].SizeBytes != 4*testMiB || entry.Files[1].SizeBytes != 2*testMiB {
		t.Errorf("unexpected order/sizes: %+v", entry.Files)
	}
	if !strings.HasPrefix(entry.Files[0].Path, root) {
		t.Errorf("file path %q not under root %q", entry.Files[0].Path, root)
	}
	if entry.Files[0].SizeHuman == "" {
		t.Errorf("SizeHuman empty")
	}
	if entry.Files[0].Mtime.IsZero() {
		t.Errorf("Mtime zero")
	}
	if time.Since(entry.Files[0].Mtime) > time.Hour {
		t.Errorf("Mtime suspiciously stale: %v", entry.Files[0].Mtime)
	}
}

func TestRunFindOnePathGo_TopNAndMinSize(t *testing.T) {
	tmp := t.TempDir()
	writeFile(t, filepath.Join(tmp, "biggest.bin"), 4*testMiB)
	writeFile(t, filepath.Join(tmp, "middle.bin"), 2*testMiB)
	writeFile(t, filepath.Join(tmp, "tiny.bin"), 100*1024)

	sb := walkTestSandbox(t, []string{tmp}, nil)
	root := canon(t, tmp)

	t.Run("top_n truncates", func(t *testing.T) {
		entry := runFindOnePathGo(context.Background(), sb, root, tunnel.FindLargeFilesRequest{
			TopN:         1,
			MinSizeBytes: 1,
		})
		if entry.Error != "" {
			t.Fatalf("entry error: %s", entry.Error)
		}
		if len(entry.Files) != 1 {
			t.Fatalf("got %d files, want 1", len(entry.Files))
		}
		if entry.Files[0].SizeBytes != 4*testMiB {
			t.Errorf("top file = %d, want %d", entry.Files[0].SizeBytes, 4*testMiB)
		}
	})

	t.Run("min size filters", func(t *testing.T) {
		entry := runFindOnePathGo(context.Background(), sb, root, tunnel.FindLargeFilesRequest{
			TopN:         20,
			MinSizeBytes: 3 * testMiB,
		})
		if entry.Error != "" {
			t.Fatalf("entry error: %s", entry.Error)
		}
		if len(entry.Files) != 1 {
			t.Fatalf("got %d files, want 1 (only biggest >= 3 MiB): %+v", len(entry.Files), entry.Files)
		}
		if entry.Files[0].SizeBytes != 4*testMiB {
			t.Errorf("file = %d, want %d", entry.Files[0].SizeBytes, 4*testMiB)
		}
	})
}

func TestRunFindOnePathGo_ExcludePaths(t *testing.T) {
	tmp := t.TempDir()
	writeFile(t, filepath.Join(tmp, "keep", "keep.bin"), 2*testMiB)
	writeFile(t, filepath.Join(tmp, "skip", "big.bin"), 4*testMiB)

	sb := walkTestSandbox(t, []string{tmp}, nil)
	root := canon(t, tmp)
	entry := runFindOnePathGo(context.Background(), sb, root, tunnel.FindLargeFilesRequest{
		TopN:         20,
		MinSizeBytes: 1 * testMiB,
		ExcludePaths: []string{filepath.Join(root, "skip")},
	})
	if entry.Error != "" {
		t.Fatalf("entry error: %s", entry.Error)
	}
	if len(entry.Files) != 1 {
		t.Fatalf("got %d files, want 1 (skip/ excluded): %+v", len(entry.Files), entry.Files)
	}
	if !strings.HasSuffix(entry.Files[0].Path, filepath.Join("keep", "keep.bin")) {
		t.Errorf("unexpected file: %q", entry.Files[0].Path)
	}
}

func TestRunFindOnePathGo_DeniedPath(t *testing.T) {
	tmp := t.TempDir()
	writeFile(t, filepath.Join(tmp, "f.bin"), 2*testMiB)

	sb := walkTestSandbox(t, nil, []string{tmp})
	entry := runFindOnePathGo(context.Background(), sb, canon(t, tmp), tunnel.FindLargeFilesRequest{
		TopN:         20,
		MinSizeBytes: 1,
	})
	if entry.Error == "" {
		t.Fatalf("expected error for denied root, got %+v", entry)
	}
}

func TestRunFindOnePathGo_DeniedDescendant(t *testing.T) {
	tmp := t.TempDir()
	writeFile(t, filepath.Join(tmp, "ok", "ok.bin"), 2*testMiB)
	writeFile(t, filepath.Join(tmp, "secret", "big.bin"), 4*testMiB)

	sb := walkTestSandbox(t, []string{tmp}, []string{filepath.Join(tmp, "secret")})
	root := canon(t, tmp)
	entry := runFindOnePathGo(context.Background(), sb, root, tunnel.FindLargeFilesRequest{
		TopN:         20,
		MinSizeBytes: 1,
	})
	if entry.Error != "" {
		t.Fatalf("entry error: %s", entry.Error)
	}
	if len(entry.Files) != 1 {
		t.Fatalf("got %d files, want 1 (secret/ denied): %+v", len(entry.Files), entry.Files)
	}
	for _, f := range entry.Files {
		if strings.Contains(f.Path, "secret") {
			t.Errorf("denied descendant leaked into results: %q", f.Path)
		}
	}
}

func TestWalkFindLargeFiles_ContextCancel(t *testing.T) {
	tmp := t.TempDir()
	writeFile(t, filepath.Join(tmp, "f.bin"), testMiB)
	sb := walkTestSandbox(t, []string{tmp}, nil)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := walkFindLargeFiles(ctx, sb, canon(t, tmp), 0, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestWalkFindLargeFiles_ContextDeadline(t *testing.T) {
	tmp := t.TempDir()
	writeFile(t, filepath.Join(tmp, "f.bin"), testMiB)
	sb := walkTestSandbox(t, []string{tmp}, nil)

	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	_, err := walkFindLargeFiles(ctx, sb, canon(t, tmp), 0, nil)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want context.DeadlineExceeded", err)
	}
}
