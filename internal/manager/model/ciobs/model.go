// Package ciobs holds the CI monitoring-link entity. A link points at the
// global Grafana or Prometheus integration; it never stores a credential.
package ciobs

import "time"

const (
	ProviderGrafana    = "grafana"
	ProviderPrometheus = "prometheus"
)

const (
	OpenModeLink  = "link"
	OpenModeEmbed = "embed"
)

// Connection kinds are API-level concepts: an "internal" connection is the
// platform's global Grafana/Prometheus integration and is never stored here.
const (
	ConnectionKindInternal = "internal"
	ConnectionKindExternal = "external"
)

// Connection is one administrator-managed EXTERNAL Grafana/Prometheus. The
// internal connection is derived from system_settings and has no row.
type Connection struct {
	ID          uint64 `gorm:"column:id;primaryKey;autoIncrement"`
	Provider    string `gorm:"column:provider;size:16;not null;uniqueIndex:uniq_ciobs_conn_provider_name,priority:1"`
	Name        string `gorm:"column:name;size:128;not null;uniqueIndex:uniq_ciobs_conn_provider_name,priority:2"`
	BaseURL     string `gorm:"column:base_url;size:512;not null"`
	AuthType    string `gorm:"column:auth_type;size:16;not null;default:'none'"`
	AuthCipher  string `gorm:"column:auth_cipher;type:text;not null"`
	TLSInsecure bool   `gorm:"column:tls_insecure;not null"`
	Enabled     bool   `gorm:"column:enabled;not null"`
	Remark      string `gorm:"column:remark;size:512;not null;default:''"`

	CreatedAt time.Time `gorm:"column:created_at;autoCreateTime"`
	UpdatedAt time.Time `gorm:"column:updated_at;autoUpdateTime"`
}

func (Connection) TableName() string { return "ci_monitoring_connections" }

type Link struct {
	ID        uint64 `gorm:"column:id;primaryKey;autoIncrement"`
	CITypeID  uint64 `gorm:"column:ci_type_id;not null;uniqueIndex:uniq_ciobs_provider_type,priority:2;index:idx_ciobs_provider,priority:2"`
	Provider  string `gorm:"column:provider;size:16;not null;uniqueIndex:uniq_ciobs_provider_type,priority:1;index:idx_ciobs_provider,priority:1"`
	Enabled   bool   `gorm:"column:enabled;not null"`
	// ConnectionID 0 means the platform's internal integration.
	ConnectionID uint64 `gorm:"column:connection_id;not null;default:0;index:idx_ciobs_link_connection"`

	DashboardUID  string `gorm:"column:dashboard_uid;size:128;not null;default:''"`
	DashboardSlug string `gorm:"column:dashboard_slug;size:128;not null;default:''"`
	OpenMode      string `gorm:"column:open_mode;size:8;not null;default:'link'"`

	VarMappingJSON      string `gorm:"column:var_mapping_json;type:text;not null"`
	LabelMappingJSON    string `gorm:"column:label_mapping_json;type:text;not null"`
	ExtraMatchersJSON   string `gorm:"column:extra_matchers_json;type:text;not null"`

	CreatedAt time.Time `gorm:"column:created_at;autoCreateTime"`
	UpdatedAt time.Time `gorm:"column:updated_at;autoUpdateTime"`
}

func (Link) TableName() string { return "ci_monitoring_links" }
