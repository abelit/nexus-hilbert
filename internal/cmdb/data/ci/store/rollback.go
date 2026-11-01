package store

import (
	"context"
	"fmt"

	cibiz "github.com/ongridio/ongrid/internal/cmdb/biz/ci"
	cmdbmodel "github.com/ongridio/ongrid/internal/cmdb/model"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// historyRow is the audit slice a rollback replays. It is deliberately narrow:
// the planner needs the operation type and the two values, not the labels the
// history page adds.
type historyRow struct {
	RecordID    cmdbmodel.ID  `gorm:"column:record_id"`
	AttrID      *cmdbmodel.ID `gorm:"column:attr_id"`
	OperateType *string       `gorm:"column:operate_type"`
	Old         *string       `gorm:"column:old"`
	New         *string       `gorm:"column:new"`
}

// LoadAttributeHistory returns this instance's attribute changes from the
// cutoff onward, oldest first.
//
// A RECORD ID IS AN EXACT CUTOFF; a timestamp is not. Two writes can share a
// timestamp at the column's precision, and undoing both when the operator
// selected one would change more than they asked for. The history page already
// knows the record id, so it sends that; the timestamp remains for the manual
// "roll back to this time" entry.
func (r *Repo) LoadAttributeHistory(ctx context.Context, ciID cmdbmodel.ID, cutoff cibiz.RollbackCutoff) ([]cibiz.HistoryChange, error) {
	if ciID == 0 || cutoff.IsZero() {
		return nil, fmt.Errorf("cmdb ci store: attribute history: %w", errs.ErrInvalid)
	}

	q := r.db.WithContext(ctx).Table("c_attribute_histories AS h").
		Joins("JOIN c_records AS r ON r.id = h.record_id").
		Where("h.ci_id = ? AND h.delete_marker = 0", ciID)
	if cutoff.RecordID > 0 {
		q = q.Where("h.record_id >= ?", cutoff.RecordID)
	} else {
		q = q.Where("r.created_at >= ?", cutoff.Before)
	}

	var rows []historyRow
	if err := q.Select(
		"h.record_id AS record_id, h.attr_id AS attr_id, h.operate_type AS operate_type, h.old AS old, h.new AS new",
	).Order("h.record_id ASC, h.id ASC").Scan(&rows).Error; err != nil {
		return nil, fmt.Errorf("cmdb ci store: attribute history: %w", err)
	}

	out := make([]cibiz.HistoryChange, 0, len(rows))
	for _, row := range rows {
		change := cibiz.HistoryChange{
			RecordID:    row.RecordID,
			OperateType: derefString(row.OperateType),
			Old:         row.Old,
			New:         row.New,
		}
		if row.AttrID != nil {
			change.AttrID = *row.AttrID
		}
		out = append(out, change)
	}
	return out, nil
}
