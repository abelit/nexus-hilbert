package webshell

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"

	edgefile "github.com/ongridio/ongrid/internal/edgeagent/filetransfer"
	devicebiz "github.com/ongridio/ongrid/internal/manager/biz/device"
	edgebiz "github.com/ongridio/ongrid/internal/manager/biz/edge"
	devicemodel "github.com/ongridio/ongrid/internal/manager/model/device"
	edgemodel "github.com/ongridio/ongrid/internal/manager/model/edge"
)

type pipeConn struct{ net.Conn }

func (pipeConn) Meta() []byte { return nil }

// edgeStreamer pairs the Manager stream with the real edge file handler.
type edgeStreamer struct{}

func (edgeStreamer) OpenStream(ctx context.Context, _ uint64) (io.ReadWriteCloser, error) {
	managerSide, edgeSide := net.Pipe()
	go edgefile.HandleStream(pipeConn{Conn: edgeSide}, slog.Default())
	return managerSide, nil
}

type fileFakeDevices struct{ devicebiz.Repo }

func (fileFakeDevices) Get(context.Context, uint64) (*devicemodel.Device, error) {
	edgeID := uint64(7)
	return &devicemodel.Device{ID: 42, OS: "windows", CurrentEdgeID: &edgeID}, nil
}

type fileFakeEdges struct{ edgebiz.Repo }

func (fileFakeEdges) GetByID(context.Context, uint64) (*edgemodel.Edge, error) {
	deviceID := uint64(42)
	return &edgemodel.Edge{ID: 7, DeviceID: &deviceID, Status: edgemodel.StatusOnline}, nil
}

func newFileTestServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("ONGRID_EDGE_TRANSFER_DIR", dir)
	h := &Handler{
		tickets:  map[string]shellTicket{},
		failures: map[string]authFailures{},
		streamer: edgeStreamer{},
		devices:  fileFakeDevices{},
		edges:    fileFakeEdges{},
		log:      slog.Default(),
	}
	r := chi.NewRouter()
	r.Get("/v1/devices/{device_id}/files", h.listFiles)
	r.Post("/v1/devices/{device_id}/files", h.uploadFile)
	r.Get("/v1/devices/{device_id}/files/{name}", h.downloadFile)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv, dir
}

func TestDeviceFileRoundTrip(t *testing.T) {
	srv, dir := newFileTestServer(t)
	payload := []byte("file-channel-payload")

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/v1/devices/42/files?name=report.txt", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("upload status = %d", res.StatusCode)
	}
	got, err := os.ReadFile(filepath.Join(dir, "report.txt"))
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("uploaded file = %q, err=%v", got, err)
	}

	res, err = http.Get(srv.URL + "/v1/devices/42/files")
	if err != nil {
		t.Fatal(err)
	}
	listBody, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || !bytes.Contains(listBody, []byte("report.txt")) {
		t.Fatalf("list status=%d body=%s", res.StatusCode, listBody)
	}

	res, err = http.Get(srv.URL + "/v1/devices/42/files/report.txt")
	if err != nil {
		t.Fatal(err)
	}
	downloaded, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || !bytes.Equal(downloaded, payload) {
		t.Fatalf("download status=%d body=%q", res.StatusCode, downloaded)
	}
	if res.Header.Get("Content-Disposition") == "" {
		t.Fatal("missing Content-Disposition")
	}
}

func TestDeviceFileRejectsTraversal(t *testing.T) {
	srv, dir := newFileTestServer(t)
	res, err := http.Post(srv.URL+"/v1/devices/42/files?name=../escape.txt", "application/octet-stream", bytes.NewReader([]byte("x")))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("traversal upload status = %d", res.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "escape.txt")); err == nil {
		t.Fatal("file escaped the sandbox")
	}
}

func TestDeviceFileRequiresContentLength(t *testing.T) {
	srv, _ := newFileTestServer(t)
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/devices/42/files?name=x.txt", io.NopCloser(bytes.NewReader([]byte("x"))))
	req.ContentLength = -1
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d", res.StatusCode)
	}
}
