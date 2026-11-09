package ci

import cmdbmodel "github.com/ongridio/ongrid/internal/cmdb/model"

// LayerMapping records one source CI's projection into a service-layer target.
// It is the M1 migration's idempotency key: a rerun of the apply skips a source
// that already has a mapping, and a rollback can find every created target from
// its source.
//
// The table is port-only (RFC-011); cantor has no counterpart. The unique
// business key is (batch, source_ci_id, target_model); the store enforces it in
// the apply path rather than with a database index, so soft-deleting and
// recreating a mapping does not collide.
type LayerMapping struct {
	cmdbmodel.Base

	Batch       string       `gorm:"column:batch;size:64;not null;index:idx_c_ci_layer_mappings_batch"`
	SourceModel string       `gorm:"column:source_model;size:32;not null"`
	SourceCIID  cmdbmodel.ID `gorm:"column:source_ci_id;not null;index:idx_c_ci_layer_mappings_source"`
	TargetModel string       `gorm:"column:target_model;size:32;not null"`
	TargetCIID  cmdbmodel.ID `gorm:"column:target_ci_id;not null;index:idx_c_ci_layer_mappings_target"`
}

func (LayerMapping) TableName() string { return "c_ci_layer_mappings" }
