package webshell

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	edgefm "github.com/ongridio/ongrid/internal/edgeagent/filemanager"
)

type fmStreamer struct{}

func (fmStreamer) OpenStream(ctx context.Context, _ uint64) (io.ReadWriteCloser, error) {
	managerSide, edgeSide := net.Pipe()
	go edgefm.HandleStream(pipeConn{Conn: edgeSide}, slog.Default())
	return managerSide, nil
}

func newFMTestServer(t *testing.T, writableRoot string) *httptest.Server {
	t.Helper()
	sandbox := t.TempDir()
	t.Setenv("ONGRID_EDGE_TRANSFER_DIR", sandbox)
	h := &Handler{
		tickets:    map[string]shellTicket{},
		failures:   map[string]authFailures{},
		streamer:   fmStreamer{},
		devices:    fileFakeDevices{},
		edges:      fileFakeEdges{},
		log:              slog.Default(),
		writeRoots:       func(context.Context) []string { return []string{writableRoot} },
		maxUploadBytesFn: func(context.Context) int64 { return 8 << 30 },
	}
	r := chi.NewRouter()
	r.Get("/v1/devices/{device_id}/fm/roots", h.fmRoots)
	r.Get("/v1/devices/{device_id}/fm/list", h.fmList)
	r.Get("/v1/devices/{device_id}/fm/download", h.fmDownload)
	r.Post("/v1/devices/{device_id}/fm/upload", h.fmUpload)
	r.Post("/v1/devices/{device_id}/fm/mkdir", h.fmMkdir)
	r.Post("/v1/devices/{device_id}/fm/rename", h.fmRename)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv
}

func TestFileManagerRejectsUploadAboveConfiguredLimit(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ONGRID_EDGE_TRANSFER_DIR", t.TempDir())
	var logBuf bytes.Buffer
	h := &Handler{
		tickets:          map[string]shellTicket{},
		failures:         map[string]authFailures{},
		streamer:         fmStreamer{},
		devices:          fileFakeDevices{},
		edges:            fileFakeEdges{},
		log:              slog.New(slog.NewTextHandler(&logBuf, nil)),
		writeRoots:       func(context.Context) []string { return []string{root} },
		maxUploadBytesFn: func(context.Context) int64 { return 4 },
	}
	r := chi.NewRouter()
	r.Post("/v1/devices/{device_id}/fm/upload", h.fmUpload)
	srv := httptest.NewServer(r)
	defer srv.Close()

	url := srv.URL + "/v1/devices/42/fm/upload?path=" + url.QueryEscape(filepath.Join(root, "a.bin"))
	res, err := http.Post(url, "application/octet-stream", bytes.NewReader([]byte("12345")))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", res.StatusCode)
	}
	if _, statErr := os.Stat(filepath.Join(root, "a.bin")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("file written despite rejection: %v", statErr)
	}
	audit := logBuf.String()
	if !strings.Contains(audit, "op=upload") || !strings.Contains(audit, "ok=false") {
		t.Fatalf("missing rejection audit: %s", audit)
	}

	res, err = http.Post(url, "application/octet-stream", bytes.NewReader([]byte("1234")))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("at-limit status = %d, want 200", res.StatusCode)
	}
}

func TestFileManagerUsesInjectedWriteRoots(t *testing.T) {
	root := t.TempDir()
	srv := newFMTestServer(t, root)
	res, err := http.Get(srv.URL + "/v1/devices/42/fm/roots")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK || !bytes.Contains(body, []byte(root)) {
		t.Fatalf("roots status=%d body=%s", res.StatusCode, body)
	}
}

func TestFileManagerRoundTrip(t *testing.T) {
	root := t.TempDir()
	srv := newFMTestServer(t, root)

	res, err := http.Get(srv.URL + "/v1/devices/42/fm/roots")
	if err != nil {
		t.Fatal(err)
	}
	rootsBody, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || !bytes.Contains(rootsBody, []byte(root)) {
		t.Fatalf("roots status=%d body=%s", res.StatusCode, rootsBody)
	}

	if err := os.MkdirAll(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	payload := []byte("managed-file")
	uploadURL := srv.URL + "/v1/devices/42/fm/upload?path=" + url.QueryEscape(filepath.Join(root, "docs", "a.txt"))
	res, err = http.Post(uploadURL, "application/octet-stream", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("upload status = %d", res.StatusCode)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "docs", "a.txt")); !bytes.Equal(got, payload) {
		t.Fatalf("file = %q", got)
	}

	res, err = http.Get(srv.URL + "/v1/devices/42/fm/list?path=" + url.QueryEscape(filepath.Join(root, "docs")))
	if err != nil {
		t.Fatal(err)
	}
	listBody, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || !bytes.Contains(listBody, []byte("a.txt")) {
		t.Fatalf("list status=%d body=%s", res.StatusCode, listBody)
	}

	res, err = http.Get(srv.URL + "/v1/devices/42/fm/download?path=" + url.QueryEscape(filepath.Join(root, "docs", "a.txt")))
	if err != nil {
		t.Fatal(err)
	}
	downloaded, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || !bytes.Equal(downloaded, payload) {
		t.Fatalf("download status=%d body=%q", res.StatusCode, downloaded)
	}

	res, err = http.Get(srv.URL + "/v1/devices/42/fm/download?path=" + url.QueryEscape(filepath.Join(root, "docs")))
	if err != nil {
		t.Fatal(err)
	}
	archive, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || len(archive) < 2 || archive[0] != 0x1f || archive[1] != 0x8b {
		t.Fatalf("archive status=%d bytes=%x", res.StatusCode, archive[:min(4, len(archive))])
	}
	if _, err := gzip.NewReader(bytes.NewReader(archive)); err != nil {
		t.Fatalf("gzip: %v", err)
	}
}

func TestFileManagerWritesOutsideRootsRejected(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	srv := newFMTestServer(t, root)

	res, err := http.Post(
		srv.URL+"/v1/devices/42/fm/upload?path="+url.QueryEscape(filepath.Join(outside, "x.txt")),
		"application/octet-stream",
		bytes.NewReader([]byte("x")),
	)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("upload outside roots status = %d", res.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(outside, "x.txt")); err == nil {
		t.Fatal("file written outside roots")
	}

	res, err = http.Post(
		srv.URL+"/v1/devices/42/fm/mkdir?path="+url.QueryEscape(filepath.Join(outside, "new")),
		"application/octet-stream", nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("mkdir outside roots status = %d", res.StatusCode)
	}
}

func TestFileManagerMkdirRename(t *testing.T) {
	root := t.TempDir()
	srv := newFMTestServer(t, root)
	from := filepath.Join(root, "old.txt")
	if err := os.WriteFile(from, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err := http.Post(srv.URL+"/v1/devices/42/fm/mkdir?path="+url.QueryEscape(filepath.Join(root, "newdir")), "application/octet-stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("mkdir status = %d", res.StatusCode)
	}
	to := filepath.Join(root, "newdir", "new.txt")
	res, err = http.Post(srv.URL+"/v1/devices/42/fm/rename?from="+url.QueryEscape(from)+"&to="+url.QueryEscape(to), "application/octet-stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("rename status = %d", res.StatusCode)
	}
	if _, err := os.Stat(to); err != nil {
		t.Fatalf("renamed file missing: %v", err)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
