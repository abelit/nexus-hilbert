package cmdb

import (
	"fmt"
	"testing"
)

func TestCompactCIKeepsIdentityAndCapsAttributes(t *testing.T) {
	ci := map[string]any{
		"_id":        float64(1),
		"ci_id":      float64(1),
		"_type":      float64(2),
		"ci_type":    "host",
		"unique":     "web-01",
		"hostname":   "web-01",
		"private_ip": []any{"10.0.0.1"},
		"owner":      "ops",
		"nested":     map[string]any{"drop": true},
		"empty":      "",
	}
	for i := 0; i < 10; i++ {
		ci[fmt.Sprintf("attr_%d", i)] = i
	}

	got := CompactCI(ci, 5)
	for _, key := range []string{"_id", "ci_id", "_type", "ci_type", "unique"} {
		if _, ok := got[key]; !ok {
			t.Fatalf("identity key %q missing from %v", key, got)
		}
	}
	if _, ok := got["nested"]; ok {
		t.Fatalf("nested object should be dropped: %v", got)
	}
	if _, ok := got["empty"]; ok {
		t.Fatalf("empty value should be dropped: %v", got)
	}
	if _, ok := got["private_ip"]; !ok {
		t.Fatalf("list attribute should survive: %v", got)
	}
	nonIdentity := 0
	for key := range got {
		switch key {
		case "_id", "ci_id", "_type", "ci_type", "ci_type_alias", "unique", "unique_alias", "_updated_at", "_updated_by", "_created_at", "_created_by":
		default:
			nonIdentity++
		}
	}
	if nonIdentity > 5 {
		t.Fatalf("non-identity attributes = %d, want <= 5: %v", nonIdentity, got)
	}
}

func TestCompactCITypeKeepsModelIdentity(t *testing.T) {
	got := CompactCIType(map[string]any{
		"id": float64(3), "name": "host", "alias": "主机", "unique_key": "hostname",
		"enabled": true, "parent_ids": []any{float64(1)}, "icon": "x", "order": float64(9),
	})
	for _, key := range []string{"id", "name", "alias", "unique_key", "enabled", "parent_ids"} {
		if _, ok := got[key]; !ok {
			t.Fatalf("%q missing from %v", key, got)
		}
	}
	for _, key := range []string{"icon", "order"} {
		if _, ok := got[key]; ok {
			t.Fatalf("%q should be dropped: %v", key, got)
		}
	}
}

func TestTruncateAddsNote(t *testing.T) {
	items := make([]any, 21)
	for i := range items {
		items[i] = i
	}
	got := Truncate(items, 20, 21)
	if len(got["items"].([]any)) != 20 {
		t.Fatalf("items = %d, want 20", len(got["items"].([]any)))
	}
	if got["total"] != 21 {
		t.Fatalf("total = %v, want 21", got["total"])
	}
	if got["note"] == "" {
		t.Fatal("expected a truncation note")
	}

	small := Truncate([]any{1, 2}, 20, 2)
	if _, ok := small["note"]; ok {
		t.Fatalf("unexpected note for a small result: %v", small)
	}
}
