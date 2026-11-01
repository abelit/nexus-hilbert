package ci

import (
	"context"
	"fmt"
	"time"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// RollbackCutoff names the rewind point.
//
// RECORD ID WINS WHEN IT IS SET. Two writes can share a timestamp (MySQL's
// DATETIME precision is configurable), and rolling back both when the operator
// asked for one would silently undo a change they did not select. The history
// rows already carry their operation record id, so the console can name the
// exact write; the timestamp remains for the manual "roll back to a time"
// entry, which has no row to point at.
type RollbackCutoff struct {
	Before   time.Time
	RecordID model.ID
}

// IsZero reports whether the cutoff names no point at all.
func (c RollbackCutoff) IsZero() bool { return c.Before.IsZero() && c.RecordID == 0 }

// Describe labels the cutoff for the audit reason.
func (c RollbackCutoff) Describe() string {
	if !c.Before.IsZero() {
		return c.Before.UTC().Format(time.RFC3339)
	}
	return fmt.Sprintf("record %d", c.RecordID)
}

// PlanBaseline previews what a rollback to the cutoff would restore.
//
// IT IS READ-ONLY. The console shows the diff before asking for confirmation;
// a preview that wrote would make cancellation meaningless.
func (u *Usecase) PlanBaseline(ctx context.Context, ciID model.ID, cutoff RollbackCutoff) (BaselinePlan, error) {
	_, plan, err := u.planBaseline(ctx, ciID, cutoff)
	return plan, err
}

// Rollback restores the instance's attribute values as they were immediately
// before the cutoff and writes the restoration as one ordinary update, so the
// audit trail records who rolled back what and when.
//
// THE PLAN IS RECOMPUTED HERE rather than accepted from the preview request.
// The instance may have changed between preview and confirmation, and applying
// a stale list would overwrite those newer edits.
func (u *Usecase) Rollback(ctx context.Context, ciID model.ID, cutoff RollbackCutoff, audit AuditInfo) (BaselinePlan, error) {
	set, plan, err := u.planBaseline(ctx, ciID, cutoff)
	if err != nil {
		return BaselinePlan{}, err
	}
	if len(plan.Values) == 0 {
		return plan, nil
	}

	values := make(map[string]any, len(plan.Values))
	for attrID, value := range plan.Values {
		spec, known := set.Specs[attrID]
		if !known {
			continue
		}
		values[spec.Name] = value
	}
	if audit.Reason == "" {
		audit.Reason = "rollback to " + cutoff.Describe()
	}
	if _, err := u.Update(ctx, ciID, WriteRequest{Values: values, Audit: audit}); err != nil {
		return BaselinePlan{}, err
	}
	return plan, nil
}

// planBaseline loads the current state and the writes after the cutoff, then
// hands both to the pure planner.
func (u *Usecase) planBaseline(ctx context.Context, ciID model.ID, cutoff RollbackCutoff) (*AttributeSet, BaselinePlan, error) {
	if u.repo == nil || u.types == nil {
		return nil, BaselinePlan{}, errs.ErrNotWiredYet
	}
	if ciID <= 0 || cutoff.IsZero() {
		return nil, BaselinePlan{}, errs.ErrInvalid
	}
	ci, err := u.repo.LoadCI(ctx, ciID)
	if err != nil {
		return nil, BaselinePlan{}, err
	}
	if ci == nil {
		return nil, BaselinePlan{}, ErrInstanceNotFound
	}
	set, err := u.types.ResolveForCI(ctx, fmt.Sprint(ci.TypeID))
	if err != nil {
		return nil, BaselinePlan{}, err
	}
	if set == nil {
		return nil, BaselinePlan{}, fmt.Errorf("%w: model %d", ErrTypeNotFound, ci.TypeID)
	}

	rows, err := u.repo.LoadValueRows(ctx, ciID)
	if err != nil {
		return nil, BaselinePlan{}, err
	}
	history, err := u.repo.LoadAttributeHistory(ctx, ciID, cutoff)
	if err != nil {
		return nil, BaselinePlan{}, err
	}
	plan, err := PlanRollback(set.Specs, rows, history)
	if err != nil {
		return nil, BaselinePlan{}, err
	}
	return set, plan, nil
}
