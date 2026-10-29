package objectstore

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// SigV4 hashes and rewinds the payload for plain-HTTP endpoints. A body that
// does not implement io.Seeker (io.MultiReader, a multipart adapter, ...) used
// to fail before the request was sent.
func TestS3PutAcceptsNonSeekableBody(t *testing.T) {
	const payload = "hello world"
	var got []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimSuffix(r.URL.Path, "/")
		switch {
		case r.Method == http.MethodHead && path == "/test-bucket":
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodPut && r.URL.Path == "/test-bucket/file.txt":
			body, err := io.ReadAll(r.Body)
			if err != nil {
				t.Errorf("read body: %v", err)
			}
			got = body
			w.Header().Set("ETag", `"test"`)
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	backend, err := NewS3(S3Config{
		Endpoint:  server.URL,
		AccessKey: "ak",
		SecretKey: "sk",
		Bucket:    "test-bucket",
		Region:    "us-east-1",
	})
	if err != nil {
		t.Fatalf("NewS3: %v", err)
	}
	body := io.MultiReader(strings.NewReader("hello "), strings.NewReader("world"))
	object, err := backend.Put(context.Background(), "file.txt", body, int64(len(payload)), "text/plain")
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if string(got) != payload {
		t.Fatalf("server body = %q", got)
	}
	if object.Size != int64(len(payload)) || object.ContentType != "text/plain" {
		t.Fatalf("object = %+v", object)
	}
}

func TestEnsureSeekableKeepsSeekableReader(t *testing.T) {
	original := bytes.NewReader([]byte("abc"))
	body, cleanup, err := ensureSeekable(original, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if body != original {
		t.Fatalf("seekable reader was replaced: %T", body)
	}
}

func TestEnsureSeekableSpoolsOversizedBody(t *testing.T) {
	payload := bytes.Repeat([]byte("x"), maxMemorySpool+1)
	body := io.MultiReader(
		bytes.NewReader(payload[:100]),
		bytes.NewReader(payload[100:]),
	)
	reader, cleanup, err := ensureSeekable(body, int64(len(payload)))
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	got, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("spooled %d bytes, want %d", len(got), len(payload))
	}
}
