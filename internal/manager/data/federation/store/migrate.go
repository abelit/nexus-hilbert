package store

import (
	"gorm.io/gorm"

	model "github.com/ongridio/ongrid/internal/manager/model/federation"
)

// Migrate registers the federation tables with GORM's AutoMigrate. Composed
// from cmd/ongrid via dbx.RunMigrations like the other manager migrations.
func Migrate(db *gorm.DB) error {
	return db.AutoMigrate(
		&model.Connection{},
		&model.CIMapping{},
		&model.CenterFilter{},
		&model.DisplayColumn{},
	)
}
