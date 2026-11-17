package filemanager

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ongridio/ongrid/internal/pkg/tunnel"
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

func run(t *testing.T, req tunnel.FileManagerRequest, body []byte) (tunnel.FileManagerResponse, []byte) {
	t.Helper()
	preface, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	wire := append([]byte(tunnel.FileManagerPreface+string(preface)+"\n"), body...)
	stream := &memStream{r: bytes.NewReader(wire)}
	HandleStream(stream, nil)
	br := bufio.NewReader(&stream.w)
	line, err := br.ReadString('\n')
	if err != nil && line == "" {
		t.Fatalf("no response: %v", err)
	}
	if !strings.HasPrefix(line, tunnel.FileManagerResponsePrefix) {
		t.Fatalf("response = %q", line)
	}
	var resp tunnel.FileManagerResponse
	if err := json.Unmarshal([]byte(strings.TrimPrefix(line, tunnel.FileManagerResponsePrefix)), &resp); err != nil {
		t.Fatal(err)
	}
	rest, _ := io.ReadAll(br)
	return resp, rest
}

func TestListDownloadAndArchive(t *testing.T) {
	sandbox := t.TempDir()
	t.Setenv("ONGRID_EDGE_TRANSFER_DIR", sandbox)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("alpha"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sub", "b.txt"), []byte("beta"), 0o600); err != nil {
		t.Fatal(err)
	}

	resp, _ := run(t, tunnel.FileManagerRequest{Op: "list", Path: dir}, nil)
	if !resp.OK || len(resp.Entries) < 2 {
		t.Fatalf("list = %+v", resp)
	}

	resp, body := run(t, tunnel.FileManagerRequest{Op: "download", Path: filepath.Join(dir, "a.txt")}, nil)
	if !resp.OK || resp.Archive || string(body) != "alpha" {
		t.Fatalf("download = %+v %q", resp, body)
	}

	resp, archive := run(t, tunnel.FileManagerRequest{Op: "download", Path: dir}, nil)
	if !resp.OK || !resp.Archive {
		t.Fatalf("archive header = %+v", resp)
	}
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	names := map[string]string{}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if hdr.Typeflag == tar.TypeReg {
			data, _ := io.ReadAll(tr)
			names[hdr.Name] = string(data)
		}
	}
	if names[filepath.Base(dir)+"/a.txt"] != "alpha" || names[filepath.Base(dir)+"/sub/b.txt"] != "beta" {
		t.Fatalf("archive entries = %v", names)
	}
}

func TestWritesAreRestrictedToRoots(t *testing.T) {
	sandbox := t.TempDir()
	t.Setenv("ONGRID_EDGE_TRANSFER_DIR", sandbox)
	writable := t.TempDir()
	outside := t.TempDir()

	// Upload into the writable root.
	target := filepath.Join(writable, "dir", "note.txt")
	resp, _ := run(t, tunnel.FileManagerRequest{
		Op: "upload", Path: target, UploadSize: 4, Roots: []string{writable},
	}, []byte("data"))
	if !resp.OK {
		t.Fatalf("upload = %+v", resp)
	}
	if got, _ := os.ReadFile(target); string(got) != "data" {
		t.Fatalf("file = %q", got)
	}

	// Upload outside any writable root is rejected.
	bad := filepath.Join(outside, "nope.txt")
	resp, _ = run(t, tunnel.FileManagerRequest{
		Op: "upload", Path: bad, UploadSize: 4, Roots: []string{writable},
	}, []byte("data"))
	if resp.OK {
		t.Fatal("upload outside roots accepted")
	}
	if _, err := os.Stat(bad); err == nil {
		t.Fatal("file written outside roots")
	}

	// mkdir/rename inside roots, rename outside rejected.
	from := filepath.Join(writable, "dir", "note.txt")
	to := filepath.Join(writable, "dir", "renamed.txt")
	resp, _ = run(t, tunnel.FileManagerRequest{Op: "rename", Path: from, Target: to, Roots: []string{writable}}, nil)
	if !resp.OK {
		t.Fatalf("rename = %+v", resp)
	}
	resp, _ = run(t, tunnel.FileManagerRequest{Op: "mkdir", Path: filepath.Join(writable, "newdir"), Roots: []string{writable}}, nil)
	if !resp.OK {
		t.Fatalf("mkdir = %+v", resp)
	}
	resp, _ = run(t, tunnel.FileManagerRequest{Op: "rename", Path: to, Target: filepath.Join(outside, "x"), Roots: []string{writable}}, nil)
	if resp.OK {
		t.Fatal("rename outside roots accepted")
	}
}

func TestReadsAnyAbsolutePathButRejectsRelative(t *testing.T) {
	sandbox := t.TempDir()
	t.Setenv("ONGRID_EDGE_TRANSFER_DIR", sandbox)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "x.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	resp, body := run(t, tunnel.FileManagerRequest{Op: "download", Path: filepath.Join(dir, "x.txt")}, nil)
	if !resp.OK || string(body) != "x" {
		t.Fatalf("download = %+v %q", resp, body)
	}
	resp, _ = run(t, tunnel.FileManagerRequest{Op: "list", Path: "relative/dir"}, nil)
	if resp.OK {
		t.Fatal("relative path accepted")
	}
}

func TestRootsIncludeSandbox(t *testing.T) {
	sandbox := t.TempDir()
	t.Setenv("ONGRID_EDGE_TRANSFER_DIR", sandbox)
	resp, _ := run(t, tunnel.FileManagerRequest{Op: "roots", Roots: []string{"/data"}}, nil)
	if !resp.OK {
		t.Fatalf("roots = %+v", resp)
	}
	foundSandbox, foundData := false, false
	for _, r := range resp.Roots {
		if r.Path == filepath.Clean(sandbox) && r.Writable {
			foundSandbox = true
		}
		if r.Path == "/data" && r.Writable {
			foundData = true
		}
	}
	if !foundSandbox || !foundData {
		t.Fatalf("roots = %+v", resp.Roots)
	}
}
