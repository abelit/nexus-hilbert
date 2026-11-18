// Package federation holds persistence entities for the federated external
// alert/ITSM sources sub-domain.
//
// The two source kinds share every entity. "itsm_ticket" is deliberately not
// called an incident: the manager's existing Incident is the native alert
// lifecycle object (alert_incidents), while the ITSM source is a DingTalk
// ticket. Keeping the words apart in code prevents the two from being
// conflated by future readers.
package federation

import "time"

const (
	KindExternalAlert = "external_alert" // nexus-morse alert database
	KindITSMTicket    = "itsm_ticket"    // nexus-laplace-dingtalk ITSM
)

// ValidKind reports whether kind is one of the supported federation sources.
func ValidKind(kind string) bool {
	return kind == KindExternalAlert || kind == KindITSMTicket
}

const (
	UsageFilter = "filter"
	UsageBadge  = "badge"
	UsageBoth   = "both"
)

// ValidUsage reports whether usage can drive the center's scope dropdown.
func ValidUsage(usage string) bool {
	return usage == UsageFilter || usage == UsageBadge || usage == UsageBoth
}

const (
	RenderText  = "text"
	RenderTime  = "time"
	RenderBadge = "badge"
	RenderLink  = "link"
)

// ValidRender reports whether render is a supported display-column renderer.
func ValidRender(render string) bool {
	switch render {
	case RenderText, RenderTime, RenderBadge, RenderLink:
		return true
	default:
		return false
	}
}

const (
	ColumnKindBuiltin = "builtin"
	ColumnKindCustom  = "custom"
)

const (
	MapTypeField = "field"
	MapTypeFixed = "fixed"
)

const (
	ValueTypeIdentity = "identity"
	ValueTypeFixed    = "fixed"
)

// Rule is one predicate in a configured center filter. An identity rule is
// resolved against the caller; a fixed rule carries literal values.
type Rule struct {
	Field     string   `json:"field"`
	Op        string   `json:"op"`
	ValueType string   `json:"value_type"`
	Identity  string   `json:"identity,omitempty"`
	Values    []string `json:"values,omitempty"`
}

// FieldMapping is one row of a CI type -> source mapping. A "field" row
// compares a source field against a CMDB attribute; a "fixed" row compares it
// against a constant.
type FieldMapping struct {
	SourceField string `json:"source_field"`
	Op          string `json:"op"`
	MapType     string `json:"map_type"`
	Value       string `json:"value"`
}

// Connection is one configured upstream endpoint. Credentials live only in
// AuthCipher (secretbox), never in a plaintext column.
type Connection struct {
	ID              uint64    `gorm:"column:id;primaryKey;autoIncrement"`
	Kind            string    `gorm:"column:kind;size:24;not null;uniqueIndex:uniq_fed_conn_kind_name,priority:1"`
	Name            string    `gorm:"column:name;size:128;not null;uniqueIndex:uniq_fed_conn_kind_name,priority:2"`
	BaseURL         string    `gorm:"column:base_url;size:512;not null"`
	APIPath         string    `gorm:"column:api_path;size:512;not null"`
	Method          string    `gorm:"column:method;size:8;not null;default:'GET'"`
	FixedParamsJSON string    `gorm:"column:fixed_params_json;type:text;not null"`
	AuthType        string    `gorm:"column:auth_type;size:16;not null;default:'none'"`
	AuthCipher      string    `gorm:"column:auth_cipher;type:text;not null"`
	DefaultDays     int       `gorm:"column:default_days;not null;default:7"`
	DefaultPageSize int       `gorm:"column:default_page_size;not null;default:50"`
	TimeoutSeconds  int       `gorm:"column:timeout_seconds;not null;default:15"`
	IsDefault       bool      `gorm:"column:is_default;not null;default:false;index:idx_fed_conn_kind_default,priority:2"`
	Enabled         bool      `gorm:"column:enabled;not null;default:true;index:idx_fed_conn_kind_default,priority:1"`
	Remark          string    `gorm:"column:remark;size:512;not null;default:''"`
	CreatedBy       uint64    `gorm:"column:created_by;not null;default:0"`
	CreatedAt       time.Time `gorm:"column:created_at;autoCreateTime"`
	UpdatedAt       time.Time `gorm:"column:updated_at;autoUpdateTime"`
}

func (Connection) TableName() string { return "federation_connections" }

// CIMapping binds one CMDB CI type to one connection.
type CIMapping struct {
	ID               uint64    `gorm:"column:id;primaryKey;autoIncrement"`
	Kind             string    `gorm:"column:kind;size:24;not null;uniqueIndex:uniq_fed_map_kind_type_conn,priority:1;index:idx_fed_map_kind_type,priority:1"`
	CITypeID         uint64    `gorm:"column:ci_type_id;not null;uniqueIndex:uniq_fed_map_kind_type_conn,priority:2;index:idx_fed_map_kind_type,priority:2"`
	ConnectionID     uint64    `gorm:"column:connection_id;not null;uniqueIndex:uniq_fed_map_kind_type_conn,priority:3"`
	FieldMappingJSON string    `gorm:"column:field_mapping_json;type:text;not null"`
	Enabled          bool      `gorm:"column:enabled;not null;default:true;index:idx_fed_map_kind_type,priority:3"`
	CreatedAt        time.Time `gorm:"column:created_at;autoCreateTime"`
	UpdatedAt        time.Time `gorm:"column:updated_at;autoUpdateTime"`
}

func (CIMapping) TableName() string { return "federation_ci_mappings" }

// CenterFilter is one named AND/OR preset shown in the center's scope
// dropdown. At most one enabled filter per kind may carry the badge.
type CenterFilter struct {
	ID           uint64    `gorm:"column:id;primaryKey;autoIncrement"`
	Kind         string    `gorm:"column:kind;size:24;not null;uniqueIndex:uniq_fed_filter_kind_key,priority:1;index:idx_fed_filter_kind_pos,priority:1"`
	FilterKey    string    `gorm:"column:filter_key;size:32;not null;uniqueIndex:uniq_fed_filter_kind_key,priority:2"`
	Name         string    `gorm:"column:name;size:128;not null"`
	Usage        string    `gorm:"column:usage;size:8;not null;default:'filter'"`
	AndRulesJSON string    `gorm:"column:and_rules_json;type:text;not null"`
	OrRulesJSON  string    `gorm:"column:or_rules_json;type:text;not null"`
	Enabled      bool      `gorm:"column:enabled;not null;default:true;index:idx_fed_filter_kind_pos,priority:2"`
	Position     int       `gorm:"column:position;not null;default:0;index:idx_fed_filter_kind_pos,priority:3"`
	CreatedAt    time.Time `gorm:"column:created_at;autoCreateTime"`
	UpdatedAt    time.Time `gorm:"column:updated_at;autoUpdateTime"`
}

func (CenterFilter) TableName() string { return "federation_center_filters" }

// DisplayColumn is one ordered column in the center's table. Built-in columns
// are catalogued by the frontend; custom columns carry a source path.
type DisplayColumn struct {
	ID         uint64    `gorm:"column:id;primaryKey;autoIncrement"`
	Kind       string    `gorm:"column:kind;size:24;not null;uniqueIndex:uniq_fed_col_kind_key,priority:1;index:idx_fed_col_kind_pos,priority:1"`
	ColumnKey  string    `gorm:"column:column_key;size:64;not null;uniqueIndex:uniq_fed_col_kind_key,priority:2"`
	ColumnKind string    `gorm:"column:column_kind;size:16;not null;default:'builtin'"`
	Path       string    `gorm:"column:path;size:256;not null;default:''"`
	Render     string    `gorm:"column:render;size:16;not null;default:'text'"`
	LabelZH    string    `gorm:"column:label_zh;size:128;not null;default:''"`
	LabelEN    string    `gorm:"column:label_en;size:128;not null;default:''"`
	Visible    bool      `gorm:"column:visible;not null;default:true"`
	Position   int       `gorm:"column:position;not null;default:0;index:idx_fed_col_kind_pos,priority:2"`
	CreatedAt  time.Time `gorm:"column:created_at;autoCreateTime"`
	UpdatedAt  time.Time `gorm:"column:updated_at;autoUpdateTime"`
}

func (DisplayColumn) TableName() string { return "federation_display_columns" }
