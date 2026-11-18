// Package ciobs exposes CI monitoring links over HTTP. Link configuration is
// administrator-only; the per-CI Grafana/Prometheus reads are available to any
// authenticated user. It reuses the global Grafana/Prometheus integrations and
// never stores a credential.
package ciobs

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	bizaudit "github.com/ongridio/ongrid/internal/manager/biz/audit"
	biz "github.com/ongridio/ongrid/internal/manager/biz/ciobs"
	auditmodel "github.com/ongridio/ongrid/internal/manager/model/audit"
	auditmw "github.com/ongridio/ongrid/internal/manager/server/middleware"
	svc "github.com/ongridio/ongrid/internal/manager/service/ciobs"
	"github.com/ongridio/ongrid/internal/pkg/errs"
	"github.com/ongridio/ongrid/internal/pkg/tenantctx"
)

const maxBodyBytes = 1 << 20

type Handler struct {
	svc *svc.Service
	log *slog.Logger
}

func NewHandler(s *svc.Service, log *slog.Logger) *Handler {
	if log == nil {
		log = slog.Default()
	}
	return &Handler{svc: s, log: log}
}

// Register attaches routes:
//
//	GET    /v1/observability/ci-links                    (admin)
//	PUT    /v1/observability/ci-links/{provider}/{typeId} (admin)
//	DELETE /v1/observability/ci-links/{provider}/{typeId} (admin)
//	POST   /v1/observability/ci-links/preview             (admin)
//	GET    /v1/observability/ci-types/{typeId}/linkage    (any auth)
//	GET    /v1/observability/ci/{ciId}/grafana            (any auth)
//	GET    /v1/observability/ci/{ciId}/alerts             (any auth)
func (h *Handler) Register(r chi.Router) {
	r.Get("/v1/observability/ci-links", h.listLinks)
	r.Put("/v1/observability/ci-links/{provider}/{typeId}", h.saveLink)
	r.Delete("/v1/observability/ci-links/{provider}/{typeId}", h.deleteLink)
	r.Post("/v1/observability/ci-links/preview", h.previewLink)
	r.Get("/v1/observability/ci-types/{typeId}/linkage", h.linkage)
	r.Get("/v1/observability/ci/{ciId}/grafana", h.ciGrafana)
	r.Get("/v1/observability/ci/{ciId}/alerts", h.ciPromAlerts)
}

func (h *Handler) listLinks(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	provider := strings.TrimSpace(r.URL.Query().Get("provider"))
	rows, err := h.svc.ListLinks(r.Context(), provider)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rows, "total": len(rows)})
}

func (h *Handler) saveLink(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	provider := strings.TrimSpace(chi.URLParam(r, "provider"))
	typeID, err := pathID(w, r, "typeId")
	if err != nil {
		writeErr(w, err)
		return
	}
	var in biz.LinkInput
	if !decode(w, r, &in) {
		return
	}
	view, err := h.svc.SaveLink(r.Context(), provider, typeID, in)
	if err != nil {
		writeErr(w, err)
		return
	}
	auditmw.SetAuditEvent(r, bizaudit.Event{
		Action: auditmodel.ActionSettingUpdate, ResourceType: auditmodel.ResourceSetting,
		ResourceID: provider + "/" + strconv.FormatUint(typeID, 10), Status: auditmodel.StatusSuccess,
		Payload: map[string]any{"provider": provider, "ci_type_id": typeID, "enabled": view.Enabled},
	})
	writeJSON(w, http.StatusOK, view)
}

func (h *Handler) deleteLink(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	provider := strings.TrimSpace(chi.URLParam(r, "provider"))
	typeID, err := pathID(w, r, "typeId")
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := h.svc.DeleteLink(r.Context(), provider, typeID); err != nil {
		writeErr(w, err)
		return
	}
	auditmw.SetAuditEvent(r, bizaudit.Event{
		Action: auditmodel.ActionSettingDelete, ResourceType: auditmodel.ResourceSetting,
		ResourceID: provider + "/" + strconv.FormatUint(typeID, 10), Status: auditmodel.StatusSuccess,
		Payload: map[string]any{"provider": provider, "ci_type_id": typeID},
	})
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) previewLink(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	provider := strings.TrimSpace(r.URL.Query().Get("provider"))
	var body struct {
		CIID uint64 `json:"ci_id"`
		biz.LinkInput
	}
	if !decode(w, r, &body) {
		return
	}
	preview, err := h.svc.PreviewLink(r.Context(), provider, body.CIID, body.LinkInput)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, preview)
}

func (h *Handler) linkage(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireCaller(w, r); !ok {
		return
	}
	typeID, err := pathID(w, r, "typeId")
	if err != nil {
		writeErr(w, err)
		return
	}
	result, err := h.svc.Linkage(r.Context(), typeID)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) ciGrafana(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireCaller(w, r); !ok {
		return
	}
	ciID, err := pathID(w, r, "ciId")
	if err != nil {
		writeErr(w, err)
		return
	}
	result, err := h.svc.GrafanaForCI(r.Context(), ciID)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) ciPromAlerts(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireCaller(w, r); !ok {
		return
	}
	ciID, err := pathID(w, r, "ciId")
	if err != nil {
		writeErr(w, err)
		return
	}
	result, err := h.svc.PromAlertsForCI(r.Context(), ciID)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func requireCaller(w http.ResponseWriter, r *http.Request) (tenantctx.Tenant, bool) {
	tenant, ok := tenantctx.From(r.Context())
	if !ok {
		writeErr(w, errs.ErrUnauthorized)
		return tenantctx.Tenant{}, false
	}
	return tenant, true
}

func requireAdmin(w http.ResponseWriter, r *http.Request) (tenantctx.Tenant, bool) {
	tenant, ok := requireCaller(w, r)
	if !ok {
		return tenantctx.Tenant{}, false
	}
	if !(tenant.IsSuperuser || tenant.Role == "admin") {
		writeErr(w, errs.ErrForbidden)
		return tenantctx.Tenant{}, false
	}
	return tenant, true
}

func pathID(w http.ResponseWriter, r *http.Request, param string) (uint64, error) {
	id, err := strconv.ParseUint(chi.URLParam(r, param), 10, 64)
	if err != nil || id == 0 {
		err := errors.Join(errs.ErrInvalid, errors.New(param+" must be a positive integer"))
		writeErr(w, err)
		return 0, err
	}
	return id, nil
}

func decode(w http.ResponseWriter, r *http.Request, target any) bool {
	if err := json.NewDecoder(io.LimitReader(r.Body, maxBodyBytes)).Decode(target); err != nil {
		writeErr(w, errors.Join(errs.ErrInvalid, err))
		return false
	}
	return true
}

type errorBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if body == nil {
		return
	}
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, err error) {
	status := errs.HTTPStatus(err)
	code := errCode(err)
	switch {
	case errors.Is(err, biz.ErrCMDBUnavailable):
		status = http.StatusServiceUnavailable
		code = "cmdb-unavailable"
	case errors.Is(err, biz.ErrUpstream):
		status = http.StatusBadGateway
		code = "upstream"
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorBody{Error: err.Error(), Code: code})
}

func errCode(err error) string {
	switch {
	case errors.Is(err, errs.ErrNotFound):
		return "not-found"
	case errors.Is(err, errs.ErrUnauthorized):
		return "unauthorized"
	case errors.Is(err, errs.ErrForbidden):
		return "forbidden"
	case errors.Is(err, errs.ErrInvalid):
		return "invalid"
	default:
		return "internal"
	}
}
