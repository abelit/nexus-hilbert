// Package store is the GORM-backed persistence layer for the federation
// sub-domain. Config rows are hard-deleted: they are configuration, not
// business records, and hard delete avoids the soft-delete/unique-index NULL
// trap.
package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"gorm.io/gorm"

	biz "github.com/ongridio/ongrid/internal/manager/biz/federation"
	model "github.com/ongridio/ongrid/internal/manager/model/federation"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

type Repo struct {
	db *gorm.DB
}

func NewRepo(db *gorm.DB) *Repo { return &Repo{db: db} }

// DB exposes the handle for migration tests and composition; production code
// should use the typed methods.
func (r *Repo) DB() *gorm.DB { return r.db }

var _ biz.Repository = (*Repo)(nil)

func (r *Repo) ListConnections(ctx context.Context, kind string) ([]model.Connection, error) {
	var rows []model.Connection
	err := r.db.WithContext(ctx).Where("kind = ?", kind).Order("id").Find(&rows).Error
	return rows, err
}

func (r *Repo) GetConnection(ctx context.Context, id uint64) (*model.Connection, error) {
	var row model.Connection
	if err := r.db.WithContext(ctx).First(&row, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, fmt.Errorf("%w: connection %d", errs.ErrNotFound, id)
		}
		return nil, err
	}
	return &row, nil
}

func (r *Repo) CreateConnection(ctx context.Context, conn *model.Connection) error {
	if err := r.db.WithContext(ctx).Create(conn).Error; err != nil {
		if isDuplicate(err) {
			return fmt.Errorf("%w: connection %q already exists for %s", errs.ErrConflict, conn.Name, conn.Kind)
		}
		return err
	}
	return nil
}

func (r *Repo) UpdateConnection(ctx context.Context, conn *model.Connection) error {
	if err := r.db.WithContext(ctx).Save(conn).Error; err != nil {
		if isDuplicate(err) {
			return fmt.Errorf("%w: connection %q already exists for %s", errs.ErrConflict, conn.Name, conn.Kind)
		}
		return err
	}
	return nil
}

func (r *Repo) DeleteConnection(ctx context.Context, id uint64, cascade bool) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&model.CIMapping{}).Where("connection_id = ?", id).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 && !cascade {
			return fmt.Errorf("%w: connection %d is referenced by %d mapping(s)", errs.ErrConflict, id, count)
		}
		if count > 0 {
			if err := tx.Where("connection_id = ?", id).Delete(&model.CIMapping{}).Error; err != nil {
				return err
			}
		}
		result := tx.Delete(&model.Connection{}, id)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return fmt.Errorf("%w: connection %d", errs.ErrNotFound, id)
		}
		return nil
	})
}

func (r *Repo) ClearDefaultConnection(ctx context.Context, kind string, exceptID uint64) error {
	return r.db.WithContext(ctx).
		Model(&model.Connection{}).
		Where("kind = ? AND id <> ?", kind, exceptID).
		Update("is_default", false).Error
}

func (r *Repo) ListMappings(ctx context.Context, kind string, ciTypeID uint64) ([]model.CIMapping, error) {
	query := r.db.WithContext(ctx).Where("kind = ?", kind)
	if ciTypeID > 0 {
		query = query.Where("ci_type_id = ?", ciTypeID)
	}
	var rows []model.CIMapping
	err := query.Order("ci_type_id, connection_id").Find(&rows).Error
	return rows, err
}

func (r *Repo) GetMapping(ctx context.Context, id uint64) (*model.CIMapping, error) {
	var row model.CIMapping
	if err := r.db.WithContext(ctx).First(&row, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, fmt.Errorf("%w: mapping %d", errs.ErrNotFound, id)
		}
		return nil, err
	}
	return &row, nil
}

func (r *Repo) CreateMapping(ctx context.Context, mapping *model.CIMapping) error {
	if err := r.db.WithContext(ctx).Create(mapping).Error; err != nil {
		if isDuplicate(err) {
			return fmt.Errorf("%w: mapping for ci_type %d / connection %d already exists", errs.ErrConflict, mapping.CITypeID, mapping.ConnectionID)
		}
		return err
	}
	return nil
}

func (r *Repo) UpdateMapping(ctx context.Context, mapping *model.CIMapping) error {
	if err := r.db.WithContext(ctx).Save(mapping).Error; err != nil {
		if isDuplicate(err) {
			return fmt.Errorf("%w: mapping for ci_type %d / connection %d already exists", errs.ErrConflict, mapping.CITypeID, mapping.ConnectionID)
		}
		return err
	}
	return nil
}

func (r *Repo) DeleteMapping(ctx context.Context, id uint64) error {
	result := r.db.WithContext(ctx).Delete(&model.CIMapping{}, id)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return fmt.Errorf("%w: mapping %d", errs.ErrNotFound, id)
	}
	return nil
}

func (r *Repo) ListFilters(ctx context.Context, kind string) ([]model.CenterFilter, error) {
	var rows []model.CenterFilter
	err := r.db.WithContext(ctx).Where("kind = ?", kind).Order("position, id").Find(&rows).Error
	return rows, err
}

func (r *Repo) GetFilter(ctx context.Context, kind, key string) (*model.CenterFilter, error) {
	var row model.CenterFilter
	if err := r.db.WithContext(ctx).Where("kind = ? AND filter_key = ?", kind, key).First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, fmt.Errorf("%w: filter %q", errs.ErrNotFound, key)
		}
		return nil, err
	}
	return &row, nil
}

// SaveFilter upserts by (kind, filter_key).
func (r *Repo) SaveFilter(ctx context.Context, filter *model.CenterFilter) error {
	var existing model.CenterFilter
	err := r.db.WithContext(ctx).
		Where("kind = ? AND filter_key = ?", filter.Kind, filter.FilterKey).
		First(&existing).Error
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		return r.db.WithContext(ctx).Create(filter).Error
	case err != nil:
		return err
	default:
		filter.ID = existing.ID
		return r.db.WithContext(ctx).Save(filter).Error
	}
}

func (r *Repo) DeleteFilter(ctx context.Context, kind, key string) error {
	result := r.db.WithContext(ctx).
		Where("kind = ? AND filter_key = ?", kind, key).
		Delete(&model.CenterFilter{})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return fmt.Errorf("%w: filter %q", errs.ErrNotFound, key)
	}
	return nil
}

func (r *Repo) CountBadgeFilters(ctx context.Context, kind, exceptKey string) (int64, error) {
	query := r.db.WithContext(ctx).
		Model(&model.CenterFilter{}).
		Where("kind = ? AND enabled = ? AND usage IN ?", kind, true, []string{model.UsageBadge, model.UsageBoth})
	if exceptKey != "" {
		query = query.Where("filter_key <> ?", exceptKey)
	}
	var count int64
	err := query.Count(&count).Error
	return count, err
}

func (r *Repo) ListColumns(ctx context.Context, kind string) ([]model.DisplayColumn, error) {
	var rows []model.DisplayColumn
	err := r.db.WithContext(ctx).Where("kind = ?", kind).Order("position, id").Find(&rows).Error
	return rows, err
}

// ReplaceColumns replaces the ordered list for one kind in a single
// transaction, so a failed save never leaves half a column set.
func (r *Repo) ReplaceColumns(ctx context.Context, kind string, columns []model.DisplayColumn) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("kind = ?", kind).Delete(&model.DisplayColumn{}).Error; err != nil {
			return err
		}
		if len(columns) == 0 {
			return nil
		}
		for i := range columns {
			columns[i].ID = 0
			columns[i].Kind = kind
			columns[i].Position = i
		}
		return tx.Create(&columns).Error
	})
}

func isDuplicate(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, gorm.ErrDuplicatedKey) {
		return true
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "unique constraint failed") ||
		strings.Contains(text, "duplicate entry") ||
		strings.Contains(text, "duplicated key")
}
