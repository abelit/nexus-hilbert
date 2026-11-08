package cmdb

import (
	"fmt"
	"sort"
)

// ciIdentityKeys are the fields that make a CI recognisable in a list. They
// always survive compaction; everything else is budgeted.
var ciIdentityKeys = []string{
	"_id", "ci_id", "_type", "ci_type", "ci_type_alias",
	"unique", "unique_alias",
	"_created_at", "_created_by", "_updated_at", "_updated_by",
}

var ciTypeSummaryKeys = []string{
	"id", "name", "alias", "unique_key", "enabled", "deleted", "parent_ids",
}

func identitySet() map[string]struct{} {
	out := make(map[string]struct{}, len(ciIdentityKeys))
	for _, k := range ciIdentityKeys {
		out[k] = struct{}{}
	}
	return out
}

// CompactCI keeps identity fields plus at most maxAttrs other attributes.
// Nested objects are noise for the model and are dropped; list attributes
// (private_ip, tags) are how a machine is recognised and survive.
//
// Selection is sorted by key so the same CI always yields the same summary,
// which keeps tool output stable across turns.
func CompactCI(ci map[string]any, maxAttrs int) map[string]any {
	if ci == nil {
		return nil
	}
	identity := identitySet()
	out := make(map[string]any, len(ciIdentityKeys)+maxAttrs)
	for _, key := range ciIdentityKeys {
		if v, ok := ci[key]; ok && !isEmpty(v) {
			out[key] = v
		}
	}

	keys := make([]string, 0, len(ci))
	for key := range ci {
		if _, isIdentity := identity[key]; isIdentity {
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)

	// List attributes first: private_ip / tags are how a machine is
	// recognised, so they outrank scalar noise when the budget is tight.
	kept := 0
	for _, listPass := range []bool{true, false} {
		for _, key := range keys {
			if kept >= maxAttrs {
				break
			}
			v := ci[key]
			if isEmpty(v) || !keepable(v) {
				continue
			}
			_, isList := v.([]any)
			if isList != listPass {
				continue
			}
			out[key] = v
			kept++
		}
	}
	return out
}

// CompactCIType summarises a model row: enough to identify it and understand
// its behaviour, without the presentation fields (icon, order, timestamps).
func CompactCIType(t map[string]any) map[string]any {
	if t == nil {
		return nil
	}
	out := make(map[string]any, len(ciTypeSummaryKeys))
	for _, key := range ciTypeSummaryKeys {
		if v, ok := t[key]; ok && !isEmpty(v) {
			out[key] = v
		}
	}
	return out
}

// Truncate wraps a list result with the real total and a note when the caller
// is seeing less than the backend matched.
func Truncate(items []any, max, total int) map[string]any {
	if max < 0 {
		max = 0
	}
	if total < len(items) {
		total = len(items)
	}
	shown := len(items)
	if shown > max {
		shown = max
	}
	out := map[string]any{
		"items": items[:shown],
		"total": total,
	}
	if len(items) > max || total > max {
		out["note"] = fmt.Sprintf(
			"Results truncated: showing %d of %d. Narrow the query (q / fl) or page through the rest.",
			shown, total,
		)
	}
	return out
}

func isEmpty(v any) bool {
	switch value := v.(type) {
	case nil:
		return true
	case string:
		return value == ""
	case []any:
		return len(value) == 0
	case map[string]any:
		return len(value) == 0
	default:
		return false
	}
}

// keepable drops nested objects but keeps scalars and flat lists.
func keepable(v any) bool {
	switch value := v.(type) {
	case map[string]any:
		return false
	case []any:
		for _, item := range value {
			switch item.(type) {
			case map[string]any, []any:
				return false
			}
		}
		return true
	default:
		return true
	}
}
