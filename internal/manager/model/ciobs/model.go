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

type Link struct {
	ID        uint64 `gorm:"column:id;primaryKey;autoIncrement"`
	CITypeID  uint64 `gorm:"column:ci_type_id;not null;uniqueIndex:uniq_ciobs_provider_type,priority:2;index:idx_ciobs_provider,priority:2"`
	Provider  string `gorm:"column:provider;size:16;not null;uniqueIndex:uniq_ciobs_provider_type,priority:1;index:idx_ciobs_provider,priority:1"`
	Enabled   bool   `gorm:"column:enabled;not null"`

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
