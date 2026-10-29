// Package file builds the CMDB file-attachment and file-settings HTTP routes.
package file

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	filebiz "github.com/ongridio/ongrid/internal/cmdb/biz/file"
	"github.com/ongridio/ongrid/internal/pkg/errs"
	"github.com/ongridio/ongrid/internal/pkg/tenantctx"
)

const (
	maxJSONBody   = 64 << 10
	maxUploadBody = 60 << 20
	maxFormMemory = 16 << 20
	maxFiles      = 10
	roleAdmin     = "admin"
)

// Handler exposes the CMDB file routes under /v1/cmdb and the public
// capability route under /api/v1/cmdb/ci/files/public/{token}.
type Handler struct {
	uc *filebiz.Usecase
}

func NewHandler(uc *filebiz.Usecase) *Handler { return &Handler{uc: uc} }

// Register attaches the authenticated and admin-gated routes. The caller has
// already mounted auth.Middleware on r.
func (h *Handler) Register(r chi.Router) {
	r.With(h.requireAdmin).Get("/v1/cmdb/file-storage", h.getStorage)
	r.With(h.requireAdmin).Put("/v1/cmdb/file-storage", h.putStorage)
	r.With(h.requireAdmin).Post("/v1/cmdb/file-storage/test", h.testStorage)

	// The preview server URL is needed by every authenticated browser that
	// renders an attachment, not only by admins.
	r.Get("/v1/cmdb/file-preview", h.getPreview)
	r.With(h.requireAdmin).Put("/v1/cmdb/file-preview", h.putPreview)
	r.With(h.requireAdmin).Post("/v1/cmdb/file-preview/test", h.testPreview)

	r.Post("/v1/cmdb/ci/files", h.upload)
	r.Get("/v1/cmdb/ci/files", h.download)
	r.Head("/v1/cmdb/ci/files", h.download)
	r.Delete("/v1/cmdb/ci/files", h.deleteFiles)
	r.Post("/v1/cmdb/ci/files/preview-url", h.previewURL)
}

// RegisterPublic mounts the capability URL outside auth.Middleware. The token
// is the authorization: it names one file and one disposition and expires.
func (h *Handler) RegisterPublic(r chi.Router) {
	r.Get("/api/v1/cmdb/ci/files/public/{token}", h.serveCapability)
	r.Head("/api/v1/cmdb/ci/files/public/{token}", h.serveCapability)
}

func (h *Handler) getStorage(w http.ResponseWriter, r *http.Request) {
	cfg, err := h.uc.Storage(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

func (h *Handler) putStorage(w http.ResponseWriter, r *http.Request) {
	var patch filebiz.StoragePatch
	if err := decodeJSON(r, &patch); err != nil {
		writeErr(w, err)
		return
	}
	cfg, err := h.uc.UpdateStorage(r.Context(), patch)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

func (h *Handler) testStorage(w http.ResponseWriter, r *http.Request) {
	var patch filebiz.StoragePatch
	if err := decodeJSON(r, &patch); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h.uc.TestStorage(r.Context(), patch))
}

func (h *Handler) getPreview(w http.ResponseWriter, r *http.Request) {
	cfg, err := h.uc.Preview(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

func (h *Handler) putPreview(w http.ResponseWriter, r *http.Request) {
	var patch filebiz.PreviewPatch
	if err := decodeJSON(r, &patch); err != nil {
		writeErr(w, err)
		return
	}
	cfg, err := h.uc.UpdatePreview(r.Context(), patch)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

func (h *Handler) testPreview(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PreviewServerURL string `json:"preview_server_url"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h.uc.TestPreview(r.Context(), body.PreviewServerURL))
}

func (h *Handler) upload(w http.ResponseWriter, r *http.Request) {
	caller, ok := tenantctx.From(r.Context())
	if !ok {
		writeErr(w, errs.ErrUnauthorized)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBody)
	if err := r.ParseMultipartForm(maxFormMemory); err != nil {
		writeErr(w, fmt.Errorf("%w: invalid multipart upload", errs.ErrInvalid))
		return
	}
	headers := r.MultipartForm.File["files"]
	if len(headers) == 0 {
		headers = r.MultipartForm.File["file"]
	}
	if len(headers) == 0 {
		writeErr(w, fmt.Errorf("%w: at least one file is required", errs.ErrInvalid))
		return
	}
	if len(headers) > maxFiles {
		writeErr(w, fmt.Errorf("%w: at most %d files per upload", errs.ErrInvalid, maxFiles))
		return
	}
	attrID := strings.TrimSpace(r.FormValue("attr_id"))
	if _, err := strconv.ParseUint(attrID, 10, 64); attrID != "" && err != nil {
		writeErr(w, fmt.Errorf("%w: invalid attr_id", errs.ErrInvalid))
		return
	}

	inputs := make([]filebiz.FileInput, 0, len(headers))
	for _, header := range headers {
		file, err := header.Open()
		if err != nil {
			writeErr(w, fmt.Errorf("%w: open upload: %v", errs.ErrInvalid, err))
			return
		}
		defer file.Close()
		inputs = append(inputs, filebiz.FileInput{
			Name:        header.Filename,
			Size:        header.Size,
			ContentType: header.Header.Get("Content-Type"),
			Reader:      file,
		})
	}
	files, err := h.uc.Upload(r.Context(), caller.UserID, attrID, inputs)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": files})
}

func (h *Handler) download(w http.ResponseWriter, r *http.Request) {
	fileID := strings.TrimSpace(r.URL.Query().Get("file_id"))
	if fileID == "" {
		writeErr(w, fmt.Errorf("%w: file_id is required", errs.ErrInvalid))
		return
	}
	download := isTruthy(r.URL.Query().Get("download"))
	reader, row, object, err := h.uc.Open(r.Context(), fileID)
	if err != nil {
		writeErr(w, err)
		return
	}
	defer reader.Close()
	writeFile(w, r, row.OriginalName, row.MimeType, row.Size, object.Size, download, reader)
}

func (h *Handler) deleteFiles(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Files []struct {
			FileID string `json:"file_id"`
		} `json:"files"`
		FileIDs []string `json:"file_ids"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	ids := append([]string(nil), body.FileIDs...)
	for _, item := range body.Files {
		if strings.TrimSpace(item.FileID) != "" {
			ids = append(ids, item.FileID)
		}
	}
	if len(ids) == 0 {
		writeErr(w, fmt.Errorf("%w: at least one file_id is required", errs.ErrInvalid))
		return
	}
	deleted, err := h.uc.DeleteFiles(r.Context(), ids)
	if err != nil && deleted == 0 {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": deleted})
}

func (h *Handler) previewURL(w http.ResponseWriter, r *http.Request) {
	var body struct {
		FileID   string `json:"file_id"`
		Download bool   `json:"download"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	url, expires, err := h.uc.PreviewLink(r.Context(), body.FileID, body.Download)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"url":        url,
		"expires_at": expires.UTC().Format(time.RFC3339),
	})
}

func (h *Handler) serveCapability(w http.ResponseWriter, r *http.Request) {
	fileID, download, _, err := h.uc.ResolveCapability(chi.URLParam(r, "token"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	reader, row, object, err := h.uc.Open(r.Context(), fileID)
	if err != nil {
		if errors.Is(err, errs.ErrNotFound) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, "file unavailable", http.StatusInternalServerError)
		return
	}
	defer reader.Close()
	writeFile(w, r, row.OriginalName, row.MimeType, row.Size, object.Size, download, reader)
}

func writeFile(w http.ResponseWriter, r *http.Request, name, contentType string, size, objectSize int64, download bool, reader io.Reader) {
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if size <= 0 {
		size = objectSize
	}
	if size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=60")
	disposition := "inline"
	if download {
		disposition = "attachment"
	}
	value := mime.FormatMediaType(disposition, map[string]string{"filename": name})
	if value == "" {
		value = disposition
	}
	w.Header().Set("Content-Disposition", value)
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	_, _ = io.Copy(w, reader)
}

func decodeJSON(r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, maxJSONBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("%w: %v", errs.ErrInvalid, err)
	}
	return nil
}

func isTruthy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func (h *Handler) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tenant, ok := tenantctx.From(r.Context())
		if !ok {
			writeErr(w, errs.ErrUnauthorized)
			return
		}
		if !tenant.IsSuperuser && tenant.Role != roleAdmin {
			writeErr(w, errs.ErrForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type errorBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if body != nil {
		_ = json.NewEncoder(w).Encode(body)
	}
}

func writeErr(w http.ResponseWriter, err error) {
	writeJSON(w, errs.HTTPStatus(err), errorBody{Error: err.Error(), Code: errCode(err)})
}

func errCode(err error) string {
	switch {
	case errors.Is(err, errs.ErrNotFound):
		return "not_found"
	case errors.Is(err, errs.ErrUnauthorized):
		return "unauthorized"
	case errors.Is(err, errs.ErrForbidden):
		return "forbidden"
	case errors.Is(err, errs.ErrConflict):
		return "conflict"
	case errors.Is(err, errs.ErrInvalid):
		return "invalid"
	case errors.Is(err, errs.ErrNotWiredYet):
		return "not_wired_yet"
	default:
		return "internal"
	}
}
