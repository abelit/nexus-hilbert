package main

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ongridio/ongrid/internal/pkg/tunnel"
)

type fakeStream struct {
	r    io.Reader
	w    bytes.Buffer
	meta []byte
}

func (s *fakeStream) Read(p []byte) (int, error)  { return s.r.Read(p) }
func (s *fakeStream) Write(p []byte) (int, error) { return s.w.Write(p) }
func (s *fakeStream) Close() error                { return nil }
func (s *fakeStream) Meta() []byte                { return s.meta }

var _ tunnel.StreamConn = (*fakeStream)(nil)

func TestDispatchStreamRoutesFilePreface(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("ONGRID_EDGE_TRANSFER_DIR", dir)
	if err := os.WriteFile(filepath.Join(dir, "report.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}

	stream := &fakeStream{r: strings.NewReader(tunnel.FileStreamPreface + `{"op":"list"}` + "\n")}
	dispatchStream(stream, slog.Default(), slog.Default(), slog.Default())

	out := stream.w.String()
	if !strings.HasPrefix(out, tunnel.FileStreamResponsePrefix) {
		t.Fatalf("response = %q", out)
	}
	if !strings.Contains(out, "report.txt") {
		t.Fatalf("list missing file: %q", out)
	}
}

func TestDispatchStreamIgnoresMalformedPreface(t *testing.T) {
	stream := &fakeStream{r: strings.NewReader("")}
	dispatchStream(stream, slog.Default(), slog.Default(), slog.Default())
	if stream.w.Len() != 0 {
		t.Fatalf("unexpected response %q", stream.w.String())
	}
	_ = http.StatusOK
}
