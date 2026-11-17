package webshell

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path"
	"strconv"
	"strings"

	"github.com/ongridio/ongrid/internal/pkg/errs"
	"github.com/ongridio/ongrid/internal/pkg/tenantctx"
	"github.com/ongridio/ongrid/internal/pkg/tunnel"
)

// Device file manager endpoints.
//
// Reads can browse any absolute path on the device; writes are restricted by
// the edge to the transfer sandbox plus the admin-configured write roots
// (ONGRID_DEVICE_FILE_ROOTS is the pre-save fallback). The Manager re-checks
// permissions but the edge is the enforcement point for paths.

const defaultFileManagerMaxUpload = int64(8 << 30)

func (h *Handler) fileWriteRoots(ctx context.Context) []string {
	if h.writeRoots == nil {
		return nil
	}
	return h.writeRoots(ctx)
}

func (h *Handler) maxUploadBytes(ctx context.Context) int64 {
	if h.maxUploadBytesFn == nil {
		return defaultFileManagerMaxUpload
	}
	if limit := h.maxUploadBytesFn(ctx); limit > 0 {
		return limit
	}
	return defaultFileManagerMaxUpload
}

func (h *Handler) fmRoots(w http.ResponseWriter, r *http.Request) {
	resp, _, err := h.callFileManager(r.Context(), r, tunnel.FileManagerRequest{Op: "roots", Roots: h.fileWriteRoots(r.Context())})
	if err != nil {
		writeErr(w, err)
		return
	}
	roots := resp.Roots
	if roots == nil {
		roots = []tunnel.FileManagerRoot{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": roots, "total": len(roots)})
}

func (h *Handler) fmList(w http.ResponseWriter, r *http.Request) {
	rawPath := r.URL.Query().Get("path")
	resp, _, err := h.callFileManager(r.Context(), r, tunnel.FileManagerRequest{
		Op: "list", Path: rawPath, Roots: h.fileWriteRoots(r.Context()),
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	entries := resp.Entries
	if entries == nil {
		entries = []tunnel.FileManagerEntry{}
	}
	h.auditFM(r, "list", rawPath, 0, true)
	writeJSON(w, http.StatusOK, map[string]any{
		"path": resp.Path, "items": entries, "total": len(entries),
	})
}

func (h *Handler) fmDownload(w http.ResponseWriter, r *http.Request) {
	rawPath := r.URL.Query().Get("path")
	stream, err := h.openFileManagerStream(r.Context(), r)
	if err != nil {
		writeErr(w, err)
		return
	}
	defer stream.Close()
	if err := writeFMRequest(stream, tunnel.FileManagerRequest{Op: "download", Path: rawPath, Roots: h.fileWriteRoots(r.Context())}); err != nil {
		writeErr(w, fmt.Errorf("write file-manager request: %w", err))
		return
	}
	resp, body, err := readFMResponse(stream)
	if err != nil {
		writeErr(w, err)
		return
	}
	if !resp.OK {
		writeErr(w, fmEdgeError(resp.Error))
		return
	}
	base := path.Base(strings.ReplaceAll(resp.Path, "\\", "/"))
	if resp.Archive {
		w.Header().Set("Content-Type", "application/gzip")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", base+".tar.gz"))
		h.auditFM(r, "download-folder", rawPath, 0, true)
		_, _ = io.Copy(w, body)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(resp.Size, 10))
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", base))
	h.auditFM(r, "download", rawPath, resp.Size, true)
	if resp.Size > 0 {
		_, _ = io.CopyN(w, body, resp.Size)
	}
}

func (h *Handler) fmUpload(w http.ResponseWriter, r *http.Request) {
	rawPath := r.URL.Query().Get("path")
	overwrite := r.URL.Query().Get("overwrite") == "1"
	size := r.ContentLength
	if size < 0 {
		writeErr(w, fmt.Errorf("%w: Content-Length is required", errs.ErrInvalid))
		return
	}
	limit := h.maxUploadBytes(r.Context())
	if size > limit {
		h.auditFM(r, "upload", rawPath, size, false)
		writeErr(w, fmt.Errorf("%w: file exceeds the configured %d MiB upload limit", errs.ErrInvalid, limit>>20))
		return
	}
	stream, err := h.openFileManagerStream(r.Context(), r)
	if err != nil {
		writeErr(w, err)
		return
	}
	defer stream.Close()
	if err := writeFMRequest(stream, tunnel.FileManagerRequest{
		Op: "upload", Path: rawPath, UploadSize: size, Overwrite: overwrite, Roots: h.fileWriteRoots(r.Context()),
	}); err != nil {
		writeErr(w, fmt.Errorf("write file-manager request: %w", err))
		return
	}
	if size > 0 {
		if _, err := io.CopyN(stream, http.MaxBytesReader(w, r.Body, size+1), size); err != nil {
			writeErr(w, fmt.Errorf("stream upload: %w", err))
			return
		}
	}
	resp, _, err := readFMResponse(stream)
	if err != nil {
		writeErr(w, err)
		return
	}
	if !resp.OK {
		writeErr(w, fmEdgeError(resp.Error))
		return
	}
	h.auditFM(r, "upload", rawPath, size, true)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": resp.Path, "size": size})
}

func (h *Handler) fmMkdir(w http.ResponseWriter, r *http.Request) {
	rawPath := r.URL.Query().Get("path")
	resp, _, err := h.callFileManager(r.Context(), r, tunnel.FileManagerRequest{
		Op: "mkdir", Path: rawPath, Roots: h.fileWriteRoots(r.Context()),
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	h.auditFM(r, "mkdir", rawPath, 0, true)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": resp.Path})
}

func (h *Handler) fmRename(w http.ResponseWriter, r *http.Request) {
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	resp, _, err := h.callFileManager(r.Context(), r, tunnel.FileManagerRequest{
		Op: "rename", Path: from, Target: to, Roots: h.fileWriteRoots(r.Context()),
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	h.auditFM(r, "rename", from+" -> "+to, 0, true)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": resp.Path})
}

// callFileManager runs one request whose payload is a single control line.
func (h *Handler) callFileManager(ctx context.Context, r *http.Request, req tunnel.FileManagerRequest) (tunnel.FileManagerResponse, *bufio.Reader, error) {
	stream, err := h.openFileManagerStream(ctx, r)
	if err != nil {
		return tunnel.FileManagerResponse{}, nil, err
	}
	defer stream.Close()
	if err := writeFMRequest(stream, req); err != nil {
		return tunnel.FileManagerResponse{}, nil, fmt.Errorf("write file-manager request: %w", err)
	}
	resp, body, err := readFMResponse(stream)
	if err != nil {
		return tunnel.FileManagerResponse{}, nil, err
	}
	if !resp.OK {
		h.auditFM(r, req.Op, req.Path, 0, false)
		return resp, body, fmEdgeError(resp.Error)
	}
	return resp, body, nil
}

func (h *Handler) openFileManagerStream(ctx context.Context, r *http.Request) (io.ReadWriteCloser, error) {
	deviceID, err := parseUintParam(r, "device_id")
	if err != nil {
		return nil, err
	}
	edge, err := h.onlineEdge(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	stream, err := h.streamer.OpenStream(ctx, edge.ID)
	if err != nil {
		return nil, fmt.Errorf("open file-manager stream: %w", err)
	}
	return stream, nil
}

func writeFMRequest(w io.Writer, req tunnel.FileManagerRequest) error {
	payload, err := json.Marshal(req)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "%s%s\n", tunnel.FileManagerPreface, payload)
	return err
}

func readFMResponse(stream io.Reader) (tunnel.FileManagerResponse, *bufio.Reader, error) {
	var resp tunnel.FileManagerResponse
	br := bufio.NewReaderSize(stream, 64<<10)
	line, err := br.ReadString('\n')
	if err != nil {
		return resp, nil, fmt.Errorf("read file-manager response: %w", err)
	}
	if !strings.HasPrefix(line, tunnel.FileManagerResponsePrefix) {
		return resp, nil, fmt.Errorf("unexpected file-manager response: %q", strings.TrimSpace(line))
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, tunnel.FileManagerResponsePrefix))), &resp); err != nil {
		return resp, nil, fmt.Errorf("decode file-manager response: %w", err)
	}
	return resp, br, nil
}

func fmEdgeError(msg string) error {
	lower := strings.ToLower(msg)
	switch {
	case strings.Contains(lower, "outside the writable roots"),
		strings.Contains(lower, "invalid path"),
		strings.Contains(lower, "must be absolute"),
		strings.Contains(lower, "must include a drive"),
		strings.Contains(lower, "target already exists"),
		strings.Contains(lower, "invalid size"),
		strings.Contains(lower, "unc paths"):
		return fmt.Errorf("%w: %s", errs.ErrInvalid, msg)
	default:
		return fmt.Errorf("device file manager: %s", msg)
	}
}

func (h *Handler) auditFM(r *http.Request, op, target string, size int64, ok bool) {
	tenant, _ := tenantctx.From(r.Context())
	h.log.Info("device file manager",
		slog.String("op", op),
		slog.String("target", target),
		slog.Int64("size", size),
		slog.Bool("ok", ok),
		slog.Uint64("user_id", tenant.UserID),
	)
}
