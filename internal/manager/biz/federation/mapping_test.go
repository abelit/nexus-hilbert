package federation

import "testing"

func TestBuildMappingFieldRowsOrAndFixedRowsAnd(t *testing.T) {
	rows := []FieldMapping{
		{SourceField: "alert.labels.host", Op: "eq", MapType: MapTypeField, Value: "hostname"},
		{SourceField: "tenant", Op: "eq", MapType: MapTypeFixed, Value: "prod"},
	}
	and, or := BuildMapping(rows, map[string]any{"hostname": "web-1"})
	if len(or) != 1 || or[0] != "alert.labels.host:eq:web-1" {
		t.Fatalf("or = %v", or)
	}
	if len(and) != 1 || and[0] != "tenant:eq:prod" {
		t.Fatalf("and = %v", and)
	}
}

func TestBuildMappingDropsBlankAndMissingCIValues(t *testing.T) {
	rows := []FieldMapping{
		{SourceField: "host", Op: "eq", MapType: MapTypeField, Value: "hostname"},
		{SourceField: "ip", Op: "eq", MapType: MapTypeField, Value: "ip"},
		{SourceField: "empty", Op: "eq", MapType: MapTypeField, Value: "empty"},
	}
	_, or := BuildMapping(rows, map[string]any{"hostname": "web-1", "ip": "  ", "empty": nil})
	if len(or) != 1 || or[0] != "host:eq:web-1" {
		t.Fatalf("or = %v", or)
	}
}

func TestBuildMappingJoinsListValues(t *testing.T) {
	rows := []FieldMapping{{SourceField: "host", Op: "in", MapType: MapTypeField, Value: "hostnames"}}
	_, or := BuildMapping(rows, map[string]any{"hostnames": []string{"a", "b"}})
	if len(or) != 1 || or[0] != "host:in:a,b" {
		t.Fatalf("or = %v", or)
	}
}

func TestBuildMappingNoORMeansNoQuery(t *testing.T) {
	rows := []FieldMapping{{SourceField: "host", Op: "eq", MapType: MapTypeField, Value: "hostname"}}
	and, or := BuildMapping(rows, map[string]any{})
	if len(and) != 0 || len(or) != 0 {
		t.Fatalf("and=%v or=%v", and, or)
	}
}
