// Package store persists CMDB file metadata and settings. It is the only
// place that knows the c_file_* table names.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	filemodel "github.com/ongridio/ongrid/internal/cmdb/model/file"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// Migrate registers the file tables with GORM AutoMigrate.
func Migrate(db *gorm.DB) error {
	if db == nil {
		return fmt.Errorf("cmdb file store: nil db")
	}
	return db.AutoMigrate(&filemodel.Setting{}, &filemodel.File{})
}

// Repo implements the file domain's persistence port.
type Repo struct {
	db *gorm.DB
}

func NewRepo(db *gorm.DB) *Repo { return &Repo{db: db} }

// GetSetting returns one configuration row, or errs.ErrNotFound.
func (r *Repo) GetSetting(ctx context.Context, kind string) (*filemodel.Setting, error) {
	var row filemodel.Setting
	err := r.db.WithContext(ctx).Where("kind = ?", kind).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, errs.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("cmdb file store: get setting %s: %w", kind, err)
	}
	return &row, nil
}

// SetSetting upserts one configuration row. The value is already encrypted by
// the business layer; this method never sees plaintext.
func (r *Repo) SetSetting(ctx context.Context, kind, value string) error {
	row := filemodel.Setting{Kind: kind, Value: value}
	err := r.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "kind"}},
		DoUpdates: clause.Assignments(map[string]any{"value": value, "updated_at": time.Now()}),
	}).Create(&row).Error
	if err != nil {
		return fmt.Errorf("cmdb file store: set setting %s: %w", kind, err)
	}
	return nil
}

// CreateFile records a successful object write.
func (r *Repo) CreateFile(ctx context.Context, row *filemodel.File) error {
	if err := r.db.WithContext(ctx).Create(row).Error; err != nil {
		return fmt.Errorf("cmdb file store: create file: %w", err)
	}
	return nil
}

// GetFile resolves a public file id to its metadata.
func (r *Repo) GetFile(ctx context.Context, fileID string) (*filemodel.File, error) {
	var row filemodel.File
	err := r.db.WithContext(ctx).Where("file_id = ?", fileID).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, errs.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("cmdb file store: get file: %w", err)
	}
	return &row, nil
}

// DeleteFile removes the metadata row. The object is deleted by the business
// layer first; a metadata row without an object is worse than an orphan object
// because it makes the file look downloadable.
func (r *Repo) DeleteFile(ctx context.Context, fileID string) error {
	if err := r.db.WithContext(ctx).Unscoped().Where("file_id = ?", fileID).Delete(&filemodel.File{}).Error; err != nil {
		return fmt.Errorf("cmdb file store: delete file: %w", err)
	}
	return nil
}
