package federation

import (
	"encoding/json"
	"testing"
)

func TestValidKind(t *testing.T) {
	for _, kind := range []string{KindExternalAlert, KindITSMTicket} {
		if !ValidKind(kind) {
			t.Fatalf("ValidKind(%q) = false", kind)
		}
	}
	for _, kind := range []string{"", "alert", "incident", "EXTERNAL_ALERT"} {
		if ValidKind(kind) {
			t.Fatalf("ValidKind(%q) = true", kind)
		}
	}
}

func TestTableNames(t *testing.T) {
	cases := []struct {
		table string
		want  string
	}{
		{Connection{}.TableName(), "federation_connections"},
		{CIMapping{}.TableName(), "federation_ci_mappings"},
		{CenterFilter{}.TableName(), "federation_center_filters"},
		{DisplayColumn{}.TableName(), "federation_display_columns"},
	}
	for _, tc := range cases {
		if tc.table != tc.want {
			t.Fatalf("table = %q, want %q", tc.table, tc.want)
		}
	}
}

func TestFilterRulesJSONRoundTrip(t *testing.T) {
	rules := []Rule{
		{Field: "alert.labels.host", Op: "eq", ValueType: ValueTypeIdentity, Identity: "email"},
		{Field: "status", Op: "in", ValueType: ValueTypeFixed, Values: []string{"firing", "acked"}},
		{Field: "alertname", Op: "regex", ValueType: ValueTypeFixed, Values: []string{"^Disk.*"}},
	}
	raw, err := json.Marshal(rules)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var back []Rule
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(back) != 3 || back[0].Identity != "email" || len(back[1].Values) != 2 || back[2].Op != "regex" {
		t.Fatalf("round trip = %+v", back)
	}
}

func TestFieldMappingJSONRoundTrip(t *testing.T) {
	rows := []FieldMapping{
		{SourceField: "alert.labels.host", Op: "eq", MapType: MapTypeField, Value: "hostname"},
		{SourceField: "tenant", Op: "eq", MapType: MapTypeFixed, Value: "prod"},
	}
	raw, err := json.Marshal(rows)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var back []FieldMapping
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(back) != 2 || back[0].MapType != MapTypeField || back[1].Value != "prod" {
		t.Fatalf("round trip = %+v", back)
	}
}

func TestUsageAndRenderConstants(t *testing.T) {
	if !ValidUsage(UsageFilter) || !ValidUsage(UsageBadge) || !ValidUsage(UsageBoth) {
		t.Fatal("expected known usages to be valid")
	}
	if ValidUsage("other") {
		t.Fatal("unknown usage accepted")
	}
	for _, render := range []string{RenderText, RenderTime, RenderBadge, RenderLink} {
		if !ValidRender(render) {
			t.Fatalf("ValidRender(%q) = false", render)
		}
	}
	if ValidRender("html") {
		t.Fatal("unknown render accepted")
	}
}
