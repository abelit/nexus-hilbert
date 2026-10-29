package objectstore

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"strings"
)

// Local stores objects under a single directory. The directory may be an
// operator-configured path or the CMDB data volume default; it is created on
// startup and every key is checked to stay below it.
type Local struct {
	root string
}

// NewLocal opens (and creates) the local object root. A relative or empty path
// is refused: an empty root would resolve to the process working directory and
// silently widen the traversal guard.
func NewLocal(root string) (*Local, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, errors.New("objectstore: local path is required")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("objectstore: local path: %w", err)
	}
	if err := os.MkdirAll(abs, 0o750); err != nil {
		return nil, fmt.Errorf("objectstore: create local path: %w", err)
	}
	return &Local{root: abs}, nil
}

// resolveKey turns a slash-separated logical key into an absolute path below
// the root. filepath.IsLocal rejects absolute paths and any ".." component;
// the Rel check is belt-and-braces for platform-specific separators.
func (l *Local) resolveKey(key string) (string, error) {
	key = strings.TrimSpace(key)
	if key == "" || strings.HasPrefix(key, "/") || !filepath.IsLocal(filepath.FromSlash(key)) {
		return "", fmt.Errorf("objectstore: invalid object key %q", key)
	}
	path := filepath.Join(l.root, filepath.FromSlash(key))
	rel, err := filepath.Rel(l.root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("objectstore: object key escapes root: %q", key)
	}
	return path, nil
}

func contentTypeFor(key string) string {
	if ct := mime.TypeByExtension(filepath.Ext(key)); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

// Put writes to a temporary file beside the destination and renames it into
// place, so a reader never observes a partially written object.
func (l *Local) Put(_ context.Context, key string, r io.Reader, size int64, contentType string) (Object, error) {
	if size < 0 {
		return Object{}, errors.New("objectstore: size must be non-negative")
	}
	path, err := l.resolveKey(key)
	if err != nil {
		return Object{}, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return Object{}, fmt.Errorf("objectstore: create object directory: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".upload-*")
	if err != nil {
		return Object{}, fmt.Errorf("objectstore: create temp object: %w", err)
	}
	tmpName := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	written, err := io.Copy(tmp, r)
	if err != nil {
		cleanup()
		return Object{}, fmt.Errorf("objectstore: write object: %w", err)
	}
	if written != size {
		cleanup()
		return Object{}, fmt.Errorf("objectstore: wrote %d bytes, expected %d", written, size)
	}
	if err := tmp.Chmod(0o640); err != nil {
		cleanup()
		return Object{}, fmt.Errorf("objectstore: chmod object: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return Object{}, fmt.Errorf("objectstore: close object: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return Object{}, fmt.Errorf("objectstore: publish object: %w", err)
	}
	if contentType == "" {
		contentType = contentTypeFor(key)
	}
	return Object{Key: key, Size: written, ContentType: contentType}, nil
}

func (l *Local) Get(_ context.Context, key string) (io.ReadCloser, Object, error) {
	path, err := l.resolveKey(key)
	if err != nil {
		return nil, Object{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, Object{}, fmt.Errorf("objectstore: open object: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, Object{}, fmt.Errorf("objectstore: stat object: %w", err)
	}
	if info.IsDir() {
		_ = file.Close()
		return nil, Object{}, fmt.Errorf("objectstore: %q is a directory", key)
	}
	return file, Object{Key: key, Size: info.Size(), ContentType: contentTypeFor(key)}, nil
}

func (l *Local) Delete(_ context.Context, key string) error {
	path, err := l.resolveKey(key)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("objectstore: delete object: %w", err)
	}
	return nil
}

func (l *Local) Stat(_ context.Context, key string) (Object, error) {
	path, err := l.resolveKey(key)
	if err != nil {
		return Object{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return Object{}, fmt.Errorf("objectstore: stat object: %w", err)
	}
	if info.IsDir() {
		return Object{}, fmt.Errorf("objectstore: %q is a directory", key)
	}
	return Object{Key: key, Size: info.Size(), ContentType: contentTypeFor(key)}, nil
}

func (l *Local) Health(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	file, err := os.CreateTemp(l.root, ".health-*")
	if err != nil {
		return fmt.Errorf("objectstore: local path is not writable: %w", err)
	}
	name := file.Name()
	_ = file.Close()
	_ = os.Remove(name)
	return nil
}
