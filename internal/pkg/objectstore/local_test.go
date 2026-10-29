package objectstore

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalRoundTripAndTraversalGuard(t *testing.T) {
	root := t.TempDir()
	backend, err := NewLocal(root)
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}
	ctx := context.Background()
	key := "2026/10/29/abc_report.txt"
	object, err := backend.Put(ctx, key, strings.NewReader("hello"), 5, "text/plain")
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if object.Size != 5 || object.ContentType != "text/plain" {
		t.Fatalf("object = %+v", object)
	}
	reader, got, err := backend.Get(ctx, key)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	defer reader.Close()
	data, _ := io.ReadAll(reader)
	if string(data) != "hello" || got.Size != 5 {
		t.Fatalf("read %q, object %+v", data, got)
	}
	if err := backend.Delete(ctx, key); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := backend.Stat(ctx, key); err == nil {
		t.Fatal("Stat succeeded after delete")
	}

	for _, bad := range []string{"../escape.txt", "/abs.txt", "a/../../escape.txt"} {
		if _, err := backend.Put(ctx, bad, strings.NewReader("x"), 1, "text/plain"); err == nil {
			t.Fatalf("Put accepted traversal key %q", bad)
		}
	}
}

func TestLocalRejectsShortWrites(t *testing.T) {
	backend, err := NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := backend.Put(context.Background(), "a/b.txt", strings.NewReader("x"), 2, "text/plain"); err == nil {
		t.Fatal("Put accepted a short body")
	}
}

func TestLocalHealth(t *testing.T) {
	backend, err := NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := backend.Health(context.Background()); err != nil {
		t.Fatalf("Health: %v", err)
	}
	if _, err := NewLocal(""); err == nil {
		t.Fatal("NewLocal accepted an empty root")
	}
	root := filepath.Join(t.TempDir(), "nested")
	if _, err := os.Stat(root); err == nil {
		// not created by t.TempDir; NewLocal must create it
		t.Fatal("unexpected pre-existing path")
	}
	if _, err := NewLocal(root); err != nil {
		t.Fatalf("NewLocal nested: %v", err)
	}
}
