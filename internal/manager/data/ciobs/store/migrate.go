package store

import (
	"gorm.io/gorm"

	model "github.com/ongridio/ongrid/internal/manager/model/ciobs"
)

// Migrate registers ci_monitoring_links with GORM AutoMigrate.
func Migrate(db *gorm.DB) error {
	return db.AutoMigrate(&model.Link{})
}
