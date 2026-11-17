package webshell

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/ongridio/ongrid/internal/pkg/errs"
	"github.com/ongridio/ongrid/internal/pkg/tunnel"
)

// Device file channel (Windows and Linux edges).
//
// Files are written to the edge sandbox (C:\ProgramData\ongrid-edge\transfer
// or /var/lib/ongrid-edge/transfer) over a dedicated tunnel stream. This is
// deliberately independent of the RDP clipboard: it is deterministic, auditable
// and does not depend on the remote desktop's clipboard policy or OS version.

const maxTransferNameLen = 255

// listFiles returns the sandbox contents for one device.
func (h *Handler) listFiles(w http.ResponseWriter, r *http.Request) {
	stream, edgeID, err := h.openFileStream(r.Context(), r)
	if err != nil {
		writeErr(w, err)
		return
	}
	defer stream.Close()
	if err := writeFileRequest(stream, tunnel.FileTransferRequest{Op: "list"}); err != nil {
		writeErr(w, fmt.Errorf("write file request: %w", err))
		return
	}
	resp, _, err := readFileResponse(stream)
	if err != nil {
		writeErr(w, err)
		return
	}
	if !resp.OK {
		writeErr(w, fmt.Errorf("edge file list: %s", resp.Error))
		return
	}
	files := resp.Files
	if files == nil {
		files = []tunnel.FileTransferFile{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": files, "total": len(files), "edge_id": edgeID})
}

// uploadFile streams the request body into the device sandbox.
func (h *Handler) uploadFile(w http.ResponseWriter, r *http.Request) {
	name, err := safeTransferName(r.URL.Query().Get("name"))
	if err != nil {
		writeErr(w, err)
		return
	}
	size := r.ContentLength
	if size < 0 {
		writeErr(w, fmt.Errorf("%w: Content-Length is required", errs.ErrInvalid))
		return
	}
	if size > tunnel.FileStreamMaxSize {
		writeErr(w, fmt.Errorf("%w: file exceeds %d bytes", errs.ErrInvalid, tunnel.FileStreamMaxSize))
		return
	}

	stream, edgeID, err := h.openFileStream(r.Context(), r)
	if err != nil {
		writeErr(w, err)
		return
	}
	defer stream.Close()
	if err := writeFileRequest(stream, tunnel.FileTransferRequest{Op: "put", Name: name, Size: size}); err != nil {
		writeErr(w, fmt.Errorf("write file request: %w", err))
		return
	}
	if size > 0 {
		body := http.MaxBytesReader(w, r.Body, size+1)
		copied, copyErr := io.CopyN(stream, body, size)
		if copyErr != nil {
			if errors.Is(copyErr, io.EOF) {
				writeErr(w, fmt.Errorf("%w: body shorter than Content-Length (%d/%d)", errs.ErrInvalid, copied, size))
				return
			}
			writeErr(w, fmt.Errorf("stream upload: %w", copyErr))
			return
		}
	}
	resp, _, err := readFileResponse(stream)
	if err != nil {
		writeErr(w, err)
		return
	}
	if !resp.OK {
		writeErr(w, fmt.Errorf("edge file upload: %s", resp.Error))
		return
	}
	h.log.Info("device file uploaded",
		slog.Uint64("device_id", h.deviceIDFromRequest(r)),
		slog.Uint64("edge_id", edgeID),
		slog.String("name", name),
		slog.Int64("size", size),
	)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": name, "size": size})
}

// downloadFile streams one sandbox file back to the caller.
func (h *Handler) downloadFile(w http.ResponseWriter, r *http.Request) {
	name, err := safeTransferName(chi.URLParam(r, "name"))
	if err != nil {
		writeErr(w, err)
		return
	}
	stream, edgeID, err := h.openFileStream(r.Context(), r)
	if err != nil {
		writeErr(w, err)
		return
	}
	defer stream.Close()
	if err := writeFileRequest(stream, tunnel.FileTransferRequest{Op: "get", Name: name}); err != nil {
		writeErr(w, fmt.Errorf("write file request: %w", err))
		return
	}
	resp, body, err := readFileResponse(stream)
	if err != nil {
		writeErr(w, err)
		return
	}
	if !resp.OK {
		writeErr(w, fmt.Errorf("%w: %s", errs.ErrNotFound, resp.Error))
		return
	}
	if resp.Size < 0 || resp.Size > tunnel.FileStreamMaxSize {
		writeErr(w, fmt.Errorf("edge returned invalid size %d", resp.Size))
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(resp.Size, 10))
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	if resp.Size == 0 {
		return
	}
	if _, err := io.CopyN(w, body, resp.Size); err != nil {
		h.log.Warn("device file download interrupted",
			slog.Uint64("edge_id", edgeID),
			slog.String("name", name),
			slog.Any("err", err),
		)
	}
}

// openFileStream resolves the device's online edge and opens one file stream.
func (h *Handler) openFileStream(ctx context.Context, r *http.Request) (io.ReadWriteCloser, uint64, error) {
	deviceID, err := parseUintParam(r, "device_id")
	if err != nil {
		return nil, 0, err
	}
	edge, err := h.onlineEdge(ctx, deviceID)
	if err != nil {
		return nil, 0, err
	}
	stream, err := h.streamer.OpenStream(ctx, edge.ID)
	if err != nil {
		return nil, 0, fmt.Errorf("open file stream: %w", err)
	}
	return stream, edge.ID, nil
}

func (h *Handler) deviceIDFromRequest(r *http.Request) uint64 {
	id, _ := parseUintParam(r, "device_id")
	return id
}

func writeFileRequest(w io.Writer, req tunnel.FileTransferRequest) error {
	payload, err := json.Marshal(req)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "%s%s\n", tunnel.FileStreamPreface, payload)
	return err
}

// readFileResponse reads the edge control line and returns the same buffered
// reader for the payload, so bytes are not lost between the two reads.
func readFileResponse(stream io.Reader) (tunnel.FileTransferResponse, *bufio.Reader, error) {
	var resp tunnel.FileTransferResponse
	br := bufio.NewReaderSize(stream, 64<<10)
	line, err := br.ReadString('\n')
	if err != nil {
		return resp, nil, fmt.Errorf("read file response: %w", err)
	}
	if !strings.HasPrefix(line, tunnel.FileStreamResponsePrefix) {
		return resp, nil, fmt.Errorf("unexpected file response: %q", strings.TrimSpace(line))
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, tunnel.FileStreamResponsePrefix))), &resp); err != nil {
		return resp, nil, fmt.Errorf("decode file response: %w", err)
	}
	return resp, br, nil
}

// safeTransferName accepts only a plain file name (no paths).
func safeTransferName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || len(name) > maxTransferNameLen {
		return "", fmt.Errorf("%w: invalid file name", errs.ErrInvalid)
	}
	if strings.ContainsAny(name, `/\`) || name == "." || name == ".." {
		return "", fmt.Errorf("%w: invalid file name", errs.ErrInvalid)
	}
	return name, nil
}
