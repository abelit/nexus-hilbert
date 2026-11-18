package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"gorm.io/gorm"

	model "github.com/ongridio/ongrid/internal/manager/model/ciobs"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

func (r *Repo) ListConnections(ctx context.Context, provider string) ([]model.Connection, error) {
	var rows []model.Connection
	err := r.db.WithContext(ctx).Where("provider = ?", provider).Order("name").Find(&rows).Error
	return rows, err
}

func (r *Repo) GetConnection(ctx context.Context, id uint64) (*model.Connection, error) {
	var row model.Connection
	if err := r.db.WithContext(ctx).First(&row, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, fmt.Errorf("%w: monitoring connection %d", errs.ErrNotFound, id)
		}
		return nil, err
	}
	return &row, nil
}

func (r *Repo) CreateConnection(ctx context.Context, conn *model.Connection) error {
	if err := r.db.WithContext(ctx).Create(conn).Error; err != nil {
		if isDuplicate(err) {
			return fmt.Errorf("%w: connection %q already exists for %s", errs.ErrConflict, conn.Name, conn.Provider)
		}
		return err
	}
	return nil
}

func (r *Repo) UpdateConnection(ctx context.Context, conn *model.Connection) error {
	if err := r.db.WithContext(ctx).Save(conn).Error; err != nil {
		if isDuplicate(err) {
			return fmt.Errorf("%w: connection %q already exists for %s", errs.ErrConflict, conn.Name, conn.Provider)
		}
		return err
	}
	return nil
}

func (r *Repo) DeleteConnection(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&model.Link{}).Where("connection_id = ?", id).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return fmt.Errorf("%w: connection %d is referenced by %d CI link(s)", errs.ErrConflict, id, count)
		}
		result := tx.Delete(&model.Connection{}, id)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return fmt.Errorf("%w: monitoring connection %d", errs.ErrNotFound, id)
		}
		return nil
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
