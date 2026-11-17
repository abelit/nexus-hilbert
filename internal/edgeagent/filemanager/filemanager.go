// Package filemanager implements the edge side of the device file manager.
//
// Reads are allowed for any absolute path; writes (upload/mkdir/rename) are
// restricted to the transfer sandbox plus the writable roots supplied by the
// Manager in each request. The edge re-validates every write path so a bug or
// a compromised Manager cannot write outside the configured roots.
package filemanager

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/ongridio/ongrid/internal/edgeagent/filetransfer"
	"github.com/ongridio/ongrid/internal/pkg/tunnel"
)

// MaxUploadSize caps a single upload through the file manager (8 GiB).
const MaxUploadSize int64 = 8 << 30

const maxPreface = 16 << 10

// HandleStream serves one file-manager stream. The preface line is replayed
// by the stream router and consumed here.
func HandleStream(stream tunnel.StreamConn, log *slog.Logger) {
	defer stream.Close()
	if log == nil {
		log = slog.Default()
	}
	br := bufio.NewReaderSize(stream, maxPreface)
	line, err := br.ReadString('\n')
	if err != nil {
		log.Warn("filemanager: read preface", slog.Any("err", err))
		return
	}
	if len(line) > maxPreface {
		writeResponse(stream, tunnel.FileManagerResponse{Error: "preface too long"}, log)
		return
	}
	if !strings.HasPrefix(line, tunnel.FileManagerPreface) {
		writeResponse(stream, tunnel.FileManagerResponse{Error: "invalid file-manager preface"}, log)
		return
	}
	var req tunnel.FileManagerRequest
	if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, tunnel.FileManagerPreface))), &req); err != nil {
		writeResponse(stream, tunnel.FileManagerResponse{Error: "invalid request: " + err.Error()}, log)
		return
	}
	s := &bufferedStream{StreamConn: stream, reader: br}
	roots := writableRoots(req.Roots)

	switch req.Op {
	case "roots":
		rootsOp(s, roots, log)
	case "list":
		listOp(s, req.Path, roots, log)
	case "download":
		downloadOp(s, req.Path, log)
	case "upload":
		uploadOp(s, req.Path, req.UploadSize, roots, req.Overwrite, log)
	case "mkdir":
		mkdirOp(s, req.Path, roots, log)
	case "rename":
		renameOp(s, req.Path, req.Target, roots, log)
	default:
		writeResponse(s, tunnel.FileManagerResponse{Error: "unsupported op " + req.Op}, log)
	}
}

type bufferedStream struct {
	tunnel.StreamConn
	reader *bufio.Reader
}

func (s *bufferedStream) Read(p []byte) (int, error) { return s.reader.Read(p) }

func rootsOp(w io.Writer, roots []string, log *slog.Logger) {
	vols := volumes()
	seen := make(map[string]bool)
	out := make([]tunnel.FileManagerRoot, 0, len(vols)+len(roots))
	for _, v := range vols {
		seen[strings.ToLower(v)] = true
		out = append(out, tunnel.FileManagerRoot{Path: v, Label: v, Kind: "volume", Writable: isWritable(v, roots)})
	}
	for _, r := range roots {
		if seen[strings.ToLower(r)] {
			continue
		}
		seen[strings.ToLower(r)] = true
		out = append(out, tunnel.FileManagerRoot{Path: r, Label: r, Kind: "root", Writable: true})
	}
	writeResponse(w, tunnel.FileManagerResponse{OK: true, Roots: out}, log)
}

func listOp(w io.Writer, rawPath string, roots []string, log *slog.Logger) {
	path, err := cleanAbs(rawPath)
	if err != nil {
		writeResponse(w, tunnel.FileManagerResponse{Error: err.Error()}, log)
		return
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		writeResponse(w, tunnel.FileManagerResponse{Error: "list: " + err.Error(), Path: path}, log)
		return
	}
	out := make([]tunnel.FileManagerEntry, 0, len(entries))
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		out = append(out, tunnel.FileManagerEntry{
			Name:     entry.Name(),
			Path:     filepath.Join(path, entry.Name()),
			Dir:      entry.IsDir(),
			Size:     info.Size(),
			Mode:     info.Mode().String(),
			Modified: info.ModTime().UTC().Format(time.RFC3339),
			Symlink:  entry.Type()&os.ModeSymlink != 0,
		})
	}
	writeResponse(w, tunnel.FileManagerResponse{OK: true, Path: path, Entries: out}, log)
}

func downloadOp(w io.Writer, rawPath string, log *slog.Logger) {
	path, err := cleanAbs(rawPath)
	if err != nil {
		writeResponse(w, tunnel.FileManagerResponse{Error: err.Error()}, log)
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		writeResponse(w, tunnel.FileManagerResponse{Error: "stat: " + err.Error(), Path: path}, log)
		return
	}
	if info.IsDir() {
		if !writeResponse(w, tunnel.FileManagerResponse{OK: true, Path: path, Archive: true}, log) {
			return
		}
		if err := writeArchive(w, path); err != nil {
			log.Warn("filemanager: archive", slog.String("path", path), slog.Any("err", err))
		}
		return
	}
	if !writeResponse(w, tunnel.FileManagerResponse{OK: true, Path: path, Size: info.Size()}, log) {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		log.Warn("filemanager: open", slog.String("path", path), slog.Any("err", err))
		return
	}
	defer f.Close()
	if _, err := io.CopyN(w, f, info.Size()); err != nil {
		log.Warn("filemanager: stream", slog.String("path", path), slog.Any("err", err))
	}
}

func writeArchive(w io.Writer, root string) error {
	gz := gzip.NewWriter(w)
	defer gz.Close()
	tw := tar.NewWriter(gz)
	defer tw.Close()
	base := filepath.Base(root)
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		name := filepath.ToSlash(filepath.Join(base, rel))
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return nil
		}
		hdr.Name = name
		if entry.IsDir() {
			hdr.Name += "/"
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return nil
		}
		_, copyErr := io.CopyN(tw, f, info.Size())
		_ = f.Close()
		return copyErr
	})
}

func uploadOp(w io.ReadWriter, rawPath string, size int64, roots []string, overwrite bool, log *slog.Logger) {
	path, err := cleanAbs(rawPath)
	if err != nil {
		writeResponse(w, tunnel.FileManagerResponse{Error: err.Error()}, log)
		return
	}
	if size < 0 || size > MaxUploadSize {
		writeResponse(w, tunnel.FileManagerResponse{Error: "invalid size"}, log)
		return
	}
	if err := ensureWritable(path, roots); err != nil {
		drain(w, size)
		writeResponse(w, tunnel.FileManagerResponse{Error: err.Error(), Path: path}, log)
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		drain(w, size)
		writeResponse(w, tunnel.FileManagerResponse{Error: "create parent: " + err.Error(), Path: path}, log)
		return
	}
	flags := os.O_CREATE | os.O_WRONLY
	if overwrite {
		flags |= os.O_TRUNC
	} else {
		flags |= os.O_EXCL
	}
	f, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		drain(w, size)
		writeResponse(w, tunnel.FileManagerResponse{Error: "open: " + err.Error(), Path: path}, log)
		return
	}
	defer f.Close()
	if _, err := io.CopyN(f, w, size); err != nil {
		writeResponse(w, tunnel.FileManagerResponse{Error: "receive: " + err.Error(), Path: path}, log)
		return
	}
	if err := f.Sync(); err != nil {
		writeResponse(w, tunnel.FileManagerResponse{Error: "sync: " + err.Error(), Path: path}, log)
		return
	}
	writeResponse(w, tunnel.FileManagerResponse{OK: true, Path: path, Size: size}, log)
}

func mkdirOp(w io.Writer, rawPath string, roots []string, log *slog.Logger) {
	path, err := cleanAbs(rawPath)
	if err != nil {
		writeResponse(w, tunnel.FileManagerResponse{Error: err.Error()}, log)
		return
	}
	if err := ensureWritable(path, roots); err != nil {
		writeResponse(w, tunnel.FileManagerResponse{Error: err.Error(), Path: path}, log)
		return
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		writeResponse(w, tunnel.FileManagerResponse{Error: "mkdir: " + err.Error(), Path: path}, log)
		return
	}
	writeResponse(w, tunnel.FileManagerResponse{OK: true, Path: path}, log)
}

func renameOp(w io.Writer, rawFrom, rawTo string, roots []string, log *slog.Logger) {
	from, err := cleanAbs(rawFrom)
	if err != nil {
		writeResponse(w, tunnel.FileManagerResponse{Error: err.Error()}, log)
		return
	}
	to, err := cleanAbs(rawTo)
	if err != nil {
		writeResponse(w, tunnel.FileManagerResponse{Error: err.Error()}, log)
		return
	}
	if err := ensureWritable(from, roots); err != nil {
		writeResponse(w, tunnel.FileManagerResponse{Error: err.Error(), Path: from}, log)
		return
	}
	if err := ensureWritable(to, roots); err != nil {
		writeResponse(w, tunnel.FileManagerResponse{Error: err.Error(), Path: to}, log)
		return
	}
	if _, err := os.Stat(to); err == nil {
		writeResponse(w, tunnel.FileManagerResponse{Error: "target already exists", Path: to}, log)
		return
	}
	if err := os.Rename(from, to); err != nil {
		writeResponse(w, tunnel.FileManagerResponse{Error: "rename: " + err.Error()}, log)
		return
	}
	writeResponse(w, tunnel.FileManagerResponse{OK: true, Path: to}, log)
}

func cleanAbs(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.ContainsRune(raw, 0) {
		return "", errors.New("empty or invalid path")
	}
	if !filepath.IsAbs(raw) {
		return "", errors.New("path must be absolute")
	}
	clean := filepath.Clean(raw)
	if runtime.GOOS == "windows" {
		if strings.HasPrefix(clean, `\\`) || strings.HasPrefix(clean, `//`) {
			return "", errors.New("UNC paths are not supported")
		}
		if filepath.VolumeName(clean) == "" {
			return "", errors.New("path must include a drive")
		}
	}
	return clean, nil
}

func writableRoots(extra []string) []string {
	roots := []string{filepath.Clean(filetransfer.Dir())}
	for _, r := range extra {
		r = strings.TrimSpace(r)
		if r == "" || !filepath.IsAbs(r) {
			continue
		}
		roots = append(roots, filepath.Clean(r))
	}
	return roots
}

func isWritable(path string, roots []string) bool {
	for _, root := range roots {
		if within(root, path) {
			return true
		}
	}
	return false
}

func ensureWritable(path string, roots []string) error {
	if isWritable(path, roots) {
		return nil
	}
	// Resolve symlinks in the parent so a junction inside a writable root
	// cannot redirect a write outside it.
	parent := filepath.Dir(path)
	resolvedParent, err := filepath.EvalSymlinks(parent)
	if err == nil {
		for _, root := range roots {
			if resolvedRoot, rerr := filepath.EvalSymlinks(root); rerr == nil && within(resolvedRoot, resolvedParent) {
				return nil
			}
		}
	}
	return fmt.Errorf("path %q is outside the writable roots", path)
}

func within(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func drain(r io.Reader, size int64) {
	if size > 0 && size <= MaxUploadSize {
		_, _ = io.CopyN(io.Discard, r, size)
	}
}

func writeResponse(w io.Writer, resp tunnel.FileManagerResponse, log *slog.Logger) bool {
	data, err := json.Marshal(resp)
	if err != nil {
		return false
	}
	if _, err := fmt.Fprintf(w, "%s%s\n", tunnel.FileManagerResponsePrefix, data); err != nil {
		if log != nil {
			log.Warn("filemanager: write response", slog.Any("err", err))
		}
		return false
	}
	return true
}
