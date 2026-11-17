package webshell

import (
	"errors"
	"fmt"
)

// Hand-rolled DER for the IronRDP RDCleanPath PDU.
//
// The PDU is a small ASN.1 SEQUENCE of context-specific explicit fields:
//
//	SEQUENCE {
//	  [0] EXPLICIT INTEGER          version
//	  [1] EXPLICIT SEQUENCE         error        (proxy -> client)
//	  [2] EXPLICIT UTF8String       destination  (client -> proxy)
//	  [3] EXPLICIT UTF8String       proxy_auth   (client -> proxy)
//	  [4] EXPLICIT UTF8String       server_auth
//	  [5] EXPLICIT UTF8String       preconnection_blob
//	  [6] EXPLICIT OCTET STRING     x224_connection_pdu
//	  [7] EXPLICIT SEQUENCE OF OCTET STRING server_cert_chain
//	  [9] EXPLICIT UTF8String       server_addr  (proxy -> client)
//	}
//
// encoding/asn1 cannot express the optional explicit fields here (it rejects
// explicit optional `[]byte` and does not reliably round-trip optional
// sequences), so the wire format is encoded and parsed by hand. The layout is
// fixed by IronRDP: peers reject unknown trailing fields.

const (
	rdcleanPathVersion = 3390

	rdcleanPathErrGeneral      = 1
	rdcleanPathErrNegotiation  = 2
	rdcleanPathErrUnreachable  = 103
	rdcleanPathErrTLSHandshake = 105
)

// DER tags used by the PDU.
const (
	derTagInteger    = 0x02
	derTagOctet      = 0x04
	derTagUTF8String = 0x0C
	derTagSequence   = 0x30
	derContext0      = 0xA0
)

var errDER = errors.New("invalid DER")

// rdpCleanPathRequest is the subset of the request PDU the proxy consumes.
// destination is informational: the proxy always dials the device loopback
// through the edge tunnel, never an arbitrary host supplied by the browser.
type rdpCleanPathRequest struct {
	Version           int64
	Destination       string
	ProxyAuth         string
	PreconnectionBlob []byte
	X224ConnectionPDU []byte
}

// rdpCleanPathError is the proxy-side error payload.
type rdpCleanPathError struct {
	Code       int
	HTTPStatus int
	WSALastErr int
	TLSAlert   int
}

func derTLV(tag byte, content []byte) []byte {
	out := make([]byte, 0, 2+len(content))
	out = append(out, tag)
	out = append(out, derLength(len(content))...)
	out = append(out, content...)
	return out
}

func derLength(n int) []byte {
	if n < 0x80 {
		return []byte{byte(n)}
	}
	var buf [8]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte(n)
		n >>= 8
	}
	out := make([]byte, 0, 1+len(buf)-i)
	out = append(out, 0x80|byte(len(buf)-i))
	return append(out, buf[i:]...)
}

func derInt(v int) []byte {
	if v == 0 {
		return derTLV(derTagInteger, []byte{0})
	}
	if v < 0 {
		panic("rdcleanpath: negative INTEGER not supported")
	}
	var buf [8]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte(v)
		v >>= 8
	}
	content := buf[i:]
	if content[0]&0x80 != 0 {
		content = append([]byte{0}, content...)
	}
	return derTLV(derTagInteger, content)
}

func derUTF8(s string) []byte {
	return derTLV(derTagUTF8String, []byte(s))
}

func derOctets(b []byte) []byte {
	return derTLV(derTagOctet, b)
}

// derContext wraps a complete TLV in an explicit context-specific tag.
func derContext(n byte, inner []byte) []byte {
	return derTLV(derContext0|(n&0x1F), inner)
}

func derSequence(parts ...[]byte) []byte {
	var content []byte
	for _, p := range parts {
		content = append(content, p...)
	}
	return derTLV(derTagSequence, content)
}

func derSequenceOfOctets(list [][]byte) []byte {
	content := make([]byte, 0, len(list)*8)
	for _, item := range list {
		content = append(content, derOctets(item)...)
	}
	return derTLV(derTagSequence, content)
}

// encodeRDCleanPathError builds a proxy error response. The error sequence
// carries an error code plus optional HTTP/WSA/TLS detail fields.
func encodeRDCleanPathError(e rdpCleanPathError) []byte {
	fields := [][]byte{derContext(0, derInt(e.Code))}
	if e.HTTPStatus != 0 {
		fields = append(fields, derContext(1, derInt(e.HTTPStatus)))
	}
	if e.WSALastErr != 0 {
		fields = append(fields, derContext(2, derInt(e.WSALastErr)))
	}
	if e.TLSAlert != 0 {
		fields = append(fields, derContext(3, derInt(e.TLSAlert)))
	}
	errSeq := derSequence(fields...)
	// A negotiation error carries the server's X.224 response in place of the
	// normal response field; callers that have it use encodeRDPNegotiationError.
	return derSequence(
		derContext(0, derInt(rdcleanPathVersion)),
		derContext(1, errSeq),
	)
}

// encodeRDPNegotiationError reports a server-side negotiation failure and
// includes the X.224 connection response so the client can surface the exact
// failure code.
func encodeRDPNegotiationError(x224 []byte) []byte {
	return derSequence(
		derContext(0, derInt(rdcleanPathVersion)),
		derContext(1, derSequence(derContext(0, derInt(rdcleanPathErrNegotiation)))),
		derContext(6, derOctets(x224)),
	)
}

// encodeRDPResponse builds the successful proxy response: the server's X.224
// connection confirm, its TLS certificate chain, and the resolved address.
func encodeRDPResponse(serverAddr string, x224 []byte, certs [][]byte) []byte {
	parts := [][]byte{
		derContext(0, derInt(rdcleanPathVersion)),
	}
	if len(x224) > 0 {
		parts = append(parts, derContext(6, derOctets(x224)))
	}
	if len(certs) > 0 {
		parts = append(parts, derContext(7, derSequenceOfOctets(certs)))
	}
	if serverAddr != "" {
		parts = append(parts, derContext(9, derUTF8(serverAddr)))
	}
	return derSequence(parts...)
}

// parseRDCleanPathRequest decodes the client request PDU. Unknown fields are
// skipped (the current version has none, but future peers must not break us).
func parseRDCleanPathRequest(data []byte) (rdpCleanPathRequest, error) {
	var req rdpCleanPathRequest
	tag, content, rest, err := derParse(data)
	if err != nil {
		return req, err
	}
	if tag != derTagSequence || len(rest) != 0 {
		return req, fmt.Errorf("%w: expected a single SEQUENCE", errDER)
	}
	for len(content) > 0 {
		var fieldTag byte
		var field, remaining []byte
		fieldTag, field, remaining, err = derParse(content)
		if err != nil {
			return req, err
		}
		content = remaining
		if fieldTag&0xE0 != 0xA0 { // not context-specific constructed
			continue
		}
		n := fieldTag & 0x1F
		switch n {
		case 0:
			req.Version, err = derParseInt(field)
		case 2:
			req.Destination, err = derParseString(field)
		case 3:
			req.ProxyAuth, err = derParseString(field)
		case 5:
			var blob []byte
			blob, err = derParseBytes(field)
			req.PreconnectionBlob = blob
		case 6:
			req.X224ConnectionPDU, err = derParseBytes(field)
		default:
			// Unknown or proxy-only fields are ignored.
		}
		if err != nil {
			return req, err
		}
	}
	if req.Version != rdcleanPathVersion {
		return req, fmt.Errorf("%w: unsupported RDCleanPath version %d", errDER, req.Version)
	}
	return req, nil
}

// derParse splits one TLV off the front of data.
func derParse(data []byte) (tag byte, content []byte, rest []byte, err error) {
	if len(data) < 2 {
		return 0, nil, nil, fmt.Errorf("%w: truncated header", errDER)
	}
	tag = data[0]
	length, n, err := derParseLength(data[1:])
	if err != nil {
		return 0, nil, nil, err
	}
	start := 1 + n
	if length > len(data)-start {
		return 0, nil, nil, fmt.Errorf("%w: truncated content", errDER)
	}
	return tag, data[start : start+length], data[start+length:], nil
}

func derParseLength(data []byte) (length, consumed int, err error) {
	if len(data) == 0 {
		return 0, 0, fmt.Errorf("%w: missing length", errDER)
	}
	first := data[0]
	if first < 0x80 {
		return int(first), 1, nil
	}
	count := int(first & 0x7F)
	if count == 0 || count > 4 || len(data) < 1+count {
		return 0, 0, fmt.Errorf("%w: bad length", errDER)
	}
	length = 0
	for i := 0; i < count; i++ {
		length = length<<8 | int(data[1+i])
	}
	return length, 1 + count, nil
}

// derParseInt parses a context-specific wrapper containing an INTEGER.
func derParseInt(field []byte) (int64, error) {
	tag, content, rest, err := derParse(field)
	if err != nil {
		return 0, err
	}
	if tag != derTagInteger || len(rest) != 0 || len(content) == 0 || len(content) > 8 {
		return 0, fmt.Errorf("%w: expected INTEGER", errDER)
	}
	var v int64
	for _, b := range content {
		v = v<<8 | int64(b)
	}
	return v, nil
}

func derParseString(field []byte) (string, error) {
	tag, content, rest, err := derParse(field)
	if err != nil {
		return "", err
	}
	if tag != derTagUTF8String || len(rest) != 0 {
		return "", fmt.Errorf("%w: expected UTF8String", errDER)
	}
	return string(content), nil
}

func derParseBytes(field []byte) ([]byte, error) {
	tag, content, rest, err := derParse(field)
	if err != nil {
		return nil, err
	}
	if tag != derTagOctet || len(rest) != 0 {
		return nil, fmt.Errorf("%w: expected OCTET STRING", errDER)
	}
	return content, nil
}
