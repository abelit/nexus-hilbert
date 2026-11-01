package ci

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	cibiz "github.com/ongridio/ongrid/internal/cmdb/biz/ci"
	model "github.com/ongridio/ongrid/internal/cmdb/model"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// rollbackRequest is the confirmation body. It names the rewind point and the
// audit fields; it deliberately carries NO attribute values, because the server
// recomputes them from the history at apply time.
type rollbackRequest struct {
	Before   string `json:"before"`
	RecordID int64  `json:"record_id"`

	Reason   string `json:"reason"`
	Origin   string `json:"origin"`
	TicketID string `json:"ticket_id"`
}

// baselineDTO is the preview and the applied result: what the instance looks
// like now, and what the rollback would (or did) restore.
type baselineDTO struct {
	CIID     model.ID               `json:"ci_id"`
	Before   string                 `json:"before,omitempty"`
	RecordID model.ID               `json:"record_id,omitempty"`
	Changes  []cibiz.BaselineChange `json:"changes"`
	Skipped  []cibiz.BaselineSkip   `json:"skipped"`
}

func newBaselineDTO(ciID model.ID, cutoff cibiz.RollbackCutoff, plan cibiz.BaselinePlan) baselineDTO {
	dto := baselineDTO{
		CIID: ciID, RecordID: cutoff.RecordID,
		Changes: plan.Changes, Skipped: plan.Skipped,
	}
	if !cutoff.Before.IsZero() {
		dto.Before = cutoff.Before.UTC().Format(time.RFC3339)
	}
	if dto.Changes == nil {
		dto.Changes = []cibiz.BaselineChange{}
	}
	if dto.Skipped == nil {
		dto.Skipped = []cibiz.BaselineSkip{}
	}
	return dto
}

// instanceBaseline previews a rollback.
//
//	GET /v1/cmdb/instances/{id}/baseline?before=...&record_id=...
//
// READ-ONLY: the console shows this diff before asking for confirmation.
func (h *Handler) instanceBaseline(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	query := r.URL.Query()
	recordID, err := optionalInt64(query.Get("record_id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	cutoff, err := parseCutoff(query.Get("before"), recordID)
	if err != nil {
		writeErr(w, err)
		return
	}
	plan, err := h.uc.PlanBaseline(r.Context(), id, cutoff)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, newBaselineDTO(id, cutoff, plan))
}

// rollbackInstance restores the values that were in place before the cutoff.
//
//	POST /v1/cmdb/instances/{id}/rollback
//
// The write is one ordinary update, so it inherits the update route's
// authorization and writes its own audit record.
func (h *Handler) rollbackInstance(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	var req rollbackRequest
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, maxWriteBody))
	if err := dec.Decode(&req); err != nil {
		writeErr(w, errs.ErrInvalid)
		return
	}
	cutoff, err := parseCutoff(req.Before, req.RecordID)
	if err != nil {
		writeErr(w, err)
		return
	}
	audit, err := actor(r, &instanceRequest{
		Origin: strings.TrimSpace(req.Origin), TicketID: strings.TrimSpace(req.TicketID),
		Reason: strings.TrimSpace(req.Reason),
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	plan, err := h.uc.Rollback(r.Context(), id, cutoff, audit)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, newBaselineDTO(id, cutoff, plan))
}

// parseCutoff validates the rewind point shared by the preview and the apply.
// A record id is preferred by the planner; the timestamp is still validated
// when both are supplied so a malformed value is reported rather than ignored.
func parseCutoff(before string, recordID int64) (cibiz.RollbackCutoff, error) {
	if recordID < 0 || recordID > int64(maxModelID) {
		return cibiz.RollbackCutoff{}, fmt.Errorf("%w: record_id", errs.ErrInvalid)
	}
	cutoff := cibiz.RollbackCutoff{RecordID: model.ID(recordID)}
	if raw := strings.TrimSpace(before); raw != "" {
		at, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return cibiz.RollbackCutoff{}, fmt.Errorf("%w: before", errs.ErrInvalid)
		}
		cutoff.Before = at
	}
	if cutoff.IsZero() {
		return cibiz.RollbackCutoff{}, fmt.Errorf("%w: before or record_id is required", errs.ErrInvalid)
	}
	return cutoff, nil
}

func optionalInt64(raw string) (int64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%w: record_id", errs.ErrInvalid)
	}
	return n, nil
}
