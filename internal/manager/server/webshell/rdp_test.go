package webshell

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
)

func TestParseRDCleanPathRequest(t *testing.T) {
	x224 := []byte{0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00}
	wire := derSequence(
		derContext(0, derInt(rdcleanPathVersion)),
		derContext(2, derUTF8("vm01.example:3389")),
		derContext(3, derUTF8("ticket-123")),
		derContext(6, derOctets(x224)),
	)
	req, err := parseRDCleanPathRequest(wire)
	if err != nil {
		t.Fatal(err)
	}
	if req.Version != rdcleanPathVersion {
		t.Fatalf("version = %d", req.Version)
	}
	if req.Destination != "vm01.example:3389" || req.ProxyAuth != "ticket-123" {
		t.Fatalf("unexpected request: %+v", req)
	}
	if string(req.X224ConnectionPDU) != string(x224) {
		t.Fatalf("x224 = %x", req.X224ConnectionPDU)
	}
}

func TestParseRDCleanPathRequestRejectsWrongVersion(t *testing.T) {
	wire := derSequence(
		derContext(0, derInt(3391)),
		derContext(2, derUTF8("host")),
		derContext(6, derOctets([]byte{1, 2, 3})),
	)
	if _, err := parseRDCleanPathRequest(wire); err == nil {
		t.Fatal("wrong version accepted")
	}
}

func TestRDPResponseCarriesNegotiationAndChain(t *testing.T) {
	x224 := []byte{0x03, 0x00, 0x00, 0x13}
	certs := [][]byte{{0x30, 0x03, 0x02, 0x01, 0x01}, {0x30, 0x03, 0x02, 0x01, 0x02}}
	wire := encodeRDPResponse("vm01.example", x224, certs)
	tag, content, rest, err := derParse(wire)
	if err != nil || tag != derTagSequence || len(rest) != 0 {
		t.Fatalf("response is not a single SEQUENCE: tag=%#x err=%v", tag, err)
	}
	var got struct {
		version int64
		x224    []byte
		certs   [][]byte
		addr    string
	}
	for len(content) > 0 {
		var ft byte
		var field, remaining []byte
		ft, field, remaining, err = derParse(content)
		if err != nil {
			t.Fatal(err)
		}
		content = remaining
		switch ft & 0x1F {
		case 0:
			got.version, err = derParseInt(field)
		case 6:
			got.x224, err = derParseBytes(field)
		case 7:
			got.certs, err = parseOctetSequence(field)
		case 9:
			got.addr, err = derParseString(field)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if got.version != rdcleanPathVersion || string(got.x224) != string(x224) || got.addr != "vm01.example" {
		t.Fatalf("unexpected response: %+v", got)
	}
	if len(got.certs) != 2 || string(got.certs[1]) != string(certs[1]) {
		t.Fatalf("cert chain = %x", got.certs)
	}
}

func TestParseX224Negotiation(t *testing.T) {
	tests := []struct {
		name     string
		pdu      []byte
		present  bool
		failure  bool
		protocol uint32
	}{
		{
			name:     "hybrid selected",
			pdu:      confirmPDU(2, false),
			present:  true,
			protocol: 2,
		},
		{
			name:    "negotiation failure",
			pdu:     confirmPDU(0, true),
			present: true,
			failure: true,
		},
		{name: "legacy server", pdu: []byte{0x03, 0x00, 0x00, 0x0b, 0x06, 0xd0, 0, 0, 0, 0, 0}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseX224Negotiation(tt.pdu)
			if got.present != tt.present || got.failure != tt.failure || got.protocol != tt.protocol {
				t.Fatalf("got %+v", got)
			}
		})
	}
}

func TestOpenRDPProxiesTLSAndRelaysBytes(t *testing.T) {
	server, err := newFakeRDPServer(true)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	h := &Handler{
		tickets:  map[string]shellTicket{},
		failures: map[string]authFailures{},
		// The fake RDP server consumes the ONGRID-TARGET preface itself,
		// exactly like the real edge forwarder.
		streamer: streamerFunc(func(_ context.Context, _ uint64) (io.ReadWriteCloser, error) {
			return net.Dial("tcp", server.Addr())
		}),
		upgrader: websocket.Upgrader{CheckOrigin: sameOrigin},
		log:      slog.Default(),
	}

	token, _, err := h.mintTicket(shellTicket{Kind: "rdp", DeviceID: 42, EdgeID: 7, ClientIP: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Get("/v1/devices/{device_id}/rdp", h.openRDP)
	srv := httptest.NewServer(router)
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	ws, resp, err := websocket.DefaultDialer.Dial(
		"ws://"+u.Host+"/v1/devices/42/rdp?ticket="+token,
		http.Header{"Origin": []string{"http://" + u.Host}},
	)
	if err != nil {
		t.Fatalf("dial: %v (%v)", err, resp)
	}
	defer ws.Close()

	x224Request := []byte{0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00}
	request := derSequence(
		derContext(0, derInt(rdcleanPathVersion)),
		derContext(2, derUTF8("vm01.example:3389")),
		derContext(3, derUTF8(token)),
		derContext(6, derOctets(x224Request)),
	)
	if err := ws.WriteMessage(websocket.BinaryMessage, request); err != nil {
		t.Fatal(err)
	}

	_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, response, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	if len(response) == 0 || response[0] != derTagSequence {
		t.Fatalf("unexpected response: %x", response)
	}
	if !containsBytes(response, server.CertDER()) {
		t.Fatal("server certificate missing from RDCleanPath response")
	}

	if err := ws.WriteMessage(websocket.BinaryMessage, []byte("hello-rdp")); err != nil {
		t.Fatal(err)
	}
	_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, echoed, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(echoed) != "hello-rdp" {
		t.Fatalf("echo = %q", echoed)
	}
}

// parseOctetSequence decodes a SEQUENCE OF OCTET STRING.
func parseOctetSequence(field []byte) ([][]byte, error) {
	tag, content, rest, err := derParse(field)
	if err != nil {
		return nil, err
	}
	if tag != derTagSequence || len(rest) != 0 {
		return nil, errDER
	}
	var out [][]byte
	for len(content) > 0 {
		var item []byte
		item, content, err = parseOctet(content)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, nil
}

func parseOctet(data []byte) (item, rest []byte, err error) {
	tag, content, rest, err := derParse(data)
	if err != nil {
		return nil, nil, err
	}
	if tag != derTagOctet {
		return nil, nil, errDER
	}
	return content, rest, nil
}

func containsBytes(haystack, needle []byte) bool {
	if len(needle) == 0 || len(haystack) < len(needle) {
		return false
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		match := true
		for j := range needle {
			if haystack[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// confirmPDU builds an X.224 connection confirm with an RDP_NEG_RSP.
func confirmPDU(protocol uint32, failure bool) []byte {
	pdu := []byte{0x03, 0x00, 0x00, 0x13, 0x06, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00, 0x02, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00}
	if failure {
		pdu[12] = 0x01
	}
	binary.LittleEndian.PutUint32(pdu[15:19], protocol)
	return pdu
}

// fakeRDPServer is a minimal RDP server: X.224 confirm, optional TLS, echo.
type fakeRDPServer struct {
	ln      net.Listener
	certDER []byte
	tls     bool
}

func (s *fakeRDPServer) Addr() string    { return s.ln.Addr().String() }
func (s *fakeRDPServer) CertDER() []byte { return s.certDER }
func (s *fakeRDPServer) Close()          { _ = s.ln.Close() }

func newFakeRDPServer(withTLS bool) (*fakeRDPServer, error) {
	cert, der, err := selfSignedCert()
	if err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &fakeRDPServer{ln: ln, certDER: der, tls: withTLS}
	go s.serve(cert)
	return s, nil
}

func (s *fakeRDPServer) serve(cert tls.Certificate) {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		go s.handle(conn, cert)
	}
}

func (s *fakeRDPServer) handle(conn net.Conn, cert tls.Certificate) {
	defer conn.Close()
	// The real edge consumes the target preface; drop it here as well.
	// (The manager always writes "ONGRID-TARGET 127.0.0.1:3389\n" first.)
	line := make([]byte, len("ONGRID-TARGET 127.0.0.1:3389\n"))
	if _, err := io.ReadFull(conn, line); err != nil {
		return
	}
	// Read the X.224 request (TPKT header carries the length).
	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header); err != nil {
		return
	}
	n := int(binary.BigEndian.Uint16(header[2:4]))
	rest := make([]byte, n-4)
	if _, err := io.ReadFull(conn, rest); err != nil {
		return
	}
	if s.tls {
		if _, err := conn.Write(confirmPDU(2, false)); err != nil {
			return
		}
		tlsConn := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{cert}})
		if err := tlsConn.Handshake(); err != nil {
			return
		}
		_, _ = io.Copy(tlsConn, tlsConn)
		return
	}
	if _, err := conn.Write(confirmPDU(0, false)); err != nil {
		return
	}
	_, _ = io.Copy(conn, conn)
}

func selfSignedCert() (tls.Certificate, []byte, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "vm01.example"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	cert := tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	return cert, der, nil
}
