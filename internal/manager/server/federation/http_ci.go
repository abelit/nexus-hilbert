package federation

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	bizaudit "github.com/ongridio/ongrid/internal/manager/biz/audit"
	biz "github.com/ongridio/ongrid/internal/manager/biz/federation"
	auditmodel "github.com/ongridio/ongrid/internal/manager/model/audit"
	model "github.com/ongridio/ongrid/internal/manager/model/federation"
	auditmw "github.com/ongridio/ongrid/internal/manager/server/middleware"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// P4 routes: CI type mappings, per-CI records and mapping preview.

func (h *Handler) registerCI(r chi.Router) {
	r.Get("/v1/federation/mappings", h.listMappings)
	r.Post("/v1/federation/mappings", h.saveMapping)
	r.Put("/v1/federation/mappings/{id}", h.updateMapping)
	r.Delete("/v1/federation/mappings/{id}", h.deleteMapping)
	r.Post("/v1/federation/mappings/preview", h.previewMapping)
	r.Get("/v1/federation/ci-types", h.listCITypes)
	r.Get("/v1/federation/ci-types/{typeId}/mapping", h.mappingStatus)
	r.Get("/v1/federation/ci/{ciId}/alerts", h.ciAlerts)
	r.Get("/v1/federation/ci/{ciId}/tickets", h.ciTickets)
}

type mappingDTO struct {
	CITypeID     uint64             `json:"ci_type_id"`
	ConnectionID uint64             `json:"connection_id"`
	Rows         []biz.FieldMapping `json:"field_mapping"`
	Enabled      *bool              `json:"enabled"`
}

func (d mappingDTO) toBiz() biz.MappingInput {
	return biz.MappingInput{
		CITypeID: d.CITypeID, ConnectionID: d.ConnectionID,
		Rows: d.Rows, Enabled: d.Enabled,
	}
}

func (h *Handler) listMappings(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	kind, ok := kindFromQuery(w, r)
	if !ok {
		return
	}
	var ciTypeID uint64
	if raw := strings.TrimSpace(r.URL.Query().Get("ci_type_id")); raw != "" {
		parsed, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			writeErr(w, errors.Join(errs.ErrInvalid, errors.New("ci_type_id is invalid")))
			return
		}
		ciTypeID = parsed
	}
	rows, err := h.svc.ListMappings(r.Context(), kind, ciTypeID)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rows, "total": len(rows)})
}

func (h *Handler) saveMapping(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	kind, ok := kindFromQuery(w, r)
	if !ok {
		return
	}
	var in mappingDTO
	if !decode(w, r, &in) {
		return
	}
	view, err := h.svc.SaveMapping(r.Context(), kind, in.toBiz(), 0)
	if err != nil {
		writeErr(w, err)
		return
	}
	auditMapping(r, auditmodel.ActionSettingUpdate, kind, view.ID, "create")
	writeJSON(w, http.StatusCreated, view)
}

func (h *Handler) updateMapping(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	kind, ok := kindFromQuery(w, r)
	if !ok {
		return
	}
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	var in mappingDTO
	if !decode(w, r, &in) {
		return
	}
	view, err := h.svc.SaveMapping(r.Context(), kind, in.toBiz(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	auditMapping(r, auditmodel.ActionSettingUpdate, kind, view.ID, "update")
	writeJSON(w, http.StatusOK, view)
}

func (h *Handler) deleteMapping(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	kind, ok := kindFromQuery(w, r)
	if !ok {
		return
	}
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	if err := h.svc.DeleteMapping(r.Context(), id); err != nil {
		writeErr(w, err)
		return
	}
	auditMapping(r, auditmodel.ActionSettingDelete, kind, id, "delete")
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) previewMapping(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	kind, ok := kindFromQuery(w, r)
	if !ok {
		return
	}
	var body struct {
		mappingDTO
		CIID uint64 `json:"ci_id"`
	}
	if !decode(w, r, &body) {
		return
	}
	preview, err := h.svc.PreviewMapping(r.Context(), kind, body.CIID, body.mappingDTO.toBiz())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, preview)
}

func (h *Handler) listCITypes(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	rows, err := h.svc.CITypes(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rows, "total": len(rows)})
}

func (h *Handler) mappingStatus(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireCaller(w, r); !ok {
		return
	}
	kind, ok := kindFromQuery(w, r)
	if !ok {
		return
	}
	typeID, err := strconv.ParseUint(chi.URLParam(r, "typeId"), 10, 64)
	if err != nil || typeID == 0 {
		writeErr(w, errors.Join(errs.ErrInvalid, errors.New("typeId must be a positive integer")))
		return
	}
	status, err := h.svc.MappingStatus(r.Context(), kind, typeID)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (h *Handler) ciAlerts(w http.ResponseWriter, r *http.Request) {
	h.ciItems(w, r, model.KindExternalAlert)
}

func (h *Handler) ciTickets(w http.ResponseWriter, r *http.Request) {
	h.ciItems(w, r, model.KindITSMTicket)
}

func (h *Handler) ciItems(w http.ResponseWriter, r *http.Request, kind string) {
	if _, ok := requireCaller(w, r); !ok {
		return
	}
	ciID, err := strconv.ParseUint(chi.URLParam(r, "ciId"), 10, 64)
	if err != nil || ciID == 0 {
		writeErr(w, errors.Join(errs.ErrInvalid, errors.New("ciId must be a positive integer")))
		return
	}
	days := 0
	if raw := strings.TrimSpace(r.URL.Query().Get("days")); raw != "" {
		parsed, parseErr := strconv.Atoi(raw)
		if parseErr != nil || parsed < 0 {
			writeErr(w, errors.Join(errs.ErrInvalid, errors.New("days is invalid")))
			return
		}
		days = parsed
	}
	result, err := h.svc.CIItems(r.Context(), kind, ciID, days)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func auditMapping(r *http.Request, action, kind string, id uint64, verb string) {
	auditmw.SetAuditEvent(r, bizaudit.Event{
		Action:       action,
		ResourceType: auditmodel.ResourceSetting,
		ResourceID:   kind + "/mapping/" + strconv.FormatUint(id, 10),
		Status:       auditmodel.StatusSuccess,
		Payload:      map[string]any{"kind": kind, "verb": verb},
	})
}
