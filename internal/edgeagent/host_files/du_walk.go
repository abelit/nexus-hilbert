package host_files

import (
	"context"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ongridio/ongrid/internal/pkg/tunnel"
)

// runDuOnePathGo is the platform-neutral, Go-native implementation of
// du_summary. Windows uses it because there is no du.exe; keeping it
// free of build tags lets the same traversal run under `go test` on
// Linux.
func runDuOnePathGo(ctx context.Context, sb *SandboxConfig, path string, depth int) tunnel.DuSummaryResultEntry {
	entry := tunnel.DuSummaryResultEntry{Path: path}
	if err := sb.ValidatePath(path); err != nil {
		entry.Error = err.Error()
		return entry
	}
	cctx, cancel := context.WithTimeout(ctx, hostFilesPerPathTimeout)
	defer cancel()

	entries, total, err := walkDuSummary(cctx, sb, path, depth)
	if err != nil {
		entry.Error = err.Error()
		return entry
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].SizeBytes > entries[j].SizeBytes })
	for i := range entries {
		entries[i].SizeHuman = humanBytes(entries[i].SizeBytes)
	}
	entry.Subpaths = entries
	entry.TotalSizeBytes = total
	entry.TotalSizeHuman = humanBytes(total)
	return entry
}

// walkDuSummary sums regular-file sizes recursively. Every directory at
// depth 1..depth below root becomes a HostDuEntry carrying its recursive
// size; the grand total covers everything under root (including files
// directly in root and files deeper than depth).
//
// Denied directories are pruned and denied files skipped, matching the
// sandbox constraints applied by the shell-out path.
func walkDuSummary(ctx context.Context, sb *SandboxConfig, root string, depth int) ([]tunnel.HostDuEntry, int64, error) {
	root = filepath.Clean(root)
	if depth <= 0 {
		depth = 1
	}

	sizes := map[string]int64{}
	var total int64
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if p == root {
				return walkErr
			}
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if d.IsDir() {
			if p == root {
				return nil
			}
			if sb != nil {
				if err := sb.ValidatePath(p); err != nil {
					return filepath.SkipDir
				}
			}
			// Register the directory even when empty so the response
			// mirrors du, which lists zero-size children.
			if lvl := relativeDepth(root, p); lvl > 0 && lvl <= depth {
				if _, ok := sizes[p]; !ok {
					sizes[p] = 0
				}
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if sb != nil {
			if err := sb.ValidatePath(p); err != nil {
				return nil
			}
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		size := info.Size()
		total += size
		// Every ancestor directory up to the requested depth accumulates
		// the file size; deeper files still contribute to the root total.
		for dir := filepath.Dir(p); dir != root; dir = filepath.Dir(dir) {
			if !withinRoot(root, dir) {
				break
			}
			if relativeDepth(root, dir) <= depth {
				sizes[dir] += size
			}
		}
		return nil
	})
	if err != nil {
		return nil, 0, err
	}
	entries := make([]tunnel.HostDuEntry, 0, len(sizes))
	for p, sz := range sizes {
		entries = append(entries, tunnel.HostDuEntry{Subpath: p, SizeBytes: sz})
	}
	return entries, total, nil
}

// relativeDepth returns how many path components separate p from root;
// root itself is depth 0.
func relativeDepth(root, p string) int {
	rel, err := filepath.Rel(root, p)
	if err != nil {
		return 0
	}
	if rel == "." || rel == "" {
		return 0
	}
	return len(strings.Split(rel, string(filepath.Separator)))
}

// withinRoot reports whether p is root or lies inside it. Using
// filepath.Rel avoids the "//" / "C:\\" concatenation trap that a naive
// prefix check hits when root is a filesystem root.
func withinRoot(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
