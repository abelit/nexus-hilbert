// Package federation exposes the federated external alert/ITSM sources over
// HTTP. The read paths are available to any authenticated user; configuration
// writes require a system administrator. Native /v1/alerts routes are not
// touched: this module owns only the external sources.
package federation

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
	biz "github.com/ongridio/ongrid/internal/manager/biz/federation"
	auditmodel "github.com/ongridio/ongrid/internal/manager/model/audit"
	model "github.com/ongridio/ongrid/internal/manager/model/federation"
	auditmw "github.com/ongridio/ongrid/internal/manager/server/middleware"
	svc "github.com/ongridio/ongrid/internal/manager/service/federation"
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
//	GET    /v1/federation/sources                  (admin)  — kind profiles
//	GET    /v1/federation/connections              (admin)  — masked list
//	POST   /v1/federation/connections              (admin)
//	GET    /v1/federation/connections/health       (admin)
//	POST   /v1/federation/connections/test         (admin)  — unsaved draft
//	GET    /v1/federation/connections/{id}         (admin)
//	PUT    /v1/federation/connections/{id}         (admin)
//	DELETE /v1/federation/connections/{id}         (admin)
//	POST   /v1/federation/connections/{id}/test    (admin)
//	GET    /v1/federation/connections/{id}/reveal  (admin)
//	GET    /v1/federation/alerts                   (any auth)
func (h *Handler) Register(r chi.Router) {
	r.Get("/v1/federation/sources", h.listSources)
	r.Get("/v1/federation/connections", h.listConnections)
	r.Post("/v1/federation/connections", h.createConnection)
	r.Get("/v1/federation/connections/health", h.health)
	r.Post("/v1/federation/connections/test", h.testConnection)
	r.Get("/v1/federation/connections/{id}", h.getConnection)
	r.Put("/v1/federation/connections/{id}", h.updateConnection)
	r.Delete("/v1/federation/connections/{id}", h.deleteConnection)
	r.Post("/v1/federation/connections/{id}/test", h.testSavedConnection)
	r.Get("/v1/federation/connections/{id}/reveal", h.reveal)
	r.Get("/v1/federation/alerts", h.listAlerts)
}

type authInput struct {
	Token    *string `json:"token"`
	Username *string `json:"username"`
	Password *string `json:"password"`
}

type connectionInput struct {
	Kind            string              `json:"kind"`
	Name            string              `json:"name"`
	BaseURL         string              `json:"base_url"`
	APIPath         string              `json:"api_path"`
	Method          string              `json:"method"`
	FixedParams     map[string][]string `json:"fixed_params"`
	AuthType        string              `json:"auth_type"`
	AuthData        *authInput          `json:"auth_data"`
	DefaultDays     int                 `json:"default_days"`
	DefaultPageSize int                 `json:"default_page_size"`
	TimeoutSeconds  int                 `json:"timeout_seconds"`
	IsDefault       *bool               `json:"is_default"`
	Enabled         *bool               `json:"enabled"`
	Remark          string              `json:"remark"`
}

func (in connectionInput) toBiz() biz.ConnectionInput {
	out := biz.ConnectionInput{
		Kind:            in.Kind,
		Name:            in.Name,
		BaseURL:         in.BaseURL,
		APIPath:         in.APIPath,
		Method:          in.Method,
		FixedParams:     in.FixedParams,
		AuthType:        in.AuthType,
		DefaultDays:     in.DefaultDays,
		DefaultPageSize: in.DefaultPageSize,
		TimeoutSeconds:  in.TimeoutSeconds,
		IsDefault:       in.IsDefault,
		Enabled:         in.Enabled,
		Remark:          in.Remark,
	}
	if in.AuthData != nil {
		out.Auth = &biz.Credentials{
			Token:    stringValue(in.AuthData.Token),
			Username: stringValue(in.AuthData.Username),
			Password: stringValue(in.AuthData.Password),
		}
	}
	return out
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (h *Handler) listSources(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	profiles := make([]biz.SourceProfile, 0, 2)
	for _, kind := range []string{model.KindExternalAlert, model.KindITSMTicket} {
		profile, _ := biz.Profile(kind)
		profiles = append(profiles, profile)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": profiles, "total": len(profiles)})
}

func (h *Handler) listConnections(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	kind, ok := kindFromQuery(w, r)
	if !ok {
		return
	}
	views, err := h.svc.ListConnections(r.Context(), kind)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": views, "total": len(views)})
}

func (h *Handler) createConnection(w http.ResponseWriter, r *http.Request) {
	caller, ok := requireAdmin(w, r)
	if !ok {
		return
	}
	var in connectionInput
	if !decode(w, r, &in) {
		return
	}
	view, err := h.svc.CreateConnection(r.Context(), in.toBiz(), caller.UserID)
	if err != nil {
		writeErr(w, err)
		return
	}
	h.audit(r, auditmodel.ActionSettingUpdate, view, "create")
	writeJSON(w, http.StatusCreated, view)
}

func (h *Handler) getConnection(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	view, err := h.svc.GetConnection(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (h *Handler) updateConnection(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	var in connectionInput
	if !decode(w, r, &in) {
		return
	}
	view, err := h.svc.UpdateConnection(r.Context(), id, in.toBiz())
	if err != nil {
		writeErr(w, err)
		return
	}
	h.audit(r, auditmodel.ActionSettingUpdate, view, "update")
	writeJSON(w, http.StatusOK, view)
}

func (h *Handler) deleteConnection(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	cascade := strings.EqualFold(r.URL.Query().Get("cascade"), "true")
	if err := h.svc.DeleteConnection(r.Context(), id, cascade); err != nil {
		writeErr(w, err)
		return
	}
	auditmw.SetAuditEvent(r, bizaudit.Event{
		Action:       auditmodel.ActionSettingDelete,
		ResourceType: auditmodel.ResourceSetting,
		ResourceID:   strconv.FormatUint(id, 10),
		Status:       auditmodel.StatusSuccess,
		Payload:      map[string]any{"kind": "federation_connection"},
	})
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) testConnection(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	var in connectionInput
	if !decode(w, r, &in) {
		return
	}
	if err := h.svc.TestConnection(r.Context(), in.toBiz()); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) testSavedConnection(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	if err := h.svc.TestSavedConnection(r.Context(), id); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) health(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	kind, ok := kindFromQuery(w, r)
	if !ok {
		return
	}
	rows, err := h.svc.ConnectionHealth(r.Context(), kind)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rows, "total": len(rows)})
}

func (h *Handler) reveal(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	creds, err := h.svc.RevealCredentials(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	// The secret is deliberately out of every audit payload and log line.
	h.log.Warn("federation: credential revealed", "connection_id", id)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{
		"token": creds.Token, "username": creds.Username, "password": creds.Password,
	})
}

func (h *Handler) listAlerts(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireCaller(w, r); !ok {
		return
	}
	req, ok := parseListRequest(w, r)
	if !ok {
		return
	}
	result, err := h.svc.ListItems(r.Context(), model.KindExternalAlert, req)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func parseListRequest(w http.ResponseWriter, r *http.Request) (biz.ListRequest, bool) {
	query := r.URL.Query()
	req := biz.ListRequest{
		StartDate: strings.TrimSpace(query.Get("start_date")),
		EndDate:   strings.TrimSpace(query.Get("end_date")),
		Status:    strings.TrimSpace(query.Get("status")),
		Severity:  strings.TrimSpace(query.Get("severity")),
		Keyword:   strings.TrimSpace(query.Get("keyword")),
	}
	var ok bool
	if req.ConnectionID, ok = uintQuery(w, query.Get("connection_id")); !ok {
		return biz.ListRequest{}, false
	}
	if req.Days, ok = intQuery(w, query.Get("days")); !ok {
		return biz.ListRequest{}, false
	}
	if req.Page, ok = intQuery(w, query.Get("page")); !ok {
		return biz.ListRequest{}, false
	}
	if req.PageSize, ok = intQuery(w, query.Get("page_size")); !ok {
		return biz.ListRequest{}, false
	}
	return req, true
}

func kindFromQuery(w http.ResponseWriter, r *http.Request) (string, bool) {
	kind := strings.TrimSpace(r.URL.Query().Get("kind"))
	if !biz.ValidKind(kind) {
		writeErr(w, errors.Join(errs.ErrInvalid, errors.New("kind must be external_alert or itsm_ticket")))
		return "", false
	}
	return kind, true
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

func parseID(w http.ResponseWriter, r *http.Request) (uint64, bool) {
	raw := chi.URLParam(r, "id")
	id, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || id == 0 {
		writeErr(w, errors.Join(errs.ErrInvalid, errors.New("id must be a positive integer")))
		return 0, false
	}
	return id, true
}

func intQuery(w http.ResponseWriter, raw string) (int, bool) {
	if strings.TrimSpace(raw) == "" {
		return 0, true
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 {
		writeErr(w, errors.Join(errs.ErrInvalid, errors.New("numeric query parameter is invalid")))
		return 0, false
	}
	return value, true
}

func uintQuery(w http.ResponseWriter, raw string) (uint64, bool) {
	if strings.TrimSpace(raw) == "" {
		return 0, true
	}
	value, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		writeErr(w, errors.Join(errs.ErrInvalid, errors.New("connection_id is invalid")))
		return 0, false
	}
	return value, true
}

func decode(w http.ResponseWriter, r *http.Request, target any) bool {
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxBodyBytes))
	if err := decoder.Decode(target); err != nil {
		writeErr(w, errors.Join(errs.ErrInvalid, err))
		return false
	}
	return true
}

func (h *Handler) audit(r *http.Request, action string, view *biz.ConnectionView, verb string) {
	auditmw.SetAuditEvent(r, bizaudit.Event{
		Action:       action,
		ResourceType: auditmodel.ResourceSetting,
		ResourceID:   strconv.FormatUint(view.ID, 10),
		ResourceName: view.Name,
		Status:       auditmodel.StatusSuccess,
		Payload: map[string]any{
			"verb":       verb,
			"kind":       view.Kind,
			"enabled":    view.Enabled,
			"is_default": view.IsDefault,
		},
	})
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
	case errors.Is(err, biz.ErrUpstream):
		status = http.StatusBadGateway
		code = "upstream"
	case errors.Is(err, biz.ErrCredentialUndecryptable):
		status = http.StatusBadGateway
		code = "credential-undecryptable"
	case errors.Is(err, biz.ErrWeakSecret):
		status = http.StatusBadRequest
		code = "secret-key-weak"
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
	case errors.Is(err, errs.ErrConflict):
		return "conflict"
	case errors.Is(err, errs.ErrInvalid):
		return "invalid"
	default:
		return "internal"
	}
}
