package filetransfer

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

type memStream struct {
	r    io.Reader
	w    bytes.Buffer
	meta []byte
}

func (s *memStream) Read(p []byte) (int, error)  { return s.r.Read(p) }
func (s *memStream) Write(p []byte) (int, error) { return s.w.Write(p) }
func (s *memStream) Close() error                { return nil }
func (s *memStream) Meta() []byte                { return s.meta }

func run(t *testing.T, req Request, body []byte) (Response, []byte) {
	t.Helper()
	preface, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	wire := append([]byte(PrefacePrefix+string(preface)+"\n"), body...)
	stream := &memStream{r: bytes.NewReader(wire)}
	HandleStream(stream, nil)

	br := bufio.NewReader(&stream.w)
	line, err := br.ReadString('\n')
	if err != nil && line == "" {
		t.Fatalf("no response: %v", err)
	}
	if !strings.HasPrefix(line, ResponsePrefix) {
		t.Fatalf("response = %q", line)
	}
	var resp Response
	if err := json.Unmarshal([]byte(strings.TrimPrefix(line, ResponsePrefix)), &resp); err != nil {
		t.Fatal(err)
	}
	rest, _ := io.ReadAll(br)
	return resp, rest
}

func TestPutListGet(t *testing.T) {
	t.Setenv("ONGRID_EDGE_TRANSFER_DIR", t.TempDir())
	payload := []byte("hello transfer")

	putResp, _ := run(t, Request{Op: "put", Name: "note.txt", Size: int64(len(payload))}, payload)
	if !putResp.OK {
		t.Fatalf("put failed: %+v", putResp)
	}

	listResp, _ := run(t, Request{Op: "list"}, nil)
	if !listResp.OK || len(listResp.Files) != 1 || listResp.Files[0].Name != "note.txt" || listResp.Files[0].Size != int64(len(payload)) {
		t.Fatalf("list = %+v", listResp)
	}

	getResp, body := run(t, Request{Op: "get", Name: "note.txt"}, nil)
	if !getResp.OK || getResp.Size != int64(len(payload)) {
		t.Fatalf("get = %+v", getResp)
	}
	if string(body) != string(payload) {
		t.Fatalf("body = %q", body)
	}
}

func TestPutOverwritesAtomically(t *testing.T) {
	t.Setenv("ONGRID_EDGE_TRANSFER_DIR", t.TempDir())
	if resp, _ := run(t, Request{Op: "put", Name: "a.txt", Size: 3}, []byte("old")); !resp.OK {
		t.Fatal(resp.Error)
	}
	if resp, _ := run(t, Request{Op: "put", Name: "a.txt", Size: 3}, []byte("new")); !resp.OK {
		t.Fatal(resp.Error)
	}
	resp, body := run(t, Request{Op: "get", Name: "a.txt"}, nil)
	if !resp.OK || string(body) != "new" {
		t.Fatalf("get = %+v %q", resp, body)
	}
}

func TestRejectsTraversalAndOversize(t *testing.T) {
	t.Setenv("ONGRID_EDGE_TRANSFER_DIR", t.TempDir())
	for _, name := range []string{"../escape.txt", `..\escape.txt`, "sub/dir.txt", ".", "..", ""} {
		resp, _ := run(t, Request{Op: "put", Name: name, Size: 1}, []byte("x"))
		if resp.OK {
			t.Fatalf("name %q accepted", name)
		}
	}
	resp, _ := run(t, Request{Op: "get", Name: "../secret"}, nil)
	if resp.OK {
		t.Fatal("traversal get accepted")
	}
	resp, _ = run(t, Request{Op: "put", Name: "big.bin", Size: MaxFileSize + 1}, nil)
	if resp.OK {
		t.Fatal("oversize accepted")
	}
}

func TestBadPreface(t *testing.T) {
	t.Setenv("ONGRID_EDGE_TRANSFER_DIR", t.TempDir())
	stream := &memStream{r: strings.NewReader("NOPE\n")}
	HandleStream(stream, nil)
	if !strings.Contains(stream.w.String(), ResponsePrefix) {
		t.Fatalf("no response: %q", stream.w.String())
	}
}
