package citype

import (
	"context"
	"fmt"
	"log/slog"

	cibiz "github.com/ongridio/ongrid/internal/cmdb/biz/ci"
	model "github.com/ongridio/ongrid/internal/cmdb/model"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
	"github.com/ongridio/ongrid/internal/pkg/errs"
	"github.com/ongridio/ongrid/internal/pkg/secretbox"
)

// TriggerSource adapts stored trigger rows to the instance side's dispatcher.
//
// THE CREDENTIAL IS DECRYPTED HERE, not in the dispatcher. The instance engine
// has no business knowing how the configuration document seals its secrets; it
// receives the option with the authorization block removed and the plaintext
// values in a separate field, and it never writes either back to storage.
type TriggerSource struct {
	uc *Usecase
}

var _ cibiz.TriggerSource = (*TriggerSource)(nil)

// NewTriggerSource builds the adapter.
func NewTriggerSource(uc *Usecase) *TriggerSource { return &TriggerSource{uc: uc} }

// TriggersForType returns the model's live rules, credential decrypted.
func (s *TriggerSource) TriggersForType(ctx context.Context, typeID model.ID) ([]cibiz.TriggerConfig, error) {
	if s == nil || s.uc == nil || s.uc.repo == nil {
		return nil, errs.ErrNotWiredYet
	}
	rows, err := s.uc.repo.TriggersForType(ctx, typeID)
	if err != nil {
		return nil, err
	}
	out := make([]cibiz.TriggerConfig, 0, len(rows))
	for _, row := range rows {
		config, err := triggerConfigOf(row)
		if err != nil {
			// ONE UNREADABLE CREDENTIAL MUST NOT SILENCE THE WHOLE MODEL. The
			// broken rule is skipped (never sent unauthenticated) and named in
			// the log; the other rules still fire.
			s.uc.log.Warn("skipping trigger with an unreadable credential",
				slog.Any("trigger_id", row.ID), slog.Any("err", err))
			continue
		}
		out = append(out, *config)
	}
	return out, nil
}

// TriggerByID returns one rule, credential decrypted, or nil.
func (s *TriggerSource) TriggerByID(ctx context.Context, id model.ID) (*cibiz.TriggerConfig, error) {
	if s == nil || s.uc == nil || s.uc.repo == nil {
		return nil, errs.ErrNotWiredYet
	}
	row, err := s.uc.repo.TriggerByID(ctx, id)
	if err != nil || row == nil {
		return nil, err
	}
	return triggerConfigOf(*row)
}

func triggerConfigOf(row citypemodel.CITypeTrigger) (*cibiz.TriggerConfig, error) {
	authorization := map[string]string{}
	for key, sealed := range TriggerAuthorization(row.Notify) {
		plain, err := secretbox.Decrypt(sealed)
		if err != nil {
			// Fail closed. Sending the request without its credential would
			// turn a key-rotation mistake into a stream of 401s the receiver
			// sees but the operator only discovers from the firing history.
			return nil, fmt.Errorf("cmdb trigger %d: decrypt authorization %q: %w", row.ID, key, err)
		}
		authorization[key] = plain
	}
	return &cibiz.TriggerConfig{
		ID: row.ID, TypeID: row.TypeID, AttrID: row.AttrID,
		Option:        redactTriggerOption(row.Notify),
		Authorization: authorization,
	}, nil
}
