package classmap

import (
	"strings"
	"testing"
)

func attr(name, valueType string) Attribute {
	return Attribute{Name: name, ValueType: valueType}
}

func TestPlanMapsClassAndAttributes(t *testing.T) {
	types := []Type{
		{
			Name: "dcim_rack", Alias: "机柜", UniqueAttr: "rack_name", ShowAttr: "rack_name",
			Parents: []string{"dcim_server_room"},
			Attributes: []Attribute{
				{Name: "rack_name", ValueType: "2", IsRequired: true, IsIndex: true},
				{Name: "u_count", ValueType: "0"},
				{Name: "u_start", ValueType: "0"},
			},
			Enabled: true,
		},
		{
			Name: "dcim_server_room", Alias: "机房", UniqueAttr: "room_name",
			Attributes: []Attribute{{Name: "room_name", ValueType: "2"}},
			Enabled:    true,
		},
	}
	mapping := map[string]string{
		"dcim_rack":        "Rack",
		"dcim_server_room": "Room",
	}
	profiles := map[string]Profile{
		"dcim_rack": {
			DisplayName: "Rack",
			Domain:      "infrastructure",
			Layer:       "hardware",
			Roles:       []string{"infrastructure"},
			SemanticBindings: map[string]string{
				"target_id": "rack_name",
			},
		},
	}

	report := Plan(types, mapping, profiles)
	if report.Blocked || report.Unresolved != 0 || report.Review != 0 {
		t.Fatalf("report = %+v", report)
	}
	m := report.Mappings[0]
	c := m.Class
	if c.ClassName != "Rack" || c.DisplayName != "Rack" || c.ParentClass != "Room" {
		t.Fatalf("class = %+v", c)
	}
	if c.Attributes["rack_name"] != "string" || c.Attributes["u_count"] != "int" {
		t.Fatalf("attributes = %+v", c.Attributes)
	}
	if !c.Constraints["rack_name"].Required {
		t.Fatalf("rack_name must be required: %+v", c.Constraints)
	}
	if len(c.IndexedKeys) != 1 || c.IndexedKeys[0] != "rack_name" {
		t.Fatalf("indexed_keys = %v", c.IndexedKeys)
	}
	if len(c.IdentityKeys) != 1 || c.IdentityKeys[0] != "rack_name" {
		t.Fatalf("identity_keys = %v", c.IdentityKeys)
	}
	if len(c.DisplayKeys) != 1 || c.DisplayKeys[0] != "rack_name" {
		t.Fatalf("display_keys = %v", c.DisplayKeys)
	}
	if len(c.Roles) != 1 || c.Roles[0] != "infrastructure" ||
		c.SemanticBindings["target_id"] != "rack_name" {
		t.Fatalf("roles/bindings = %+v / %+v", c.Roles, c.SemanticBindings)
	}
}

func TestPlanMapsListAndSpecialTypes(t *testing.T) {
	types := []Type{{
		Name: "host", Alias: "host", UniqueAttr: "name",
		Attributes: []Attribute{
			{Name: "name", ValueType: "2", IsRequired: true},
			{Name: "tags", ValueType: "2", IsList: true},
			{Name: "created_at", ValueType: "3"},
			{Name: "install_date", ValueType: "4"},
			{Name: "metadata", ValueType: "6"},
			{Name: "password", ValueType: "2", IsPassword: true},
			{Name: "rack_id", ValueType: "0", IsReference: true},
		},
		Enabled: true,
	}}
	report := Plan(types, nil, nil)
	if report.Blocked {
		t.Fatalf("report = %+v", report)
	}
	c := report.Mappings[0].Class
	want := map[string]string{
		"name": "string", "tags": "string_list", "created_at": "datetime",
		"install_date": "string", "metadata": "string", "password": "string",
		"rack_id": "int",
	}
	for name, typ := range want {
		if c.Attributes[name] != typ {
			t.Fatalf("%s type = %q, want %q", name, c.Attributes[name], typ)
		}
	}
	if c.Constraints["password"].Sensitivity != "secret" {
		t.Fatalf("password sensitivity = %+v", c.Constraints["password"])
	}
	notes := strings.Join(report.Mappings[0].Notes, "|")
	for _, want := range []string{"date", "json", "reference"} {
		if !strings.Contains(strings.ToLower(notes), want) {
			t.Fatalf("notes = %q, want %q", notes, want)
		}
	}
}

func TestPlanRejectsInvalidClassAndAttributeNames(t *testing.T) {
	types := []Type{{
		Name: "主机", Alias: "主机", UniqueAttr: "主机名",
		Attributes: []Attribute{{Name: "主机名", ValueType: "2"}},
		Enabled:    true,
	}}
	report := Plan(types, nil, nil)
	if report.Unresolved != 1 || !report.Blocked {
		t.Fatalf("report = %+v", report)
	}

	report = Plan(types, map[string]string{"主机": "Host"}, map[string]Profile{
		"主机": {AttributeNames: map[string]string{"主机名": "hostname"}},
	})
	if report.Unresolved != 0 || report.Blocked {
		t.Fatalf("mapped report = %+v", report)
	}
}

func TestPlanRejectsMultipleParentsWithoutOverride(t *testing.T) {
	types := []Type{{
		Name: "service", Alias: "service", UniqueAttr: "name",
		Parents:    []string{"application", "business"},
		Attributes: []Attribute{{Name: "name", ValueType: "2"}},
		Enabled:    true,
	}}
	report := Plan(types, nil, nil)
	if report.Unresolved != 1 || !strings.Contains(report.Mappings[0].Unresolved, "multiple inheritance") {
		t.Fatalf("report = %+v", report)
	}

	report = Plan(types, nil, map[string]Profile{"service": {ParentOverride: "BusinessService"}})
	if report.Unresolved != 0 || report.Mappings[0].Class.ParentClass != "BusinessService" {
		t.Fatalf("override report = %+v", report)
	}
}

func TestPlanRejectsDuplicateInheritedAttribute(t *testing.T) {
	types := []Type{
		{Name: "parent", Alias: "parent", UniqueAttr: "name", Enabled: true,
			Attributes: []Attribute{{Name: "name", ValueType: "2"}}},
		{Name: "child", Alias: "child", UniqueAttr: "name", Enabled: true,
			Parents:    []string{"parent"},
			Attributes: []Attribute{{Name: "name", ValueType: "2"}}},
	}
	report := Plan(types, nil, nil)
	if report.Unresolved != 1 || !strings.Contains(report.Mappings[1].Unresolved, "inherited") {
		t.Fatalf("report = %+v", report)
	}
}

func TestPlanReviewsDisabledModel(t *testing.T) {
	types := []Type{{
		Name: "old_host", Alias: "old host", UniqueAttr: "name", Enabled: false,
		Attributes: []Attribute{{Name: "name", ValueType: "2"}},
	}}
	report := Plan(types, nil, nil)
	if report.Review != 1 || !report.Blocked {
		t.Fatalf("report = %+v", report)
	}
	if !strings.Contains(strings.Join(report.Mappings[0].Notes, "|"), "disabled") {
		t.Fatalf("notes = %v", report.Mappings[0].Notes)
	}
}

func TestPlanRequiresCompleteClassMapping(t *testing.T) {
	types := []Type{{Name: "host", Alias: "host", UniqueAttr: "name", Enabled: true}}
	report := Plan(types, map[string]string{"other": "Other"}, nil)
	if report.Unresolved != 1 {
		t.Fatalf("report = %+v", report)
	}
}
