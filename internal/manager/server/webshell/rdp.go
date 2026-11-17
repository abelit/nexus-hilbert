package webshell

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"github.com/ongridio/ongrid/internal/pkg/errs"
	"github.com/ongridio/ongrid/internal/pkg/tenantctx"
)

// RDP access for Windows edges through IronRDP's RDCleanPath protocol.
//
// The browser cannot open raw TCP, and RDP needs TLS to the server. IronRDP's
// web client therefore delegates the TCP (and TLS) leg to a proxy: it sends an
// RDCleanPath PDU carrying the X.224 connection request, the proxy plays that
// against the RDP server, performs the TLS handshake, and returns the X.224
// connection confirm plus the server certificate chain. From then on the
// WebSocket carries plaintext RDP bytes, which the WASM client re-protects with
// CredSSP and WSS.
//
// The proxy never dials a host supplied by the browser: the target is always
// the device loopback 127.0.0.1:3389 reached through the edge stream.

const rdpLoopbackTarget = "127.0.0.1:3389"

// rdpTicket mints a one-time ticket for an RDP session. Credentials are typed
// in the browser and travel inside CredSSP; the Manager never receives them.
func (h *Handler) rdpTicket(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenantctx.From(r.Context())
	if !ok {
		writeErr(w, errs.ErrUnauthorized)
		return
	}
	deviceID, err := parseUintParam(r, "device_id")
	if err != nil {
		writeErr(w, err)
		return
	}
	device, err := h.devices.Get(r.Context(), deviceID)
	if err != nil {
		writeErr(w, fmt.Errorf("resolve device: %w", err))
		return
	}
	if !strings.EqualFold(strings.TrimSpace(device.OS), "windows") {
		writeErr(w, fmt.Errorf("%w: RDP is only available on Windows devices", errs.ErrInvalid))
		return
	}
	edgeRow, err := h.onlineEdge(r.Context(), deviceID)
	if err != nil {
		writeErr(w, err)
		return
	}
	token, expiresAt, err := h.mintTicket(shellTicket{
		Kind: "rdp", UserID: tenant.UserID, DeviceID: deviceID, EdgeID: edgeRow.ID,
		Port: 3389, ClientIP: clientIP(r),
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	h.log.Info("rdp ticket issued",
		slog.Uint64("device_id", deviceID),
		slog.Uint64("edge_id", edgeRow.ID),
		slog.Uint64("user_id", tenant.UserID),
	)
	writeJSON(w, http.StatusOK, map[string]any{"ticket": token, "expires_at": expiresAt})
}

// openRDP is the RDCleanPath WebSocket endpoint. It is public at the router
// level because the one-time ticket is the only credential; the ticket kind
// keeps shell/VNC tickets from opening an RDP session.
func (h *Handler) openRDP(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		http.Error(w, "websocket origin not allowed", http.StatusForbidden)
		return
	}
	deviceID, err := parseUintParam(r, "device_id")
	if err != nil {
		writeErr(w, err)
		return
	}
	ticketToken := r.URL.Query().Get("ticket")
	ticket, ok := h.consumeTicket(ticketToken, deviceID, clientIP(r))
	if !ok || ticket.Kind != "rdp" {
		http.Error(w, "invalid or expired RDP ticket", http.StatusUnauthorized)
		return
	}
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.log.Warn("rdp: upgrade", slog.Any("err", err))
		return
	}
	defer conn.Close()

	h.log.Info("rdp session started",
		slog.Uint64("device_id", deviceID),
		slog.Uint64("edge_id", ticket.EdgeID),
		slog.Uint64("user_id", ticket.UserID),
	)
	defer h.log.Info("rdp session ended",
		slog.Uint64("device_id", deviceID),
		slog.Uint64("user_id", ticket.UserID),
	)

	h.serveRDP(r.Context(), conn, ticket, ticketToken)
}

func (h *Handler) serveRDP(ctx context.Context, conn *websocket.Conn, ticket shellTicket, ticketToken string) {
	// The browser only needs to survive the handshake phase under this
	// deadline; the relay that follows is bounded by the session itself.
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	req, err := readRDCleanPathRequest(conn)
	if err != nil {
		h.log.Warn("rdp: read RDCleanPath request", slog.Any("err", err))
		return
	}
	if req.ProxyAuth != "" && req.ProxyAuth != ticketToken {
		h.log.Warn("rdp: proxy auth mismatch",
			slog.Uint64("device_id", ticket.DeviceID),
			slog.Uint64("user_id", ticket.UserID))
		_ = conn.WriteMessage(websocket.BinaryMessage, encodeRDCleanPathError(rdpCleanPathError{
			Code:       rdcleanPathErrGeneral,
			HTTPStatus: http.StatusUnauthorized,
		}))
		return
	}
	if len(req.X224ConnectionPDU) == 0 {
		// VMConnect (no X.224) is Hyper-V specific and not supported here.
		_ = conn.WriteMessage(websocket.BinaryMessage, encodeRDCleanPathError(rdpCleanPathError{
			Code:       rdcleanPathErrGeneral,
			HTTPStatus: http.StatusBadRequest,
		}))
		return
	}

	stream, err := h.streamer.OpenStream(ctx, ticket.EdgeID)
	if err != nil {
		h.log.Warn("rdp: open stream", slog.Any("err", err), slog.Uint64("edge_id", ticket.EdgeID))
		_ = conn.WriteMessage(websocket.BinaryMessage, encodeRDCleanPathError(rdpCleanPathError{
			Code:       rdcleanPathErrUnreachable,
			WSALastErr: wsaCode(err),
		}))
		return
	}
	defer stream.Close()

	if _, err := stream.Write([]byte("ONGRID-TARGET " + rdpLoopbackTarget + "\n")); err != nil {
		h.log.Warn("rdp: write target preface", slog.Any("err", err))
		return
	}
	if len(req.PreconnectionBlob) > 0 {
		if _, err := stream.Write(req.PreconnectionBlob); err != nil {
			h.log.Warn("rdp: write preconnection blob", slog.Any("err", err))
			return
		}
	}
	if _, err := stream.Write(req.X224ConnectionPDU); err != nil {
		h.log.Warn("rdp: write X.224 request", slog.Any("err", err))
		return
	}

	confirm, err := readX224PDU(stream, 16*1024)
	if err != nil {
		h.log.Warn("rdp: read X.224 confirm", slog.Any("err", err))
		_ = conn.WriteMessage(websocket.BinaryMessage, encodeRDCleanPathError(rdpCleanPathError{
			Code:       rdcleanPathErrUnreachable,
			WSALastErr: wsaCode(err),
		}))
		return
	}

	neg := parseX224Negotiation(confirm)
	if neg.present && neg.failure {
		_ = conn.WriteMessage(websocket.BinaryMessage, encodeRDPNegotiationError(confirm))
		return
	}

	var (
		rw     io.ReadWriteCloser = stream
		certs  [][]byte
		server = rdpServerName(req.Destination)
	)
	if !neg.present || neg.protocol != 0 {
		// TLS is negotiated (SSL / HYBRID / HYBRID_EX). The proxy performs the
		// handshake because browsers cannot; the chain goes back to the client
		// for its own inspection and CredSSP public-key binding.
		tlsConn := tls.Client(streamConn{ReadWriteCloser: stream}, &tls.Config{
			// RDP servers use machine-generated self-signed certificates.
			// Verification is delegated to the IronRDP client via the chain
			// returned in the RDCleanPath response.
			InsecureSkipVerify: true, //nolint:gosec // documented above
			ServerName:         server,
			// Server 2008 R2 negotiates TLS 1.0; newer hosts negotiate 1.2+.
			MinVersion: tls.VersionTLS10, //nolint:gosec // legacy RDP hosts
		})
		hsCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		err = tlsConn.HandshakeContext(hsCtx)
		cancel()
		if err != nil {
			h.log.Warn("rdp: TLS handshake", slog.Any("err", err), slog.String("server_name", server))
			_ = conn.WriteMessage(websocket.BinaryMessage, encodeRDCleanPathError(rdpCleanPathError{
				Code:     rdcleanPathErrTLSHandshake,
				TLSAlert: tlsAlertCode(err),
			}))
			return
		}
		for _, cert := range tlsConn.ConnectionState().PeerCertificates {
			certs = append(certs, cert.Raw)
		}
		rw = tlsConn
		defer tlsConn.Close()
	}

	if err := conn.WriteMessage(websocket.BinaryMessage, encodeRDPResponse(server, confirm, certs)); err != nil {
		h.log.Warn("rdp: write RDCleanPath response", slog.Any("err", err))
		return
	}
	_ = conn.SetReadDeadline(time.Time{})
	relayRDP(conn, rw)
}

// streamConn adapts the tunnel's io.ReadWriteCloser to net.Conn for crypto/tls.
// Tunnel streams do not expose addresses or deadlines; the handshake deadline
// is enforced by HandshakeContext instead.
type streamConn struct {
	io.ReadWriteCloser
}

func (streamConn) LocalAddr() net.Addr              { return streamAddr("local") }
func (streamConn) RemoteAddr() net.Addr             { return streamAddr("remote") }
func (streamConn) SetDeadline(time.Time) error      { return nil }
func (streamConn) SetReadDeadline(time.Time) error  { return nil }
func (streamConn) SetWriteDeadline(time.Time) error { return nil }

type streamAddr string

func (a streamAddr) Network() string { return "ongrid-tunnel" }
func (a streamAddr) String() string  { return string(a) }

// relayRDP pumps plaintext RDP bytes between the browser WebSocket and the
// TLS/TCP stream. Closing either side tears down the other.
func relayRDP(conn *websocket.Conn, rw io.ReadWriteCloser) {
	conn.SetReadLimit(1 << 20)
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 32<<10)
		for {
			n, err := rw.Read(buf)
			if n > 0 {
				if werr := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if _, err := rw.Write(data); err != nil {
			break
		}
	}
	_ = rw.Close()
	<-done
}

// readRDCleanPathRequest accumulates WebSocket frames until the PDU parses.
// IronRDP sends it as one frame, but a proxy should not depend on framing.
func readRDCleanPathRequest(conn *websocket.Conn) (rdpCleanPathRequest, error) {
	var buf []byte
	for len(buf) < 64<<10 {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return rdpCleanPathRequest{}, err
		}
		buf = append(buf, data...)
		if len(buf) == 0 {
			continue
		}
		if buf[0] != derTagSequence {
			return rdpCleanPathRequest{}, fmt.Errorf("unexpected first byte %#x", buf[0])
		}
		req, err := parseRDCleanPathRequest(buf)
		if err == nil {
			return req, nil
		}
	}
	return rdpCleanPathRequest{}, fmt.Errorf("RDCleanPath request too large")
}

// readX224PDU reads one TPKT-framed PDU (X.224 connection confirm).
func readX224PDU(r io.Reader, max int) ([]byte, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(r, header); err != nil {
		return nil, err
	}
	if header[0] != 0x03 || header[1] != 0x00 {
		return nil, fmt.Errorf("unexpected TPKT header %x", header[:2])
	}
	n := int(binary.BigEndian.Uint16(header[2:4]))
	if n < 4 || n > max {
		return nil, fmt.Errorf("invalid TPKT length %d", n)
	}
	pdu := make([]byte, n)
	copy(pdu, header)
	if _, err := io.ReadFull(r, pdu[4:]); err != nil {
		return nil, err
	}
	return pdu, nil
}

type x224Negotiation struct {
	present  bool
	failure  bool
	protocol uint32
}

// parseX224Negotiation extracts the RDP_NEG_RSP from the connection confirm.
// Absence of the structure means the server chose legacy RDP security.
func parseX224Negotiation(pdu []byte) x224Negotiation {
	// TPKT (4) + X.224 CC (7) + RDP_NEG_RSP (8).
	if len(pdu) < 19 || pdu[11] != 0x02 {
		return x224Negotiation{}
	}
	length := int(binary.LittleEndian.Uint16(pdu[13:15]))
	if length < 8 || len(pdu) < 11+length {
		return x224Negotiation{}
	}
	return x224Negotiation{
		present:  true,
		failure:  pdu[12] == 0x01,
		protocol: binary.LittleEndian.Uint32(pdu[15:19]),
	}
}

// rdpServerName extracts a SNI name from the client destination. The proxy
// still dials the device loopback; the name is only used for the handshake.
func rdpServerName(destination string) string {
	host := destination
	if h, _, err := net.SplitHostPort(destination); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if host == "" {
		return "localhost"
	}
	return host
}

func wsaCode(err error) int {
	if err == nil {
		return 10050 // WSAENETDOWN
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return 10060 // WSAETIMEDOUT
	}
	if strings.Contains(err.Error(), "refused") {
		return 10061 // WSAECONNREFUSED
	}
	return 10054 // WSAECONNRESET
}

// tlsAlertCode maps the common handshake failures to the TLS alert numbers
// the IronRDP client displays. Unknown failures fall back to an internal error.
func tlsAlertCode(err error) int {
	if err == nil {
		return 80
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "certificate"):
		return 42 // bad_certificate
	case strings.Contains(msg, "protocol version"):
		return 70
	case strings.Contains(msg, "handshake failure"):
		return 40
	case strings.Contains(msg, "no cipher"):
		return 40
	default:
		return 80 // internal_error
	}
}
