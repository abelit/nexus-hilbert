package host_files

import (
	"context"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ongridio/ongrid/internal/pkg/tunnel"
)

// runFindOnePathGo is the platform-neutral, Go-native implementation of
// find_large_files. Windows uses it because find.exe is an unrelated
// tool; keeping it free of build tags lets the same traversal run under
// `go test` on Linux.
func runFindOnePathGo(ctx context.Context, sb *SandboxConfig, path string, req tunnel.FindLargeFilesRequest) tunnel.FindLargeFilesResultEntry {
	entry := tunnel.FindLargeFilesResultEntry{Path: path}
	if err := sb.ValidatePath(path); err != nil {
		entry.Error = err.Error()
		return entry
	}
	cctx, cancel := context.WithTimeout(ctx, hostFilesPerPathTimeout)
	defer cancel()

	files, err := walkFindLargeFiles(cctx, sb, path, req.MinSizeBytes, req.ExcludePaths)
	if err != nil {
		entry.Error = err.Error()
		return entry
	}
	// Mirror runFindOnePath: sort descending, cap at top_n, then format.
	sort.Slice(files, func(i, j int) bool { return files[i].SizeBytes > files[j].SizeBytes })
	if req.TopN > 0 && req.TopN < len(files) {
		files = files[:req.TopN]
	}
	for i := range files {
		files[i].SizeHuman = humanBytes(files[i].SizeBytes)
	}
	entry.ScannedPath = path
	entry.Files = files
	return entry
}

// walkFindLargeFiles walks root with filepath.WalkDir and returns regular
// files whose size is at least minSizeBytes. excludePaths are treated as
// path prefixes (same semantics as the shell-out `-path <prefix>* -prune`
// branch) and prune both directory subtrees and matching files.
//
// The sandbox denylist is enforced again on descendants: denied
// directories are pruned and denied files skipped. The caller validates
// the root before invoking this walker.
func walkFindLargeFiles(ctx context.Context, sb *SandboxConfig, root string, minSizeBytes int64, excludePaths []string) ([]tunnel.HostFileInfo, error) {
	root = filepath.Clean(root)
	excludes := cleanExcludePrefixes(excludePaths)

	var files []tunnel.HostFileInfo
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			// Unreadable subtrees are non-fatal (find behaves the same:
			// permission noise on stderr, useful stdout still returned).
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
		if excludedByPrefix(p, excludes) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if p != root && sb != nil {
				if err := sb.ValidatePath(p); err != nil {
					return filepath.SkipDir
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
		if info.Size() < minSizeBytes {
			return nil
		}
		owner, _ := fileOwner(info)
		files = append(files, tunnel.HostFileInfo{
			Path:      p,
			SizeBytes: info.Size(),
			Mtime:     info.ModTime().UTC(),
			Owner:     owner,
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return files, nil
}

// cleanExcludePrefixes normalises the exclude list once per walk.
func cleanExcludePrefixes(paths []string) []string {
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		if p == "" {
			continue
		}
		out = append(out, filepath.Clean(p))
	}
	return out
}

// excludedByPrefix reports whether p starts with any exclude prefix.
// Plain prefix matching mirrors `find -path <prefix>*`.
func excludedByPrefix(p string, excludes []string) bool {
	for _, ex := range excludes {
		if strings.HasPrefix(p, ex) {
			return true
		}
	}
	return false
}
