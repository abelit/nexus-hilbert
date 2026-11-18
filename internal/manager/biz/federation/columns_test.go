package federation

import (
	"strings"
	"testing"
)

func TestValidateColumnsNormalizesPositions(t *testing.T) {
	cols, err := ValidateColumns([]DisplayColumn{
		{ColumnKey: "status", ColumnKind: ColumnKindBuiltin, Visible: true, Position: 9},
		{ColumnKey: "owner", ColumnKind: ColumnKindCustom, Path: "form_data.owner.email", Render: RenderText, LabelZH: "负责人", LabelEN: "Owner", Visible: true, Position: 3},
	})
	if err != nil {
		t.Fatalf("ValidateColumns: %v", err)
	}
	if len(cols) != 2 || cols[0].Position != 0 || cols[1].Position != 1 {
		t.Fatalf("positions = %+v", cols)
	}
}

func TestValidateColumnsRejectsBadShapes(t *testing.T) {
	cases := []struct {
		name string
		cols []DisplayColumn
		want string
	}{
		{"duplicate", []DisplayColumn{
			{ColumnKey: "status", ColumnKind: ColumnKindBuiltin, Visible: true},
			{ColumnKey: "status", ColumnKind: ColumnKindBuiltin, Visible: true},
		}, "duplicate"},
		{"none visible", []DisplayColumn{
			{ColumnKey: "status", ColumnKind: ColumnKindBuiltin, Visible: false},
		}, "visible"},
		{"custom without path", []DisplayColumn{
			{ColumnKey: "owner", ColumnKind: ColumnKindCustom, Render: RenderText, LabelEN: "Owner", Visible: true},
		}, "path"},
		{"prototype path", []DisplayColumn{
			{ColumnKey: "owner", ColumnKind: ColumnKindCustom, Path: "a.__proto__.b", Render: RenderText, LabelEN: "Owner", Visible: true},
		}, "reserved"},
		{"bad render", []DisplayColumn{
			{ColumnKey: "owner", ColumnKind: ColumnKindCustom, Path: "a.b", Render: "html", LabelEN: "Owner", Visible: true},
		}, "render"},
		{"bad key", []DisplayColumn{
			{ColumnKey: "Owner Name", ColumnKind: ColumnKindBuiltin, Visible: true},
		}, "key"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ValidateColumns(tc.cols)
			if err == nil {
				t.Fatalf("expected error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want substring %q", err, tc.want)
			}
		})
	}
}

func TestReadPath(t *testing.T) {
	doc := map[string]any{
		"alert": map[string]any{"labels": map[string]any{"severity": "critical"}},
		"count": float64(3),
	}
	if got, ok := ReadPath(doc, "alert.labels.severity"); !ok || got != "critical" {
		t.Fatalf("ReadPath = %v %v", got, ok)
	}
	if _, ok := ReadPath(doc, "alert.labels.missing"); ok {
		t.Fatal("missing path resolved")
	}
	if _, ok := ReadPath(doc, "__proto__.x"); ok {
		t.Fatal("reserved path resolved")
	}
}
