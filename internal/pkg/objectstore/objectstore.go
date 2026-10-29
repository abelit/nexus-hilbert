// Package objectstore is the small object-store abstraction used by the CMDB
// file attachments. It supports the two deployments the product ships with:
// a directory on the CMDB data volume and an S3-compatible endpoint (MinIO,
// Ceph, or S3 itself).
//
// It is deliberately independent of the CMDB domain: the callers own naming,
// metadata, authorization and retention. This package owns only bytes, keys,
// and the path-traversal guard.
package objectstore

import (
	"context"
	"io"
)

// Object describes one stored object.
type Object struct {
	Key         string
	Size        int64
	ContentType string
}

// Backend is the consumer-side interface implemented by Local and S3.
type Backend interface {
	// Put writes exactly size bytes from r. A short or long read is an error.
	Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) (Object, error)
	// Get opens an object for reading. The caller closes the returned reader.
	Get(ctx context.Context, key string) (io.ReadCloser, Object, error)
	// Delete removes an object. A missing object is not an error.
	Delete(ctx context.Context, key string) error
	// Stat returns metadata without opening the object.
	Stat(ctx context.Context, key string) (Object, error)
	// Health checks that the backend is usable. It is used by the settings
	// "test connection" action, not by the process readiness probe.
	Health(ctx context.Context) error
}
