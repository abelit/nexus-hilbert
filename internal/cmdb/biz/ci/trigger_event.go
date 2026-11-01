package ci

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	"github.com/ongridio/ongrid/internal/cmdb/model/value"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// LatestTriggerEvent builds a sample event from the model's newest instance.
//
// IT EXISTS FOR THE MANUAL TEST-FIRE ROUTE. cantor fired a test against the
// first instance of the type so the request's templates resolved to real
// values; a test that sent `{{ hostname }}` literally told the operator nothing
// about their receiver. A model with no instances answers not-found, and the
// engine falls back to an empty payload rather than refusing the test.
func (u *Usecase) LatestTriggerEvent(ctx context.Context, typeID model.ID) (TriggerEvent, error) {
	if u.repo == nil || u.types == nil {
		return TriggerEvent{}, errs.ErrNotWiredYet
	}
	set, err := u.types.ResolveForCI(ctx, fmt.Sprint(typeID))
	if err != nil {
		return TriggerEvent{}, err
	}
	if set == nil {
		return TriggerEvent{}, ErrTypeNotFound
	}
	cis, _, err := u.repo.ListCIsByType(ctx, typeID, 1, 0)
	if err != nil {
		return TriggerEvent{}, err
	}
	if len(cis) == 0 {
		return TriggerEvent{TypeID: typeID, Values: map[string]string{}}, errs.ErrNotFound
	}
	rows, err := u.repo.LoadValueRows(ctx, cis[0].ID)
	if err != nil {
		return TriggerEvent{}, err
	}
	return buildTriggerEvent(set, cis[0].ID, "", nil, rows, AuditInfo{}), nil
}

// triggerEventFromCI loads the instance's current values and builds the event a
// write dispatches.
//
// THE READ HAPPENS AFTER THE WRITE and outside its transaction on purpose: the
// payload must describe what was committed, and reusing the caller's request
// values would omit defaults and computed columns. A failed read is logged and
// the event still fires with the values it does have — losing the read is not a
// reason to lose the notification the rule asked for.
func (u *Usecase) triggerEventFromCI(ctx context.Context, set *AttributeSet, ciID model.ID, kind model.OperateType, changes []Change, audit AuditInfo) TriggerEvent {
	var rows []ValueRow
	if u.repo != nil {
		loaded, err := u.repo.LoadValueRows(ctx, ciID)
		if err != nil {
			u.log.Warn("cmdb ci: could not load values for trigger event",
				slog.Any("ci_id", ciID), slog.Any("err", err))
		} else {
			rows = loaded
		}
	}
	return buildTriggerEvent(set, ciID, kind, changes, rows, audit)
}

// buildTriggerEvent renders the event snapshot, including the special keys
// cantor exposed to webhook templates (`_id`, `_type`, `ci_type`, `unique`) and
// the `old_<attribute>` keys an update adds.
func buildTriggerEvent(set *AttributeSet, ciID model.ID, kind model.OperateType, changes []Change, rows []ValueRow, audit AuditInfo) TriggerEvent {
	event := TriggerEvent{
		TypeID:         set.Type.ID,
		CIID:           ciID,
		Kind:           kind,
		ChangedAttrIDs: changedAttributeIDs(changes),
		Values:         triggerTemplateValues(set, ciID, rows),
		Actor:          audit.Actor,
		ActorEmail:     audit.ActorEmail,
	}
	for _, change := range changes {
		if change.RecordID > 0 {
			event.RecordID = change.RecordID
			break
		}
	}
	if kind == model.OperateUpdate {
		addOldTriggerValues(event.Values, set, changes)
	}
	if audit.ActorEmail != "" {
		event.Values["_updated_by"] = audit.ActorEmail
	}
	return event
}

func triggerTemplateValues(set *AttributeSet, ciID model.ID, rows []ValueRow) map[string]string {
	out := make(map[string]string, len(set.Specs)+6)
	grouped := groupRowsByAttr(rows)
	for id, spec := range set.Specs {
		// Passwords are never part of an event payload. cantor's CI dict
		// carried them and its webhook sender happily templated them into a
		// URL; that is a credential exfiltration path, not a feature.
		if spec.IsPassword {
			continue
		}
		list := grouped[id]
		if len(list) == 0 {
			continue
		}
		parts := make([]string, 0, len(list))
		for _, row := range list {
			if text := triggerValueString(triggerRowValue(row)); text != "" {
				parts = append(parts, text)
			}
		}
		text := strings.Join(parts, ", ")
		out[spec.Name] = text
		if spec.Alias != "" {
			out[spec.Alias] = text
		}
	}

	out["_id"] = fmt.Sprint(ciID)
	out["_type"] = fmt.Sprint(set.Type.ID)
	out["ci_type"] = set.Type.Name
	if set.Type.Alias != "" {
		out["ci_type_alias"] = set.Type.Alias
	}
	if set.UniqueAttr.ID != 0 {
		unique := out[set.UniqueAttr.Name]
		out["unique"] = unique
		if set.UniqueAttr.Alias != "" {
			out["unique_alias"] = unique
		}
	}
	return out
}

// addOldTriggerValues reproduces cantor's old_* payload keys: every current
// value is seeded first, then the changed attributes are replaced with the
// value history recorded. A template can therefore say `{{old_status}}` and get
// a value on every update, not only on the update that touched status.
func addOldTriggerValues(values map[string]string, set *AttributeSet, changes []Change) {
	seeded := make(map[string]string, len(values))
	for key, value := range values {
		if strings.HasPrefix(key, "old_") {
			continue
		}
		seeded["old_"+key] = value
	}
	for _, change := range changes {
		spec, ok := set.Specs[change.AttrID]
		if !ok || spec.IsPassword {
			continue
		}
		old := triggerValueString(change.Old)
		seeded["old_"+spec.Name] = old
		if spec.Alias != "" {
			seeded["old_"+spec.Alias] = old
		}
	}
	for key, value := range seeded {
		values[key] = value
	}
}

func changedAttributeIDs(changes []Change) []model.ID {
	if len(changes) == 0 {
		return nil
	}
	out := make([]model.ID, 0, len(changes))
	seen := make(map[model.ID]bool, len(changes))
	for _, change := range changes {
		if change.AttrID == 0 || seen[change.AttrID] {
			continue
		}
		seen[change.AttrID] = true
		out = append(out, change.AttrID)
	}
	return out
}

// triggerRowValue turns a stored row into the value a template sees. JSON is
// encoded rather than formatted as a Go map: a webhook body is JSON far more
// often than it is a Go-syntax dump.
func triggerRowValue(row ValueRow) any {
	switch row.Table {
	case value.TableIndexIntegers:
		return row.Int
	case value.TableIndexFloats:
		return row.Float
	case value.TableIndexDateTime:
		return row.Time
	case value.TableJSON:
		return row.JSON
	default:
		return row.Text
	}
}

func triggerValueString(raw any) string {
	switch v := raw.(type) {
	case nil:
		return ""
	case string:
		return v
	case time.Time:
		return v.Format("2006-01-02 15:04:05")
	case fmt.Stringer:
		return v.String()
	case map[string]any, []any, []string, []map[string]any:
		encoded, err := json.Marshal(v)
		if err != nil {
			return fmt.Sprint(v)
		}
		return string(encoded)
	default:
		return fmt.Sprint(v)
	}
}

// dispatchAfterWrite prepares and enqueues the event's firings.
//
// THE CONTEXT IS DETACHED FROM THE REQUEST. The write has already committed; a
// client that disconnects while the response is being written must not turn
// that committed change into a change whose triggers never fire. The timeout
// still bounds the two database reads the preparation does.
func (u *Usecase) dispatchAfterWrite(ctx context.Context, set *AttributeSet, ciID model.ID, kind model.OperateType, changes []Change, audit AuditInfo) {
	if u.triggers == nil || set == nil {
		return
	}
	triggerCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	event := u.triggerEventFromCI(triggerCtx, set, ciID, kind, changes, audit)
	u.sendTrigger(u.prepareTrigger(triggerCtx, set, event))
}

func (u *Usecase) sendTrigger(firings []TriggerFiring) {
	if u.triggers != nil && len(firings) > 0 {
		u.triggers.Send(firings)
	}
}

// prepareTrigger matches the event without sending. A delete calls it before
// removing the instance, because its filter and its values only exist while the
// row does.
func (u *Usecase) prepareTrigger(ctx context.Context, set *AttributeSet, event TriggerEvent) []TriggerFiring {
	if u.triggers == nil || set == nil {
		return nil
	}
	firings, err := u.triggers.Prepare(ctx, event)
	if err != nil {
		u.log.Warn("cmdb ci: could not prepare trigger event", slog.Any("err", err))
		return nil
	}
	return firings
}
