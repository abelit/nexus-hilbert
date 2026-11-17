package webshell

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
)

// streamerFunc adapts a function to the narrow Streamer interface.
type streamerFunc func(ctx context.Context, edgeID uint64) (io.ReadWriteCloser, error)

func (f streamerFunc) OpenStream(ctx context.Context, edgeID uint64) (io.ReadWriteCloser, error) {
	return f(ctx, edgeID)
}

// TestOpenVNCBridgesWebSocketToLoopbackPreface locks the bytes-on-the-wire
// contract: the manager writes the ONGRID-TARGET preface first, then relays
// WebSocket binary frames to the tunnel stream in both directions.
func TestOpenVNCBridgesWebSocketToLoopbackPreface(t *testing.T) {
	edgeSide, targetSide := net.Pipe()
	defer edgeSide.Close()
	defer targetSide.Close()

	h := &Handler{
		tickets:  map[string]shellTicket{},
		failures: map[string]authFailures{},
		streamer: streamerFunc(func(context.Context, uint64) (io.ReadWriteCloser, error) {
			return edgeSide, nil
		}),
		upgrader: websocket.Upgrader{CheckOrigin: sameOrigin},
		log:      slog.Default(),
	}
	token, _, err := h.mintTicket(shellTicket{Kind: "vnc", DeviceID: 42, EdgeID: 7, ClientIP: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}

	r := chi.NewRouter()
	r.Get("/v1/devices/{device_id}/vnc", h.openVNC)
	srv := httptest.NewServer(r)
	defer srv.Close()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	header := http.Header{"Origin": []string{"http://" + u.Host}}
	ws, resp, err := websocket.DefaultDialer.Dial("ws://"+u.Host+"/v1/devices/42/vnc?ticket="+token, header)
	if err != nil {
		t.Fatalf("dial: %v (resp %v)", err, resp)
	}
	defer ws.Close()

	readTarget := func() []byte {
		t.Helper()
		ch := make(chan []byte, 1)
		go func() {
			buf := make([]byte, 64)
			n, err := targetSide.Read(buf)
			if err != nil {
				ch <- nil
				return
			}
			ch <- buf[:n]
		}()
		select {
		case got := <-ch:
			if got == nil {
				t.Fatal("edge stream closed while reading")
			}
			return got
		case <-time.After(3 * time.Second):
			t.Fatal("timed out waiting for edge stream bytes")
			return nil
		}
	}

	if got, want := string(readTarget()), "ONGRID-TARGET 127.0.0.1:5900\n"; got != want {
		t.Fatalf("preface = %q, want %q", got, want)
	}

	if err := ws.WriteMessage(websocket.BinaryMessage, []byte("RFB 003.008\n")); err != nil {
		t.Fatal(err)
	}
	if got, want := string(readTarget()), "RFB 003.008\n"; got != want {
		t.Fatalf("client bytes = %q, want %q", got, want)
	}

	if _, err := targetSide.Write([]byte("RFB 003.008\n")); err != nil {
		t.Fatal(err)
	}
	_ = ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	msgType, payload, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("read server frame: %v", err)
	}
	if msgType != websocket.BinaryMessage {
		t.Fatalf("frame type = %d, want binary", msgType)
	}
	if string(payload) != "RFB 003.008\n" {
		t.Fatalf("server bytes = %q", payload)
	}
}

func TestOpenVNCRejectsNonVNCTicket(t *testing.T) {
	h := &Handler{tickets: map[string]shellTicket{}, failures: map[string]authFailures{}}
	token, _, err := h.mintTicket(shellTicket{Kind: "shell", DeviceID: 42, ClientIP: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Get("/v1/devices/{device_id}/vnc", h.openVNC)
	req := httptest.NewRequest(http.MethodGet, "/v1/devices/42/vnc?ticket="+token, nil)
	req.Host = "ops.example"
	req.Header.Set("Origin", "http://ops.example")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}
