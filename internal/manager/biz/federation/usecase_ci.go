package federation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	model "github.com/ongridio/ongrid/internal/manager/model/federation"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// ErrCMDBUnavailable means the CMDB service is not configured (or not
// reachable). The federation center keeps working; only CI-scoped views fail.
var ErrCMDBUnavailable = errors.New("federation: cmdb unavailable")

const (
	ciReasonNoMapping   = "no_mapping"
	ciReasonNoCIValue   = "no_ci_value"
	ciReasonUnreachable = "connection_unreachable"
	ciItemsCap          = 100
)

// SetCMDBReader wires the CMDB adapter after construction.
func (u *Usecase) SetCMDBReader(reader CMDBReader) { u.cmdb = reader }

// MappingInput is the write-side shape of a CI type -> source mapping.
type MappingInput struct {
	CITypeID     uint64         `json:"ci_type_id"`
	ConnectionID uint64         `json:"connection_id"`
	Rows         []FieldMapping `json:"field_mapping"`
	Enabled      *bool          `json:"enabled"`
}

// MappingView is the read-side shape.
type MappingView struct {
	ID           uint64         `json:"id"`
	Kind         string         `json:"kind"`
	CITypeID     uint64         `json:"ci_type_id"`
	ConnectionID uint64         `json:"connection_id"`
	Rows         []FieldMapping `json:"field_mapping"`
	Enabled      bool           `json:"enabled"`
}

// CITypeView is the settings selector's model projection.
type CITypeView struct {
	ID    uint64 `json:"id"`
	Name  string `json:"name"`
	Alias string `json:"alias,omitempty"`
}

// MappingStatus tells the CMDB drawer which tabs to render.
type MappingStatus struct {
	Configured bool `json:"configured"`
	HasMapping bool `json:"has_mapping"`
}

// CIItemsResult is one CI's merged upstream records.
type CIItemsResult struct {
	Kind       string            `json:"kind"`
	Configured bool              `json:"configured"`
	HasMapping bool              `json:"has_mapping"`
	Reason     string            `json:"reason,omitempty"`
	Total      int               `json:"total"`
	Items      []json.RawMessage `json:"items"`
}

// CIPreviewResult is a dry-run of one mapping against a real CI.
type CIPreviewResult struct {
	And     []string `json:"and"`
	Or      []string `json:"or"`
	Matched int      `json:"matched"`
	Reason  string   `json:"reason,omitempty"`
}

func (u *Usecase) ListMappings(ctx context.Context, kind string, ciTypeID uint64) ([]MappingView, error) {
	if !ValidKind(kind) {
		return nil, fmt.Errorf("%w: kind %q", errs.ErrInvalid, kind)
	}
	rows, err := u.repo.ListMappings(ctx, kind, ciTypeID)
	if err != nil {
		return nil, err
	}
	out := make([]MappingView, 0, len(rows))
	for i := range rows {
		view, err := mappingViewFromModel(&rows[i])
		if err != nil {
			return nil, err
		}
		out = append(out, view)
	}
	return out, nil
}

func (u *Usecase) SaveMapping(ctx context.Context, kind string, in MappingInput, id uint64) (*MappingView, error) {
	if !ValidKind(kind) {
		return nil, fmt.Errorf("%w: kind %q", errs.ErrInvalid, kind)
	}
	if in.CITypeID == 0 {
		return nil, fmt.Errorf("%w: ci_type_id is required", errs.ErrInvalid)
	}
	connection, err := u.repo.GetConnection(ctx, in.ConnectionID)
	if err != nil {
		return nil, err
	}
	if connection.Kind != kind {
		return nil, fmt.Errorf("%w: connection %d is not a %s source", errs.ErrInvalid, in.ConnectionID, kind)
	}
	rows, err := ValidateMapping(in.Rows)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errs.ErrInvalid, err)
	}
	// Validate the CI type when the model list is reachable. A down CMDB must
	// not block an administrator from saving a numeric type id.
	if u.cmdb != nil {
		if types, listErr := u.cmdb.ListCITypes(ctx); listErr == nil {
			found := false
			for _, ciType := range types {
				if ciType.ID == in.CITypeID {
					found = true
					break
				}
			}
			if !found {
				return nil, fmt.Errorf("%w: ci_type_id %d does not exist", errs.ErrInvalid, in.CITypeID)
			}
		}
	}
	raw, err := json.Marshal(rows)
	if err != nil {
		return nil, fmt.Errorf("%w: encode field mapping: %v", errs.ErrInvalid, err)
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	row := &model.CIMapping{
		Kind: kind, CITypeID: in.CITypeID, ConnectionID: in.ConnectionID,
		FieldMappingJSON: string(raw), Enabled: enabled,
	}
	if id > 0 {
		existing, getErr := u.repo.GetMapping(ctx, id)
		if getErr != nil {
			return nil, getErr
		}
		if existing.Kind != kind {
			return nil, fmt.Errorf("%w: mapping kind cannot change", errs.ErrInvalid)
		}
		row.ID = existing.ID
		if in.Enabled == nil {
			row.Enabled = existing.Enabled
		}
		if err := u.repo.UpdateMapping(ctx, row); err != nil {
			return nil, err
		}
	} else if err := u.repo.CreateMapping(ctx, row); err != nil {
		return nil, err
	}
	view, err := mappingViewFromModel(row)
	if err != nil {
		return nil, err
	}
	return &view, nil
}

func (u *Usecase) DeleteMapping(ctx context.Context, id uint64) error {
	return u.repo.DeleteMapping(ctx, id)
}

func (u *Usecase) MappingStatus(ctx context.Context, kind string, ciTypeID uint64) (*MappingStatus, error) {
	connections, err := u.repo.ListConnections(ctx, kind)
	if err != nil {
		return nil, err
	}
	mappings, err := u.repo.ListMappings(ctx, kind, ciTypeID)
	if err != nil {
		return nil, err
	}
	has := false
	for _, mapping := range mappings {
		if mapping.Enabled {
			has = true
			break
		}
	}
	return &MappingStatus{Configured: len(connections) > 0, HasMapping: has}, nil
}

func (u *Usecase) CITypes(ctx context.Context) ([]CITypeView, error) {
	if u.cmdb == nil {
		return nil, ErrCMDBUnavailable
	}
	types, err := u.cmdb.ListCITypes(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCMDBUnavailable, err)
	}
	out := make([]CITypeView, 0, len(types))
	for _, ciType := range types {
		out = append(out, CITypeView{ID: ciType.ID, Name: ciType.Name, Alias: ciType.Alias})
	}
	return out, nil
}

// CIItems returns one CI's enabled mappings' records, merged across
// connections and de-duplicated by item id.
func (u *Usecase) CIItems(ctx context.Context, kind string, ciID uint64, days int) (*CIItemsResult, error) {
	profile, ok := Profile(kind)
	if !ok {
		return nil, fmt.Errorf("%w: kind %q", errs.ErrInvalid, kind)
	}
	if u.cmdb == nil {
		return &CIItemsResult{Kind: kind, Configured: false, Reason: "cmdb_unavailable", Items: []json.RawMessage{}}, nil
	}
	ci, err := u.cmdb.GetInstance(ctx, ciID)
	if err != nil {
		return nil, err
	}
	mappings, err := u.repo.ListMappings(ctx, kind, ci.TypeID)
	if err != nil {
		return nil, err
	}
	enabled := make([]model.CIMapping, 0, len(mappings))
	for _, mapping := range mappings {
		if mapping.Enabled {
			enabled = append(enabled, mapping)
		}
	}
	if len(enabled) == 0 {
		return &CIItemsResult{Kind: kind, Configured: true, HasMapping: false, Reason: ciReasonNoMapping, Items: []json.RawMessage{}}, nil
	}

	if days < 1 {
		days = profile.DefaultDays
	}
	items := make([]json.RawMessage, 0)
	seen := map[string]bool{}
	sawNoValue := false
	sawFailure := false
	for i := range enabled {
		mapping := &enabled[i]
		connection, getErr := u.repo.GetConnection(ctx, mapping.ConnectionID)
		if getErr != nil || !connection.Enabled {
			sawFailure = true
			continue
		}
		rows, parseErr := mappingRows(mapping)
		if parseErr != nil {
			continue
		}
		and, or := BuildMapping(rows, ci.Values)
		if len(or) == 0 {
			sawNoValue = true
			continue
		}
		page, queryErr := u.querier.Query(ctx, connection, QueryRequest{
			Table: profile.DefaultTable, Days: days, Page: 1, PageSize: profile.MaxPageSize,
			Filters: and, OrFilters: or,
		})
		if queryErr != nil {
			sawFailure = true
			continue
		}
		for _, item := range page.Items {
			key := itemKey(item, kind)
			if key == "" || seen[key] {
				continue
			}
			seen[key] = true
			items = append(items, item)
		}
	}
	if len(items) == 0 {
		result := &CIItemsResult{Kind: kind, Configured: true, HasMapping: true, Items: []json.RawMessage{}}
		switch {
		case sawFailure:
			result.Reason = ciReasonUnreachable
		case sawNoValue:
			result.Reason = ciReasonNoCIValue
		}
		return result, nil
	}
	sort.SliceStable(items, func(i, j int) bool {
		return itemTime(items[i]) > itemTime(items[j])
	})
	total := len(items)
	if len(items) > ciItemsCap {
		items = items[:ciItemsCap]
	}
	return &CIItemsResult{Kind: kind, Configured: true, HasMapping: true, Total: total, Items: items}, nil
}

// PreviewMapping dry-runs candidate rows against a real CI.
func (u *Usecase) PreviewMapping(ctx context.Context, kind string, ciID uint64, in MappingInput) (*CIPreviewResult, error) {
	profile, ok := Profile(kind)
	if !ok {
		return nil, fmt.Errorf("%w: kind %q", errs.ErrInvalid, kind)
	}
	if u.cmdb == nil {
		return &CIPreviewResult{Reason: "cmdb_unavailable"}, nil
	}
	ci, err := u.cmdb.GetInstance(ctx, ciID)
	if err != nil {
		return nil, err
	}
	rows, err := ValidateMapping(in.Rows)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errs.ErrInvalid, err)
	}
	and, or := BuildMapping(rows, ci.Values)
	out := &CIPreviewResult{And: and, Or: or}
	if len(or) == 0 {
		out.Reason = ciReasonNoCIValue
		return out, nil
	}
	conn, err := u.pickConnection(ctx, kind, in.ConnectionID)
	if err != nil {
		return nil, err
	}
	if conn == nil {
		out.Reason = "not_configured"
		return out, nil
	}
	page, err := u.querier.Query(ctx, conn, QueryRequest{
		Table: profile.DefaultTable, Days: profile.DefaultDays,
		Page: 1, PageSize: 1, Filters: and, OrFilters: or,
	})
	if err != nil {
		return nil, err
	}
	out.Matched = page.Total
	return out, nil
}

func mappingViewFromModel(row *model.CIMapping) (MappingView, error) {
	rows, err := mappingRows(row)
	if err != nil {
		return MappingView{}, err
	}
	return MappingView{
		ID: row.ID, Kind: row.Kind, CITypeID: row.CITypeID,
		ConnectionID: row.ConnectionID, Rows: rows, Enabled: row.Enabled,
	}, nil
}

func mappingRows(row *model.CIMapping) ([]FieldMapping, error) {
	if strings.TrimSpace(row.FieldMappingJSON) == "" {
		return nil, nil
	}
	var rows []FieldMapping
	if err := json.Unmarshal([]byte(row.FieldMappingJSON), &rows); err != nil {
		return nil, fmt.Errorf("mapping %d has invalid field rows: %w", row.ID, err)
	}
	return rows, nil
}

func itemKey(raw json.RawMessage, kind string) string {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return string(raw)
	}
	keys := []string{"_id", "alert_id"}
	if kind == KindITSMTicket {
		keys = []string{"_id", "form_instance_id"}
	}
	for _, key := range keys {
		if value, ok := doc[key]; ok && value != nil {
			return fmt.Sprint(value)
		}
	}
	return string(raw)
}

func itemTime(raw json.RawMessage) string {
	var doc struct {
		CreatedAt    string `json:"created_at"`
		UpdatedAt    string `json:"updated_at"`
		CreateTime   string `json:"create_time"`
		FormCreateAt string `json:"form_create_time"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return ""
	}
	for _, value := range []string{doc.CreatedAt, doc.CreateTime, doc.FormCreateAt, doc.UpdatedAt} {
		if value != "" {
			if _, err := time.Parse(time.RFC3339, value); err == nil {
				return value
			}
			return value
		}
	}
	return ""
}
