package store

import (
	"context"
	"errors"
	"fmt"

	"gorm.io/gorm"

	model "github.com/ongridio/ongrid/internal/manager/model/ciobs"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

type Repo struct {
	db *gorm.DB
}

func NewRepo(db *gorm.DB) *Repo { return &Repo{db: db} }

func (r *Repo) List(ctx context.Context, provider string) ([]model.Link, error) {
	var rows []model.Link
	err := r.db.WithContext(ctx).Where("provider = ?", provider).Order("ci_type_id").Find(&rows).Error
	return rows, err
}

func (r *Repo) Get(ctx context.Context, provider string, ciTypeID uint64) (*model.Link, error) {
	var row model.Link
	err := r.db.WithContext(ctx).
		Where("provider = ? AND ci_type_id = ?", provider, ciTypeID).
		First(&row).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, fmt.Errorf("%w: %s link for ci type %d", errs.ErrNotFound, provider, ciTypeID)
		}
		return nil, err
	}
	return &row, nil
}

func (r *Repo) Upsert(ctx context.Context, link *model.Link) error {
	var existing model.Link
	err := r.db.WithContext(ctx).
		Where("provider = ? AND ci_type_id = ?", link.Provider, link.CITypeID).
		First(&existing).Error
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		return r.db.WithContext(ctx).Create(link).Error
	case err != nil:
		return err
	default:
		link.ID = existing.ID
		// The caller builds a fresh row without timestamps; omit created_at
		// or MySQL strict mode rejects the zero datetime on every save.
		return r.db.WithContext(ctx).Omit("created_at").Save(link).Error
	}
}

func (r *Repo) Delete(ctx context.Context, provider string, ciTypeID uint64) error {
	result := r.db.WithContext(ctx).
		Where("provider = ? AND ci_type_id = ?", provider, ciTypeID).
		Delete(&model.Link{})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return fmt.Errorf("%w: %s link for ci type %d", errs.ErrNotFound, provider, ciTypeID)
	}
	return nil
}
