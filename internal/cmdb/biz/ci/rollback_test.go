package ci

import (
	"reflect"
	"testing"
	"time"

	"github.com/ongridio/ongrid/internal/cmdb/model"
	"github.com/ongridio/ongrid/internal/cmdb/model/value"
)

// --- helpers ---

func strp(s string) *string { return &s }

func change(recordID, attrID model.ID, op model.OperateType, old, now string) HistoryChange {
	ch := HistoryChange{RecordID: recordID, AttrID: attrID, OperateType: string(op)}
	if op != model.OperateAdd {
		ch.Old = strp(old)
	}
	if op != model.OperateDelete {
		ch.New = strp(now)
	}
	return ch
}

func intRow(attrID model.ID, v int32) ValueRow {
	return ValueRow{AttrID: attrID, Table: value.TableIndexIntegers, Int: v}
}

func textRow(attrID model.ID, v string) ValueRow {
	return ValueRow{AttrID: attrID, Table: value.TableIndexTexts, Text: v}
}

func timeRow(attrID model.ID, t time.Time) ValueRow {
	return ValueRow{AttrID: attrID, Table: value.TableIndexDateTime, Time: t}
}

// --- scalar ---

func TestPlanRollbackRestoresAScalarUpdate(t *testing.T) {
	specs := specsOf(spec(1, "cpu_count", value.TypeInt))
	current := []ValueRow{intRow(1, 16)}
	history := []HistoryChange{change(100, 1, model.OperateUpdate, "8", "16")}

	plan, err := PlanRollback(specs, current, history)
	if err != nil {
		t.Fatalf("PlanRollback() error = %v", err)
	}
	if len(plan.Changes) != 1 {
		t.Fatalf("changes = %+v, want one", plan.Changes)
	}
	got := plan.Changes[0]
	if got.AttrName != "cpu_count" || got.AttrAlias != "cpu_count" {
		t.Fatalf("change labels = %+v", got)
	}
	if !reflect.DeepEqual(got.Current, []string{"16"}) || !reflect.DeepEqual(got.Target, []string{"8"}) {
		t.Fatalf("change = %+v, want 16 -> 8", got)
	}
	if plan.Values[1] != int32(8) {
		t.Fatalf("value = %#v, want int32(8)", plan.Values[1])
	}
}

// An attribute created after the cutoff did not exist at that point, so the
// rollback clears it rather than restoring anything.
func TestPlanRollbackClearsAnAttributeAddedAfterTheCutoff(t *testing.T) {
	specs := specsOf(spec(1, "description", value.TypeText))
	current := []ValueRow{textRow(1, "new")}
	history := []HistoryChange{change(100, 1, model.OperateAdd, "", "new")}

	plan, err := PlanRollback(specs, current, history)
	if err != nil {
		t.Fatalf("PlanRollback() error = %v", err)
	}
	if len(plan.Changes) != 1 {
		t.Fatalf("changes = %+v, want one", plan.Changes)
	}
	if !reflect.DeepEqual(plan.Changes[0].Target, []string{}) {
		t.Fatalf("target = %v, want empty", plan.Changes[0].Target)
	}
	got, ok := plan.Values[1]
	if !ok || got != nil {
		t.Fatalf("value = %#v (present=%v), want present nil", got, ok)
	}
}

func TestPlanRollbackRestoresADeletedAttribute(t *testing.T) {
	specs := specsOf(spec(1, "description", value.TypeText))
	history := []HistoryChange{change(100, 1, model.OperateDelete, "old", "")}

	plan, err := PlanRollback(specs, nil, history)
	if err != nil {
		t.Fatalf("PlanRollback() error = %v", err)
	}
	if len(plan.Changes) != 1 {
		t.Fatalf("changes = %+v, want one", plan.Changes)
	}
	if !reflect.DeepEqual(plan.Changes[0].Current, []string{}) || !reflect.DeepEqual(plan.Changes[0].Target, []string{"old"}) {
		t.Fatalf("change = %+v, want empty -> old", plan.Changes[0])
	}
	if plan.Values[1] != "old" {
		t.Fatalf("value = %#v, want old", plan.Values[1])
	}
}

// Every change after the cutoff is undone, not only the latest one.
func TestPlanRollbackUndoesEveryChangeAfterTheCutoff(t *testing.T) {
	specs := specsOf(spec(1, "cpu_count", value.TypeInt))
	current := []ValueRow{intRow(1, 16)}
	history := []HistoryChange{
		change(100, 1, model.OperateUpdate, "4", "8"),
		change(101, 1, model.OperateUpdate, "8", "16"),
	}

	plan, err := PlanRollback(specs, current, history)
	if err != nil {
		t.Fatalf("PlanRollback() error = %v", err)
	}
	if !reflect.DeepEqual(plan.Changes[0].Target, []string{"4"}) {
		t.Fatalf("target = %v, want 4", plan.Changes[0].Target)
	}
	if plan.Values[1] != int32(4) {
		t.Fatalf("value = %#v, want int32(4)", plan.Values[1])
	}
}

// --- multi-valued ---

// Replaying adds and deletes backwards restores both the elements and, for a
// delete-then-add ordering, the positions the current rows still preserve.
func TestPlanRollbackReversesListAddAndDelete(t *testing.T) {
	specs := specsOf(func() AttributeSpec { s := spec(1, "ips", value.TypeText); list(&s); return s }())
	current := []ValueRow{textRow(1, "a"), textRow(1, "c")}
	history := []HistoryChange{
		change(100, 1, model.OperateAdd, "", "c"),
		change(101, 1, model.OperateDelete, "b", ""),
	}

	plan, err := PlanRollback(specs, current, history)
	if err != nil {
		t.Fatalf("PlanRollback() error = %v", err)
	}
	if len(plan.Changes) != 1 {
		t.Fatalf("changes = %+v, want one", plan.Changes)
	}
	if !reflect.DeepEqual(plan.Changes[0].Current, []string{"a", "c"}) {
		t.Fatalf("current = %v", plan.Changes[0].Current)
	}
	if !reflect.DeepEqual(plan.Changes[0].Target, []string{"a", "b"}) {
		t.Fatalf("target = %v, want [a b]", plan.Changes[0].Target)
	}
	got, ok := plan.Values[1].([]any)
	if !ok || !reflect.DeepEqual(got, []any{"a", "b"}) {
		t.Fatalf("value = %#v, want [a b]", plan.Values[1])
	}
}

// An ordered-list rewrite records deletes first, then adds. Undoing the adds
// before re-appending the deletes in their recorded order restores the
// original tail; undoing the whole record in reverse would reverse it.
func TestPlanRollbackRestoresListOrderAfterAnOrderedRewrite(t *testing.T) {
	specs := specsOf(func() AttributeSpec { s := spec(1, "ips", value.TypeText); list(&s); return s }())
	current := []ValueRow{textRow(1, "a"), textRow(1, "x")}
	history := []HistoryChange{
		change(100, 1, model.OperateDelete, "b", ""),
		change(100, 1, model.OperateDelete, "c", ""),
		change(100, 1, model.OperateAdd, "", "x"),
	}

	plan, err := PlanRollback(specs, current, history)
	if err != nil {
		t.Fatalf("PlanRollback() error = %v", err)
	}
	if !reflect.DeepEqual(plan.Changes[0].Target, []string{"a", "b", "c"}) {
		t.Fatalf("target = %v, want [a b c]", plan.Changes[0].Target)
	}
	if got, ok := plan.Values[1].([]any); !ok || !reflect.DeepEqual(got, []any{"a", "b", "c"}) {
		t.Fatalf("value = %#v, want [a b c]", plan.Values[1])
	}
}

// --- skipped attributes ---

func TestPlanRollbackSkipsAttributesItCannotRestore(t *testing.T) {
	specs := specsOf(
		spec(1, "root_password", value.TypeText, password),
		spec(2, "computed", value.TypeText, scripted),
		spec(3, "labels", value.TypeJSON),
	)
	history := []HistoryChange{
		change(100, 1, model.OperateUpdate, "old", "new"),
		change(101, 2, model.OperateUpdate, "old", "new"),
		change(102, 3, model.OperateUpdate, `{"a":1}`, `{"a":2}`),
		change(103, 4, model.OperateUpdate, "old", "new"),
		change(104, 99, model.OperateUpdate, "old", "new"),
	}
	plan, err := PlanRollback(specs, nil, history)
	if err != nil {
		t.Fatalf("PlanRollback() error = %v", err)
	}
	if len(plan.Changes) != 0 || len(plan.Values) != 0 {
		t.Fatalf("plan = %+v, want no restorable changes", plan)
	}
	want := map[model.ID]string{
		1:  BaselineSkipSensitive,
		2:  BaselineSkipComputed,
		3:  BaselineSkipUnsupported,
		4:  BaselineSkipUnavailable,
		99: BaselineSkipUnavailable,
	}
	if len(plan.Skipped) != len(want) {
		t.Fatalf("skipped = %+v, want %d entries", plan.Skipped, len(want))
	}
	for _, item := range plan.Skipped {
		if want[item.AttrID] != item.Reason {
			t.Errorf("attr %d reason = %q, want %q", item.AttrID, item.Reason, want[item.AttrID])
		}
	}
}

func TestPlanRollbackSkipsClearingARequiredAttribute(t *testing.T) {
	specs := specsOf(spec(1, "hostname", value.TypeText, required))
	current := []ValueRow{textRow(1, "web-1")}
	history := []HistoryChange{change(100, 1, model.OperateAdd, "", "web-1")}

	plan, err := PlanRollback(specs, current, history)
	if err != nil {
		t.Fatalf("PlanRollback() error = %v", err)
	}
	if len(plan.Changes) != 0 || len(plan.Values) != 0 {
		t.Fatalf("plan = %+v, want nothing applied", plan)
	}
	if len(plan.Skipped) != 1 || plan.Skipped[0].Reason != BaselineSkipRequired {
		t.Fatalf("skipped = %+v, want one required skip", plan.Skipped)
	}
}

// An instance without its identifying value cannot be addressed afterwards, so
// a rollback never clears the unique attribute even when the model does not
// mark it required.
func TestPlanRollbackSkipsClearingTheUniqueAttribute(t *testing.T) {
	s := spec(1, "hostname", value.TypeText)
	s.IsUnique = true
	specs := specsOf(s)
	current := []ValueRow{textRow(1, "web-1")}
	history := []HistoryChange{change(100, 1, model.OperateAdd, "", "web-1")}

	plan, err := PlanRollback(specs, current, history)
	if err != nil {
		t.Fatalf("PlanRollback() error = %v", err)
	}
	if len(plan.Changes) != 0 || len(plan.Values) != 0 {
		t.Fatalf("plan = %+v, want nothing applied", plan)
	}
	if len(plan.Skipped) != 1 || plan.Skipped[0].Reason != BaselineSkipIdentity {
		t.Fatalf("skipped = %+v, want one identity skip", plan.Skipped)
	}
}

// --- no-op and formatting ---

func TestPlanRollbackIsEmptyWhenTheTargetAlreadyMatches(t *testing.T) {
	specs := specsOf(spec(1, "cpu_count", value.TypeInt))
	current := []ValueRow{intRow(1, 8)}
	history := []HistoryChange{change(100, 1, model.OperateUpdate, "8", "16")}

	plan, err := PlanRollback(specs, current, history)
	if err != nil {
		t.Fatalf("PlanRollback() error = %v", err)
	}
	if len(plan.Changes) != 0 || len(plan.Values) != 0 {
		t.Fatalf("plan = %+v, want no changes", plan)
	}
}

// writeAudit serialises a time.Time with fmt.Sprint, which carries a " +0000
// UTC" suffix that ValueType.Validate does not accept. The planner normalises
// it rather than failing the whole rollback.
func TestPlanRollbackParsesGoSerializedTimestamps(t *testing.T) {
	specs := specsOf(spec(1, "booted_at", value.TypeDateTime))
	current := []ValueRow{timeRow(1, time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC))}
	history := []HistoryChange{{
		RecordID: 100, AttrID: 1, OperateType: string(model.OperateUpdate),
		Old: strp("2026-09-01 10:00:00 +0000 UTC"),
		New: strp("2026-10-01 10:00:00 +0000 UTC"),
	}}

	plan, err := PlanRollback(specs, current, history)
	if err != nil {
		t.Fatalf("PlanRollback() error = %v", err)
	}
	if len(plan.Changes) != 1 {
		t.Fatalf("changes = %+v, want one", plan.Changes)
	}
	if !reflect.DeepEqual(plan.Changes[0].Target, []string{"2026-09-01 10:00:00"}) {
		t.Fatalf("target = %v", plan.Changes[0].Target)
	}
	got, ok := plan.Values[1].(time.Time)
	if !ok || !got.Equal(time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)) {
		t.Fatalf("value = %#v, want 2026-09-01 10:00:00 UTC", plan.Values[1])
	}
}

// A boolean is stored as 0/1; the preview should say true/false, not 1/0.
func TestPlanRollbackFormatsBooleanValues(t *testing.T) {
	specs := specsOf(spec(1, "enabled", value.TypeBool))
	current := []ValueRow{intRow(1, 1)}
	history := []HistoryChange{change(100, 1, model.OperateUpdate, "0", "1")}

	plan, err := PlanRollback(specs, current, history)
	if err != nil {
		t.Fatalf("PlanRollback() error = %v", err)
	}
	if !reflect.DeepEqual(plan.Changes[0].Current, []string{"true"}) ||
		!reflect.DeepEqual(plan.Changes[0].Target, []string{"false"}) {
		t.Fatalf("change = %+v, want true -> false", plan.Changes[0])
	}
}
