package ci

import (
	"fmt"
	"sort"
	"time"

	"github.com/ongridio/ongrid/internal/cmdb/model"
	"github.com/ongridio/ongrid/internal/cmdb/model/value"
)

// Why a changed attribute cannot take part in a rollback. The console maps
// these onto an explanation; the server never drops a change silently.
const (
	BaselineSkipSensitive   = "sensitive"
	BaselineSkipComputed    = "computed"
	BaselineSkipDynamic     = "dynamic"
	BaselineSkipUnsupported = "unsupported"
	BaselineSkipUnavailable = "unavailable"
	BaselineSkipRequired    = "required"
	BaselineSkipIdentity    = "identity"
)

// HistoryChange is one audit row after the rewind point.
type HistoryChange struct {
	RecordID    model.ID
	AttrID      model.ID
	OperateType string
	Old         *string
	New         *string
}

// BaselineChange is one attribute the rollback would restore, as the console
// presents it. Current and Target hold one display value per stored row, so a
// multi-valued attribute is shown as its ordered list.
type BaselineChange struct {
	AttrID    model.ID `json:"attr_id"`
	AttrName  string   `json:"attr_name"`
	AttrAlias string   `json:"attr_alias"`
	ValueType string   `json:"value_type,omitempty"`
	IsList    bool     `json:"is_list,omitempty"`
	Current   []string `json:"current"`
	Target    []string `json:"target"`
}

// BaselineSkip is a changed attribute the rollback leaves alone.
type BaselineSkip struct {
	AttrID    model.ID `json:"attr_id"`
	AttrName  string   `json:"attr_name"`
	AttrAlias string   `json:"attr_alias"`
	Reason    string   `json:"reason"`
}

// BaselinePlan is a computed rollback: what would change, what is skipped, and
// the exact values to write (keyed by attribute id).
type BaselinePlan struct {
	Changes []BaselineChange
	Skipped []BaselineSkip
	Values  map[model.ID]any
}

// PlanRollback reconstructs the instance's values as they were immediately
// before the supplied history rows and reports the attributes whose value
// differs from the current one.
//
// THE RECONSTRUCTION IS A REVERSE REPLAY. The history rows arrive in write
// order; undoing them from newest to oldest returns to the earlier state. For a
// scalar attribute the last undo wins, which is the value carried by the
// earliest change's Old. For a multi-valued attribute each ADD removes the value
// it added and each DELETE appends the value it removed — the same rule cantor's
// baseline used, including its inability to recover the original index of a
// removed list element.
//
// WHAT IS NOT RESTORED, and why:
//
//   - password, link and file values never enter the audit trail, so there is
//     nothing trustworthy to restore;
//   - computed and dynamic attributes are derived, not authored;
//   - JSON values are excluded because the audit writer stores them with
//     fmt.Sprint, which is not JSON; replaying it would write a corrupt value;
//   - an attribute that no longer belongs to the model cannot be written;
//   - clearing a required attribute would make the instance invalid.
//
// The caller applies Values through the ordinary update path, which validates
// them again and writes a new audit record for the rollback itself.
func PlanRollback(
	specs map[model.ID]AttributeSpec,
	current []ValueRow,
	history []HistoryChange,
) (BaselinePlan, error) {
	plan := BaselinePlan{Values: map[model.ID]any{}}

	currentByAttr := make(map[model.ID][]ValueRow, len(current))
	for _, row := range current {
		currentByAttr[row.AttrID] = append(currentByAttr[row.AttrID], row)
	}

	historyByAttr := make(map[model.ID][]HistoryChange, len(history))
	attrOrder := make([]model.ID, 0, len(history))
	for _, change := range history {
		if _, seen := historyByAttr[change.AttrID]; !seen {
			attrOrder = append(attrOrder, change.AttrID)
		}
		historyByAttr[change.AttrID] = append(historyByAttr[change.AttrID], change)
	}
	sort.Slice(attrOrder, func(i, j int) bool { return attrOrder[i] < attrOrder[j] })
	// Replaying backwards is what makes the newest write the first one undone.
	// The repository returns rows in record order; sorting here keeps the pure
	// function correct on its own.
	for _, changes := range historyByAttr {
		sort.SliceStable(changes, func(i, j int) bool { return changes[i].RecordID < changes[j].RecordID })
	}

	for _, attrID := range attrOrder {
		spec, known := specs[attrID]
		if !known {
			plan.Skipped = append(plan.Skipped, BaselineSkip{AttrID: attrID, Reason: BaselineSkipUnavailable})
			continue
		}
		if spec.IsPassword || spec.IsLink || spec.IsFile {
			plan.Skipped = append(plan.Skipped, skipOf(spec, BaselineSkipSensitive))
			continue
		}
		if spec.IsComputed || spec.HasComputeScript {
			plan.Skipped = append(plan.Skipped, skipOf(spec, BaselineSkipComputed))
			continue
		}
		if spec.IsDynamic {
			plan.Skipped = append(plan.Skipped, skipOf(spec, BaselineSkipDynamic))
			continue
		}
		if spec.ValueType == value.TypeJSON {
			plan.Skipped = append(plan.Skipped, skipOf(spec, BaselineSkipUnsupported))
			continue
		}

		changes := historyByAttr[attrID]
		if spec.Multivalued() {
			target, err := replayList(spec, currentByAttr[attrID], changes)
			if err != nil {
				plan.Skipped = append(plan.Skipped, skipOf(spec, BaselineSkipUnsupported))
				continue
			}
			currentValues, err := rowsAsStored(spec, currentByAttr[attrID])
			if err != nil {
				plan.Skipped = append(plan.Skipped, skipOf(spec, BaselineSkipUnsupported))
				continue
			}
			if sameSequence(spec.ValueType, currentValues, target) {
				continue
			}
			if len(target) == 0 {
				if reason := skipReasonForClearing(spec); reason != "" {
					plan.Skipped = append(plan.Skipped, skipOf(spec, reason))
					continue
				}
			}
			plan.Changes = append(plan.Changes, BaselineChange{
				AttrID: attrID, AttrName: spec.Name, AttrAlias: spec.Alias,
				ValueType: string(spec.ValueType), IsList: true,
				Current: displayAll(spec.ValueType, currentValues),
				Target:  displayAll(spec.ValueType, target),
			})
			values := make([]any, len(target))
			for i, item := range target {
				values[i] = item
			}
			plan.Values[attrID] = values
			continue
		}

		present, target, err := replayScalar(spec, currentByAttr[attrID], changes)
		if err != nil {
			plan.Skipped = append(plan.Skipped, skipOf(spec, BaselineSkipUnsupported))
			continue
		}
		currentPresent, currentValue, err := scalarFromRows(spec, currentByAttr[attrID])
		if err != nil {
			plan.Skipped = append(plan.Skipped, skipOf(spec, BaselineSkipUnsupported))
			continue
		}
		if present == currentPresent && (!present || displayStored(spec.ValueType, target) == displayStored(spec.ValueType, currentValue)) {
			continue
		}
		if !present {
			if reason := skipReasonForClearing(spec); reason != "" {
				plan.Skipped = append(plan.Skipped, skipOf(spec, reason))
				continue
			}
		}
		currentDisplay := []string{}
		if currentPresent {
			currentDisplay = []string{displayStored(spec.ValueType, currentValue)}
		}
		targetDisplay := []string{}
		if present {
			targetDisplay = []string{displayStored(spec.ValueType, target)}
		}
		plan.Changes = append(plan.Changes, BaselineChange{
			AttrID: attrID, AttrName: spec.Name, AttrAlias: spec.Alias,
			ValueType: string(spec.ValueType),
			Current:   currentDisplay, Target: targetDisplay,
		})
		if present {
			plan.Values[attrID] = target
		} else {
			plan.Values[attrID] = nil
		}
	}

	return plan, nil
}

func skipOf(spec AttributeSpec, reason string) BaselineSkip {
	return BaselineSkip{AttrID: spec.ID, AttrName: spec.Name, AttrAlias: spec.Alias, Reason: reason}
}

// skipReasonForClearing says why an "absent" target cannot be written, or ""
// when clearing is allowed. Losing the unique value would make the instance
// unaddressable, which is worse than an incomplete rollback.
func skipReasonForClearing(spec AttributeSpec) string {
	if spec.IsUnique {
		return BaselineSkipIdentity
	}
	if spec.IsRequired {
		return BaselineSkipRequired
	}
	return ""
}

// replayScalar walks the changes backwards. The final state of the walk is the
// value just before the earliest change.
func replayScalar(spec AttributeSpec, rows []ValueRow, changes []HistoryChange) (bool, value.StoredValue, error) {
	present, target, err := scalarFromRows(spec, rows)
	if err != nil {
		return false, nil, err
	}
	for i := len(changes) - 1; i >= 0; i-- {
		change := changes[i]
		switch model.OperateType(change.OperateType) {
		case model.OperateAdd:
			present, target = false, nil
		case model.OperateDelete, model.OperateUpdate:
			if change.Old == nil {
				continue
			}
			restored, err := canonical(spec.ValueType, *change.Old)
			if err != nil {
				return false, nil, err
			}
			present, target = true, restored
		}
	}
	return present, target, nil
}

// replayList undoes writes newest first. Within one write it removes the values
// an ADD introduced before re-appending the values a DELETE removed.
//
// THE WITHIN-WRITE ORDER IS LOAD-BEARING. A rewrite of an ordered list records
// its deletes first (in list order) and then its adds; undoing the whole batch
// in reverse would restore the right elements in the wrong order. Removing the
// added tail first, then appending the deleted tail in its recorded order,
// returns the original sequence.
func replayList(spec AttributeSpec, rows []ValueRow, changes []HistoryChange) ([]value.StoredValue, error) {
	target, err := rowsAsStored(spec, rows)
	if err != nil {
		return nil, err
	}

	for end := len(changes); end > 0; {
		recordID := changes[end-1].RecordID
		start := end - 1
		for start > 0 && changes[start-1].RecordID == recordID {
			start--
		}
		batch := changes[start:end]

		for _, change := range batch {
			switch model.OperateType(change.OperateType) {
			case model.OperateAdd:
				if change.New == nil {
					continue
				}
				added, err := canonical(spec.ValueType, *change.New)
				if err != nil {
					return nil, err
				}
				if index := lastIndexStored(target, added); index >= 0 {
					target = append(target[:index], target[index+1:]...)
				}
			case model.OperateDelete:
				continue
			default:
				// A list attribute does not produce UPDATE rows here; treating
				// one as a whole-list replacement would be a guess.
				return nil, fmt.Errorf("%w: list attribute received an update row", ErrUnknownAttribute)
			}
		}

		for _, change := range batch {
			if model.OperateType(change.OperateType) != model.OperateDelete {
				continue
			}
			if change.Old == nil {
				continue
			}
			removed, err := canonical(spec.ValueType, *change.Old)
			if err != nil {
				return nil, err
			}
			target = append(target, removed)
		}

		end = start
	}
	return target, nil
}

func scalarFromRows(spec AttributeSpec, rows []ValueRow) (bool, value.StoredValue, error) {
	if len(rows) == 0 {
		return false, nil, nil
	}
	stored, err := storedFromRow(spec, rows[0])
	if err != nil {
		return false, nil, err
	}
	return true, stored, nil
}

func rowsAsStored(spec AttributeSpec, rows []ValueRow) ([]value.StoredValue, error) {
	out := make([]value.StoredValue, 0, len(rows))
	for _, row := range rows {
		stored, err := storedFromRow(spec, row)
		if err != nil {
			return nil, err
		}
		out = append(out, stored)
	}
	return out, nil
}

func storedFromRow(spec AttributeSpec, row ValueRow) (value.StoredValue, error) {
	return canonical(spec.ValueType, rowText(row))
}

// canonical parses a stored value the way the write path would.
//
// writeAudit serialises a time.Time with fmt.Sprint, which appends a
// " +0000 UTC" zone suffix that ValueType.Validate cannot parse. History from
// this service therefore gets a second chance with Go's own layout; anything
// else that fails is reported so the attribute is skipped rather than guessed.
func canonical(vt value.ValueType, raw string) (value.StoredValue, error) {
	stored, err := vt.Validate(raw)
	if err == nil {
		return stored, nil
	}
	if vt == value.TypeDateTime || vt == value.TypeDate {
		if parsed, parseErr := time.Parse("2006-01-02 15:04:05 -0700 MST", raw); parseErr == nil {
			if vt == value.TypeDate {
				return time.Date(parsed.Year(), parsed.Month(), parsed.Day(), 0, 0, 0, 0, time.UTC), nil
			}
			return parsed, nil
		}
	}
	return nil, err
}

// displayStored renders a carrier for the preview. It normalises the two places
// where the stored shape is not what an operator reads: booleans (0/1) and
// timestamps (Go's default formatting).
func displayStored(vt value.ValueType, stored value.StoredValue) string {
	switch vt {
	case value.TypeBool:
		if n, ok := stored.(int32); ok {
			if n != 0 {
				return "true"
			}
			return "false"
		}
	case value.TypeDateTime:
		if t, ok := stored.(time.Time); ok {
			return t.Format("2006-01-02 15:04:05")
		}
	case value.TypeDate:
		if t, ok := stored.(time.Time); ok {
			return t.Format("2006-01-02")
		}
	}
	return fmt.Sprint(stored)
}

func displayAll(vt value.ValueType, stored []value.StoredValue) []string {
	out := make([]string, 0, len(stored))
	for _, item := range stored {
		out = append(out, displayStored(vt, item))
	}
	return out
}

func sameSequence(vt value.ValueType, left, right []value.StoredValue) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if displayStored(vt, left[i]) != displayStored(vt, right[i]) {
			return false
		}
	}
	return true
}

func lastIndexStored(values []value.StoredValue, needle value.StoredValue) int {
	want := fmt.Sprint(needle)
	for i := len(values) - 1; i >= 0; i-- {
		if fmt.Sprint(values[i]) == want {
			return i
		}
	}
	return -1
}
