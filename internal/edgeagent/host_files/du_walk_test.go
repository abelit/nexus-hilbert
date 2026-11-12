package host_files

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ongridio/ongrid/internal/pkg/tunnel"
)

// duEntryBySuffix finds the entry whose Subpath ends with the supplied
// relative suffix. WalkDir yields absolute paths, so suffix matching
// keeps the assertions readable across temp-dir prefixes.
func duEntryBySuffix(t *testing.T, entries []tunnel.HostDuEntry, suffix string) tunnel.HostDuEntry {
	t.Helper()
	for _, e := range entries {
		if strings.HasSuffix(e.Subpath, suffix) {
			return e
		}
	}
	t.Fatalf("no du entry with suffix %q in %+v", suffix, entries)
	return tunnel.HostDuEntry{}
}

func TestRunDuOnePathGo_BasicDepthOne(t *testing.T) {
	tmp := t.TempDir()
	// a: 3 MiB + nested 2 MiB = 5 MiB recursive
	// b: 1 MiB
	// root file: 512 KiB (contributes to total, not to any subpath)
	writeFile(t, filepath.Join(tmp, "a", "file1.bin"), 3*testMiB)
	writeFile(t, filepath.Join(tmp, "a", "nested", "file2.bin"), 2*testMiB)
	writeFile(t, filepath.Join(tmp, "b", "file.bin"), 1*testMiB)
	writeFile(t, filepath.Join(tmp, "rootfile.bin"), 512*1024)

	sb := walkTestSandbox(t, []string{tmp}, nil)
	entry := runDuOnePathGo(context.Background(), sb, canon(t, tmp), 1)
	if entry.Error != "" {
		t.Fatalf("entry error: %s", entry.Error)
	}
	if len(entry.Subpaths) != 2 {
		t.Fatalf("got %d subpaths, want 2 (depth 1): %+v", len(entry.Subpaths), entry.Subpaths)
	}
	a := duEntryBySuffix(t, entry.Subpaths, filepath.Join("a"))
	if a.SizeBytes != 5*testMiB {
		t.Errorf("a = %d, want %d", a.SizeBytes, 5*testMiB)
	}
	b := duEntryBySuffix(t, entry.Subpaths, filepath.Join("b"))
	if b.SizeBytes != 1*testMiB {
		t.Errorf("b = %d, want %d", b.SizeBytes, 1*testMiB)
	}
	// Sorted descending.
	if entry.Subpaths[0].SizeBytes < entry.Subpaths[1].SizeBytes {
		t.Errorf("not sorted descending: %+v", entry.Subpaths)
	}
	wantTotal := int64(6*testMiB + 512*1024)
	if entry.TotalSizeBytes != wantTotal {
		t.Errorf("total = %d, want %d", entry.TotalSizeBytes, wantTotal)
	}
	if entry.TotalSizeHuman == "" {
		t.Errorf("TotalSizeHuman empty")
	}
}

func TestRunDuOnePathGo_DepthTwo(t *testing.T) {
	tmp := t.TempDir()
	writeFile(t, filepath.Join(tmp, "a", "file1.bin"), 3*testMiB)
	writeFile(t, filepath.Join(tmp, "a", "nested", "file2.bin"), 2*testMiB)
	writeFile(t, filepath.Join(tmp, "b", "file.bin"), 1*testMiB)

	sb := walkTestSandbox(t, []string{tmp}, nil)
	entry := runDuOnePathGo(context.Background(), sb, canon(t, tmp), 2)
	if entry.Error != "" {
		t.Fatalf("entry error: %s", entry.Error)
	}
	if len(entry.Subpaths) != 3 {
		t.Fatalf("got %d subpaths, want 3 (a, a/nested, b): %+v", len(entry.Subpaths), entry.Subpaths)
	}
	nested := duEntryBySuffix(t, entry.Subpaths, filepath.Join("a", "nested"))
	if nested.SizeBytes != 2*testMiB {
		t.Errorf("nested = %d, want %d", nested.SizeBytes, 2*testMiB)
	}
	a := duEntryBySuffix(t, entry.Subpaths, filepath.Join("a"))
	if a.SizeBytes != 5*testMiB {
		t.Errorf("a = %d, want %d", a.SizeBytes, 5*testMiB)
	}
}

func TestRunDuOnePathGo_EmptyDir(t *testing.T) {
	tmp := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tmp, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	sb := walkTestSandbox(t, []string{tmp}, nil)
	entry := runDuOnePathGo(context.Background(), sb, canon(t, tmp), 1)
	if entry.Error != "" {
		t.Fatalf("entry error: %s", entry.Error)
	}
	e := duEntryBySuffix(t, entry.Subpaths, "empty")
	if e.SizeBytes != 0 {
		t.Errorf("empty dir size = %d, want 0", e.SizeBytes)
	}
	if entry.TotalSizeBytes != 0 {
		t.Errorf("total = %d, want 0", entry.TotalSizeBytes)
	}
}

func TestRunDuOnePathGo_DeniedPath(t *testing.T) {
	tmp := t.TempDir()
	writeFile(t, filepath.Join(tmp, "f.bin"), testMiB)
	sb := walkTestSandbox(t, nil, []string{tmp})
	entry := runDuOnePathGo(context.Background(), sb, canon(t, tmp), 1)
	if entry.Error == "" {
		t.Fatalf("expected error for denied root, got %+v", entry)
	}
}

func TestRunDuOnePathGo_DeniedDescendant(t *testing.T) {
	tmp := t.TempDir()
	writeFile(t, filepath.Join(tmp, "ok", "f.bin"), 1*testMiB)
	writeFile(t, filepath.Join(tmp, "secret", "f.bin"), 4*testMiB)

	sb := walkTestSandbox(t, []string{tmp}, []string{filepath.Join(tmp, "secret")})
	entry := runDuOnePathGo(context.Background(), sb, canon(t, tmp), 1)
	if entry.Error != "" {
		t.Fatalf("entry error: %s", entry.Error)
	}
	if len(entry.Subpaths) != 1 {
		t.Fatalf("got %d subpaths, want 1 (secret/ denied): %+v", len(entry.Subpaths), entry.Subpaths)
	}
	if !strings.HasSuffix(entry.Subpaths[0].Subpath, "ok") {
		t.Errorf("unexpected subpath: %q", entry.Subpaths[0].Subpath)
	}
	if entry.TotalSizeBytes != 1*testMiB {
		t.Errorf("total = %d, want %d", entry.TotalSizeBytes, 1*testMiB)
	}
}

func TestWalkDuSummary_ContextCancel(t *testing.T) {
	tmp := t.TempDir()
	writeFile(t, filepath.Join(tmp, "a", "f.bin"), testMiB)
	sb := walkTestSandbox(t, []string{tmp}, nil)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, err := walkDuSummary(ctx, sb, canon(t, tmp), 1)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

// TestWithinRoot guards the ancestor accumulation against the
// filesystem-root concatenation trap: root "/" must still contain "/a",
// while a sibling with a shared textual prefix must not.
func TestWithinRoot(t *testing.T) {
	cases := []struct {
		root, p string
		want    bool
	}{
		{"/", "/", true},
		{"/", "/a", true},
		{"/", "/a/b", true},
		{"/tmp/x", "/tmp/x", true},
		{"/tmp/x", "/tmp/x/a", true},
		{"/tmp/x", "/tmp/y", false},
		{"/tmp/x", "/tmp/x-evil", false},
	}
	for _, c := range cases {
		if got := withinRoot(c.root, c.p); got != c.want {
			t.Errorf("withinRoot(%q, %q) = %v, want %v", c.root, c.p, got, c.want)
		}
	}
}

func TestRelativeDepth(t *testing.T) {
	cases := []struct {
		root, p string
		want    int
	}{
		{"/", "/", 0},
		{"/", "/a", 1},
		{"/", "/a/b", 2},
		{"/tmp/x", "/tmp/x/a/b", 2},
	}
	for _, c := range cases {
		if got := relativeDepth(c.root, c.p); got != c.want {
			t.Errorf("relativeDepth(%q, %q) = %d, want %d", c.root, c.p, got, c.want)
		}
	}
}
