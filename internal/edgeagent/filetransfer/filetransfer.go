// Package filetransfer implements the edge side of the OnGrid file channel.
//
// The Manager opens a tunnel stream, writes one control line
//
//	ONGRID-FILE {"op":"list"|"get"|"put", ...}\n
//
// and the edge answers with
//
//	ONGRID-FILE-RESP {"ok":true,...}\n
//
// followed by raw file bytes for get/put. Files live in a dedicated sandbox
// directory (C:\ProgramData\ongrid-edge\transfer or /var/lib/ongrid-edge/transfer)
// so the channel never exposes arbitrary host paths.
package filetransfer

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ongridio/ongrid/internal/edgeagent/edgedirs"
	"github.com/ongridio/ongrid/internal/pkg/tunnel"
)

const (
	// PrefacePrefix marks a file-channel stream.
	PrefacePrefix = tunnel.FileStreamPreface
	// ResponsePrefix marks the control response line.
	ResponsePrefix = tunnel.FileStreamResponsePrefix
	// MaxFileSize caps a single transfer (2 GiB).
	MaxFileSize = tunnel.FileStreamMaxSize

	maxPreface  = 8 << 10
	maxNameLen  = 255
	dirPerm     = 0o700
	filePerm    = 0o600
	transferDir = "transfer"
)

// Request is the control line sent by the Manager.
type Request = tunnel.FileTransferRequest

// FileInfo describes one file in the sandbox.
type FileInfo = tunnel.FileTransferFile

// Response is the control line returned by the edge.
type Response = tunnel.FileTransferResponse

// Dir returns the sandbox directory. ONGRID_EDGE_TRANSFER_DIR overrides it
// for tests and non-standard deployments.
func Dir() string {
	if v := strings.TrimSpace(os.Getenv("ONGRID_EDGE_TRANSFER_DIR")); v != "" {
		return v
	}
	return filepath.Join(edgedirs.DataDir, transferDir)
}

// HandleStream serves one file-channel stream. The stream must still contain
// the preface line; the stream router replays it for the selected handler.
func HandleStream(stream tunnel.StreamConn, log *slog.Logger) {
	defer stream.Close()
	if log == nil {
		log = slog.Default()
	}
	// Keep one buffered reader for the preface and the body: a fresh bufio
	// reader would swallow body bytes that arrived in the same packet.
	br := bufio.NewReaderSize(stream, maxPreface)
	line, err := br.ReadString('\n')
	if err != nil {
		log.Warn("filetransfer: read preface", slog.Any("err", err))
		return
	}
	if len(line) > maxPreface {
		writeResponse(stream, Response{Error: "preface too long"}, log)
		return
	}
	stream = &bufferedStream{StreamConn: stream, reader: br}
	if !strings.HasPrefix(line, PrefacePrefix) {
		writeResponse(stream, Response{Error: "invalid file-channel preface"}, log)
		return
	}
	var req Request
	if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, PrefacePrefix))), &req); err != nil {
		writeResponse(stream, Response{Error: "invalid request: " + err.Error()}, log)
		return
	}

	dir := Dir()
	if err := os.MkdirAll(dir, dirPerm); err != nil {
		writeResponse(stream, Response{Error: "create sandbox: " + err.Error()}, log)
		return
	}

	switch req.Op {
	case "list":
		list(stream, dir, log)
	case "get":
		get(stream, dir, req.Name, log)
	case "put":
		put(stream, dir, req.Name, req.Size, log)
	default:
		writeResponse(stream, Response{Error: "unsupported op " + req.Op}, log)
	}
}

func list(stream io.Writer, dir string, log *slog.Logger) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		writeResponse(stream, Response{Error: "list sandbox: " + err.Error()}, log)
		return
	}
	files := make([]FileInfo, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, FileInfo{
			Name:     entry.Name(),
			Size:     info.Size(),
			Modified: info.ModTime().UTC().Format(time.RFC3339),
		})
	}
	writeResponse(stream, Response{OK: true, Files: files}, log)
}

func get(stream io.Writer, dir, rawName string, log *slog.Logger) {
	name, err := safeName(rawName)
	if err != nil {
		writeResponse(stream, Response{Error: err.Error()}, log)
		return
	}
	path := filepath.Join(dir, name)
	f, err := os.Open(path)
	if err != nil {
		writeResponse(stream, Response{Error: "open: " + err.Error()}, log)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		writeResponse(stream, Response{Error: "stat: invalid file"}, log)
		return
	}
	if info.Size() > MaxFileSize {
		writeResponse(stream, Response{Error: "file too large"}, log)
		return
	}
	if !writeResponse(stream, Response{OK: true, Size: info.Size()}, log) {
		return
	}
	if _, err := io.CopyN(stream, f, info.Size()); err != nil {
		log.Warn("filetransfer: stream file", slog.String("name", name), slog.Any("err", err))
	}
}

func put(stream io.ReadWriter, dir, rawName string, size int64, log *slog.Logger) {
	name, err := safeName(rawName)
	if err != nil {
		// Drain the announced body so the Manager can finish writing before
		// it reads this error response.
		if size > 0 && size <= MaxFileSize {
			_, _ = io.CopyN(io.Discard, stream, size)
		}
		writeResponse(stream, Response{Error: err.Error()}, log)
		return
	}
	if size < 0 || size > MaxFileSize {
		writeResponse(stream, Response{Error: "invalid size"}, log)
		return
	}
	tmp, err := os.CreateTemp(dir, ".upload-*")
	if err != nil {
		writeResponse(stream, Response{Error: "create temp: " + err.Error()}, log)
		return
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}()
	if _, err := io.CopyN(tmp, stream, size); err != nil {
		writeResponse(stream, Response{Error: "receive: " + err.Error()}, log)
		return
	}
	if err := tmp.Sync(); err != nil {
		writeResponse(stream, Response{Error: "sync: " + err.Error()}, log)
		return
	}
	if err := tmp.Close(); err != nil {
		writeResponse(stream, Response{Error: "close: " + err.Error()}, log)
		return
	}
	target := filepath.Join(dir, name)
	_ = os.Remove(target)
	if err := os.Rename(tmpName, target); err != nil {
		writeResponse(stream, Response{Error: "rename: " + err.Error()}, log)
		return
	}
	_ = os.Chmod(target, filePerm)
	writeResponse(stream, Response{OK: true, Size: size}, log)
}

// safeName accepts only a plain file name inside the sandbox.
func safeName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || len(name) > maxNameLen {
		return "", errors.New("invalid file name")
	}
	if name != filepath.Base(name) || strings.ContainsAny(name, `/\`) || name == "." || name == ".." {
		return "", errors.New("invalid file name")
	}
	return name, nil
}

// bufferedStream reads the body through the same bufio.Reader that consumed
// the preface, so no bytes are lost between the two reads.
type bufferedStream struct {
	tunnel.StreamConn
	reader *bufio.Reader
}

func (s *bufferedStream) Read(p []byte) (int, error) { return s.reader.Read(p) }

func writeResponse(w io.Writer, resp Response, log *slog.Logger) bool {
	data, err := json.Marshal(resp)
	if err != nil {
		if log != nil {
			log.Warn("filetransfer: marshal response", slog.Any("err", err))
		}
		return false
	}
	if _, err := fmt.Fprintf(w, "%s%s\n", ResponsePrefix, data); err != nil {
		if log != nil {
			log.Warn("filetransfer: write response", slog.Any("err", err))
		}
		return false
	}
	return true
}
