package ciobs

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	bizaudit "github.com/ongridio/ongrid/internal/manager/biz/audit"
	biz "github.com/ongridio/ongrid/internal/manager/biz/ciobs"
	auditmodel "github.com/ongridio/ongrid/internal/manager/model/audit"
	auditmw "github.com/ongridio/ongrid/internal/manager/server/middleware"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// Connection management: the internal connection projects the platform
// integration, and can be enabled/configured without touching its credentials;
// external connections are admin-managed.

func (h *Handler) registerConnections(r chi.Router) {
	r.Get("/v1/observability/monitoring-connections", h.listConnections)
	r.Post("/v1/observability/monitoring-connections", h.saveConnection)
	r.Get("/v1/observability/monitoring-connections/health", h.connectionsHealth)
	r.Post("/v1/observability/monitoring-connections/test", h.testConnection)
	r.Put("/v1/observability/monitoring-connections/platform", h.setPlatformConnection)
	r.Put("/v1/observability/monitoring-connections/{id}", h.updateConnection)
	r.Delete("/v1/observability/monitoring-connections/{id}", h.deleteConnection)
	r.Post("/v1/observability/monitoring-connections/{id}/test", h.testSavedConnection)
}

type authInput struct {
	Token    *string `json:"token"`
	Username *string `json:"username"`
	Password *string `json:"password"`
}

type connectionDTO struct {
	Name        string     `json:"name"`
	BaseURL     string     `json:"base_url"`
	AuthType    string     `json:"auth_type"`
	AuthData    *authInput `json:"auth_data"`
	TLSInsecure *bool      `json:"tls_insecure"`
	Enabled     *bool      `json:"enabled"`
	Remark      string     `json:"remark"`
}

func (d connectionDTO) toBiz(provider string) biz.ConnectionInput {
	out := biz.ConnectionInput{
		Provider: provider, Name: d.Name, BaseURL: d.BaseURL, AuthType: d.AuthType,
		TLSInsecure: d.TLSInsecure, Enabled: d.Enabled, Remark: d.Remark,
	}
	if d.AuthData != nil {
		out.Auth = &biz.Credentials{
			Token:    stringValue(d.AuthData.Token),
			Username: stringValue(d.AuthData.Username),
			Password: stringValue(d.AuthData.Password),
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

func (h *Handler) listConnections(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	provider := strings.TrimSpace(r.URL.Query().Get("provider"))
	rows, err := h.svc.ListConnections(r.Context(), provider)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rows, "total": len(rows)})
}

func (h *Handler) saveConnection(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	provider := strings.TrimSpace(r.URL.Query().Get("provider"))
	var in connectionDTO
	if !decode(w, r, &in) {
		return
	}
	view, err := h.svc.SaveConnection(r.Context(), provider, in.toBiz(provider), 0)
	if err != nil {
		writeErr(w, err)
		return
	}
	auditConnection(r, auditmodel.ActionSettingUpdate, view, "create")
	writeJSON(w, http.StatusCreated, view)
}

type platformToggleDTO struct {
	Enabled *bool `json:"enabled"`
}

// setPlatformConnection toggles the internal (platform) connection without
// touching the global integration credentials.
func (h *Handler) setPlatformConnection(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	provider := strings.TrimSpace(r.URL.Query().Get("provider"))
	var in platformToggleDTO
	if !decode(w, r, &in) {
		return
	}
	if in.Enabled == nil {
		writeErr(w, fmt.Errorf("%w: enabled is required", errs.ErrInvalid))
		return
	}
	view, err := h.svc.SetInternalEnabled(r.Context(), provider, *in.Enabled)
	if err != nil {
		writeErr(w, err)
		return
	}
	auditmw.SetAuditEvent(r, bizaudit.Event{
		Action: auditmodel.ActionSettingUpdate, ResourceType: auditmodel.ResourceSetting,
		ResourceID: "ci-monitoring-connection/0", ResourceName: view.Name,
		Status: auditmodel.StatusSuccess,
		Payload: map[string]any{"provider": view.Provider, "kind": view.Kind, "verb": "toggle", "enabled": view.Enabled},
	})
	writeJSON(w, http.StatusOK, view)
}

func (h *Handler) updateConnection(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	provider := strings.TrimSpace(r.URL.Query().Get("provider"))
	id, err := pathID(w, r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	var in connectionDTO
	if !decode(w, r, &in) {
		return
	}
	view, err := h.svc.SaveConnection(r.Context(), provider, in.toBiz(provider), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	auditConnection(r, auditmodel.ActionSettingUpdate, view, "update")
	writeJSON(w, http.StatusOK, view)
}

func (h *Handler) deleteConnection(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	id, err := pathID(w, r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := h.svc.DeleteConnection(r.Context(), id); err != nil {
		writeErr(w, err)
		return
	}
	auditmw.SetAuditEvent(r, bizaudit.Event{
		Action: auditmodel.ActionSettingDelete, ResourceType: auditmodel.ResourceSetting,
		ResourceID: "ci-monitoring-connection/" + strconv.FormatUint(id, 10),
		Status:     auditmodel.StatusSuccess,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) testConnection(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	provider := strings.TrimSpace(r.URL.Query().Get("provider"))
	var in connectionDTO
	if !decode(w, r, &in) {
		return
	}
	if err := h.svc.TestConnection(r.Context(), provider, in.toBiz(provider)); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) testSavedConnection(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	id, err := pathID(w, r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := h.svc.TestSavedConnection(r.Context(), id); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) connectionsHealth(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	provider := strings.TrimSpace(r.URL.Query().Get("provider"))
	rows, err := h.svc.ConnectionsHealth(r.Context(), provider)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rows, "total": len(rows)})
}

func auditConnection(r *http.Request, action string, view *biz.ConnectionView, verb string) {
	auditmw.SetAuditEvent(r, bizaudit.Event{
		Action: action, ResourceType: auditmodel.ResourceSetting,
		ResourceID: "ci-monitoring-connection/" + strconv.FormatUint(view.ID, 10),
		ResourceName: view.Name, Status: auditmodel.StatusSuccess,
		Payload: map[string]any{"provider": view.Provider, "kind": view.Kind, "verb": verb, "enabled": view.Enabled},
	})
}
