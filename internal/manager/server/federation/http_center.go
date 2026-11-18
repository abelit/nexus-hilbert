package federation

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	bizaudit "github.com/ongridio/ongrid/internal/manager/biz/audit"
	biz "github.com/ongridio/ongrid/internal/manager/biz/federation"
	auditmodel "github.com/ongridio/ongrid/internal/manager/model/audit"
	model "github.com/ongridio/ongrid/internal/manager/model/federation"
	auditmw "github.com/ongridio/ongrid/internal/manager/server/middleware"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// P2 routes: configured center filters, display columns, field discovery,
// the per-viewer lens and stats. Read routes are available to any
// authenticated user; every mutation and discovery scan is admin-only.

func (h *Handler) registerCenter(r chi.Router) {
	r.Get("/v1/federation/center-filters/summaries", h.filterSummaries)
	r.Get("/v1/federation/center-filters", h.listFilters)
	r.Post("/v1/federation/center-filters", h.saveFilter)
	r.Put("/v1/federation/center-filters/{key}", h.updateFilter)
	r.Delete("/v1/federation/center-filters/{key}", h.deleteFilter)
	r.Post("/v1/federation/center-filters/preview", h.previewFilter)
	r.Get("/v1/federation/columns", h.getColumns)
	r.Put("/v1/federation/columns", h.putColumns)
	r.Post("/v1/federation/field-paths", h.fieldPaths)
	r.Get("/v1/federation/alerts/my", h.listMyAlerts)
	r.Get("/v1/federation/alerts/stats", h.alertStats)
	r.Get("/v1/federation/tickets/my", h.listMyTickets)
	r.Get("/v1/federation/tickets/stats", h.ticketStats)
}

type ruleDTO struct {
	Field     string   `json:"field"`
	Op        string   `json:"op"`
	ValueType string   `json:"value_type"`
	Identity  string   `json:"identity,omitempty"`
	Values    []string `json:"values,omitempty"`
}

type filterDTO struct {
	Key      string    `json:"key"`
	Name     string    `json:"name"`
	Usage    string    `json:"usage"`
	Enabled  *bool     `json:"enabled"`
	And      []ruleDTO `json:"and"`
	Or       []ruleDTO `json:"or"`
	Position int       `json:"position"`
}

func (d filterDTO) toBiz() biz.FilterInput {
	return biz.FilterInput{
		Key: d.Key, Name: d.Name, Usage: d.Usage, Enabled: d.Enabled,
		And: rulesToBiz(d.And), Or: rulesToBiz(d.Or), Position: d.Position,
	}
}

func rulesToBiz(in []ruleDTO) []biz.Rule {
	out := make([]biz.Rule, 0, len(in))
	for _, rule := range in {
		out = append(out, biz.Rule{
			Field: rule.Field, Op: rule.Op, ValueType: rule.ValueType,
			Identity: rule.Identity, Values: rule.Values,
		})
	}
	return out
}

type columnDTO struct {
	Key      string `json:"key"`
	Kind     string `json:"kind"`
	Path     string `json:"path,omitempty"`
	Render   string `json:"render,omitempty"`
	LabelZH  string `json:"label_zh,omitempty"`
	LabelEN  string `json:"label_en,omitempty"`
	Visible  bool   `json:"visible"`
	Position int    `json:"position"`
}

func columnFromModel(row model.DisplayColumn) columnDTO {
	return columnDTO{
		Key: row.ColumnKey, Kind: row.ColumnKind, Path: row.Path, Render: row.Render,
		LabelZH: row.LabelZH, LabelEN: row.LabelEN, Visible: row.Visible, Position: row.Position,
	}
}

func (h *Handler) listFilters(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	kind, ok := kindFromQuery(w, r)
	if !ok {
		return
	}
	rows, err := h.svc.ListFilters(r.Context(), kind)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rows, "total": len(rows)})
}

func (h *Handler) filterSummaries(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireCaller(w, r); !ok {
		return
	}
	kind, ok := kindFromQuery(w, r)
	if !ok {
		return
	}
	rows, err := h.svc.FilterSummaries(r.Context(), kind)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rows, "total": len(rows)})
}

func (h *Handler) saveFilter(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	kind, ok := kindFromQuery(w, r)
	if !ok {
		return
	}
	var in filterDTO
	if !decode(w, r, &in) {
		return
	}
	view, err := h.svc.SaveFilter(r.Context(), kind, in.toBiz(), "")
	if err != nil {
		writeErr(w, err)
		return
	}
	auditFilter(r, auditmodel.ActionSettingUpdate, kind, view)
	writeJSON(w, http.StatusCreated, view)
}

func (h *Handler) updateFilter(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	kind, ok := kindFromQuery(w, r)
	if !ok {
		return
	}
	key := strings.TrimSpace(chi.URLParam(r, "key"))
	if key == "" {
		writeErr(w, errors.Join(errs.ErrInvalid, errors.New("filter key is required")))
		return
	}
	var in filterDTO
	if !decode(w, r, &in) {
		return
	}
	view, err := h.svc.SaveFilter(r.Context(), kind, in.toBiz(), key)
	if err != nil {
		writeErr(w, err)
		return
	}
	auditFilter(r, auditmodel.ActionSettingUpdate, kind, view)
	writeJSON(w, http.StatusOK, view)
}

func (h *Handler) deleteFilter(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	kind, ok := kindFromQuery(w, r)
	if !ok {
		return
	}
	key := strings.TrimSpace(chi.URLParam(r, "key"))
	if err := h.svc.DeleteFilter(r.Context(), kind, key); err != nil {
		writeErr(w, err)
		return
	}
	auditmw.SetAuditEvent(r, bizaudit.Event{
		Action:       auditmodel.ActionSettingDelete,
		ResourceType: auditmodel.ResourceSetting,
		ResourceID:   kind + "/" + key,
		Status:       auditmodel.StatusSuccess,
		Payload:      map[string]any{"kind": kind, "filter_key": key},
	})
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) previewFilter(w http.ResponseWriter, r *http.Request) {
	caller, ok := requireAdmin(w, r)
	if !ok {
		return
	}
	kind, ok := kindFromQuery(w, r)
	if !ok {
		return
	}
	var in filterDTO
	if !decode(w, r, &in) {
		return
	}
	preview, err := h.svc.PreviewFilter(r.Context(), kind, in.toBiz(), caller.UserID)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, preview)
}

func (h *Handler) getColumns(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireCaller(w, r); !ok {
		return
	}
	kind, ok := kindFromQuery(w, r)
	if !ok {
		return
	}
	rows, err := h.svc.GetColumns(r.Context(), kind)
	if err != nil {
		writeErr(w, err)
		return
	}
	out := make([]columnDTO, 0, len(rows))
	for _, row := range rows {
		out = append(out, columnFromModel(row))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out, "total": len(out)})
}

func (h *Handler) putColumns(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	kind, ok := kindFromQuery(w, r)
	if !ok {
		return
	}
	var in []columnDTO
	if !decode(w, r, &in) {
		return
	}
	columns := make([]biz.DisplayColumn, 0, len(in))
	for _, col := range in {
		columns = append(columns, biz.DisplayColumn{
			ColumnKey: col.Key, ColumnKind: col.Kind, Path: col.Path, Render: col.Render,
			LabelZH: col.LabelZH, LabelEN: col.LabelEN, Visible: col.Visible, Position: col.Position,
		})
	}
	rows, err := h.svc.ReplaceColumns(r.Context(), kind, columns)
	if err != nil {
		writeErr(w, err)
		return
	}
	auditmw.SetAuditEvent(r, bizaudit.Event{
		Action:       auditmodel.ActionSettingUpdate,
		ResourceType: auditmodel.ResourceSetting,
		ResourceID:   kind + "/columns",
		Status:       auditmodel.StatusSuccess,
		Payload:      map[string]any{"kind": kind, "column_count": len(rows)},
	})
	out := make([]columnDTO, 0, len(rows))
	for _, row := range rows {
		out = append(out, columnFromModel(row))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out, "total": len(out)})
}

func (h *Handler) fieldPaths(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	kind, ok := kindFromQuery(w, r)
	if !ok {
		return
	}
	connectionID, ok := uintQuery(w, r.URL.Query().Get("connection_id"))
	if !ok {
		return
	}
	rows, err := h.svc.FieldPaths(r.Context(), kind, connectionID, r.URL.Query().Get("prefix"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rows, "total": len(rows)})
}

func (h *Handler) listMyAlerts(w http.ResponseWriter, r *http.Request) {
	caller, ok := requireCaller(w, r)
	if !ok {
		return
	}
	req, ok := parseListRequest(w, r)
	if !ok {
		return
	}
	result, err := h.svc.ListMine(r.Context(), model.KindExternalAlert, strings.TrimSpace(r.URL.Query().Get("scope")), req, caller.UserID)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) alertStats(w http.ResponseWriter, r *http.Request) {
	caller, ok := requireCaller(w, r)
	if !ok {
		return
	}
	req, ok := parseListRequest(w, r)
	if !ok {
		return
	}
	stats, err := h.svc.Stats(r.Context(), model.KindExternalAlert, strings.TrimSpace(r.URL.Query().Get("scope")), req, caller.UserID)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

func (h *Handler) listTickets(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireCaller(w, r); !ok {
		return
	}
	req, ok := parseListRequest(w, r)
	if !ok {
		return
	}
	result, err := h.svc.ListItems(r.Context(), model.KindITSMTicket, req)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) listMyTickets(w http.ResponseWriter, r *http.Request) {
	caller, ok := requireCaller(w, r)
	if !ok {
		return
	}
	req, ok := parseListRequest(w, r)
	if !ok {
		return
	}
	result, err := h.svc.ListMine(r.Context(), model.KindITSMTicket, strings.TrimSpace(r.URL.Query().Get("scope")), req, caller.UserID)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) ticketStats(w http.ResponseWriter, r *http.Request) {
	caller, ok := requireCaller(w, r)
	if !ok {
		return
	}
	req, ok := parseListRequest(w, r)
	if !ok {
		return
	}
	stats, err := h.svc.Stats(r.Context(), model.KindITSMTicket, strings.TrimSpace(r.URL.Query().Get("scope")), req, caller.UserID)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

func auditFilter(r *http.Request, action, kind string, view *biz.FilterView) {
	auditmw.SetAuditEvent(r, bizaudit.Event{
		Action:       action,
		ResourceType: auditmodel.ResourceSetting,
		ResourceID:   kind + "/" + view.Key,
		ResourceName: view.Name,
		Status:       auditmodel.StatusSuccess,
		Payload: map[string]any{
			"kind": kind, "filter_key": view.Key, "usage": view.Usage, "enabled": view.Enabled,
		},
	})
}
