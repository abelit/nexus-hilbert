package store

import (
	"context"
	"errors"
	"fmt"

	"gorm.io/gorm"

	cibiz "github.com/ongridio/ongrid/internal/cmdb/biz/ci"
	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
)

// ServiceLayerMappings returns the live source -> target mapping for one model
// pair of the M1 batch.
func (r *Repo) ServiceLayerMappings(ctx context.Context, batch, sourceModel, targetModel string) (map[model.ID]model.ID, error) {
	if r.db == nil {
		return nil, errNilDB
	}
	var rows []struct {
		SourceCIID model.ID `gorm:"column:source_ci_id"`
		TargetCIID model.ID `gorm:"column:target_ci_id"`
	}
	if err := r.db.WithContext(ctx).Model(&cimodel.LayerMapping{}).
		Select("source_ci_id, target_ci_id").
		Where("batch = ? AND source_model = ? AND target_model = ?", batch, sourceModel, targetModel).
		Scan(&rows).Error; err != nil {
		return nil, fmt.Errorf("cmdb ci: service layer edges: mappings: %w", err)
	}
	out := make(map[model.ID]model.ID, len(rows))
	for _, row := range rows {
		out[row.SourceCIID] = row.TargetCIID
	}
	return out, nil
}

// LegacyServiceApplicationEdges returns the live service -> application
// DEPENDS_ON edges the projection derives from. Soft-deleted endpoints and
// relation types are excluded, so a retired vocabulary cannot feed the new
// graph.
func (r *Repo) LegacyServiceApplicationEdges(ctx context.Context, serviceTypeID, applicationTypeID model.ID) ([]cibiz.ServiceLayerLegacyEdge, error) {
	if r.db == nil {
		return nil, errNilDB
	}
	var rows []struct {
		ServiceCIID     model.ID `gorm:"column:service_ci_id"`
		ApplicationCIID model.ID `gorm:"column:application_ci_id"`
	}
	if err := r.db.WithContext(ctx).Raw(`SELECT cr.first_ci_id AS service_ci_id,
			cr.second_ci_id AS application_ci_id
		FROM c_ci_relations cr
		JOIN c_relation_types rt ON rt.id = cr.relation_type_id
		JOIN c_cis f ON f.id = cr.first_ci_id
		JOIN c_cis s ON s.id = cr.second_ci_id
		WHERE cr.deleted_at IS NULL AND rt.deleted_at IS NULL
			AND f.deleted_at IS NULL AND s.deleted_at IS NULL
			AND rt.name = 'DEPENDS_ON' AND f.type_id = ? AND s.type_id = ?
		ORDER BY cr.id`, serviceTypeID, applicationTypeID).Scan(&rows).Error; err != nil {
		return nil, fmt.Errorf("cmdb ci: service layer edges: legacy edges: %w", err)
	}
	out := make([]cibiz.ServiceLayerLegacyEdge, 0, len(rows))
	for _, row := range rows {
		out = append(out, cibiz.ServiceLayerLegacyEdge{
			ServiceCIID: row.ServiceCIID, ApplicationCIID: row.ApplicationCIID,
		})
	}
	return out, nil
}

// ServiceLayerEdgeBetween returns the relation type of a live edge between the
// pair. The caller uses it to distinguish a resumed projection from a pair that
// already carries a different relation.
func (r *Repo) ServiceLayerEdgeBetween(ctx context.Context, firstCIID, secondCIID model.ID) (model.ID, bool, error) {
	if r.db == nil {
		return 0, false, errNilDB
	}
	var row struct {
		RelationTypeID model.ID `gorm:"column:relation_type_id"`
	}
	err := r.db.WithContext(ctx).Model(&cimodel.Relation{}).
		Select("relation_type_id").
		Where("first_ci_id = ? AND second_ci_id = ?", firstCIID, secondCIID).
		Take(&row).Error
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		return 0, false, nil
	case err != nil:
		return 0, false, fmt.Errorf("cmdb ci: service layer edges: edge between: %w", err)
	default:
		return row.RelationTypeID, true, nil
	}
}

// ServiceLayerContainingParent returns the business service already containing
// the child under the relation type. The one-to-many containment rule allows
// one parent, so a second claimant is a review item, not an overwrite.
func (r *Repo) ServiceLayerContainingParent(ctx context.Context, childCIID, relationTypeID model.ID) (model.ID, bool, error) {
	if r.db == nil {
		return 0, false, errNilDB
	}
	var row struct {
		FirstCIID model.ID `gorm:"column:first_ci_id"`
	}
	err := r.db.WithContext(ctx).Model(&cimodel.Relation{}).
		Select("first_ci_id").
		Where("second_ci_id = ? AND relation_type_id = ?", childCIID, relationTypeID).
		Take(&row).Error
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		return 0, false, nil
	case err != nil:
		return 0, false, fmt.Errorf("cmdb ci: service layer edges: containing parent: %w", err)
	default:
		return row.FirstCIID, true, nil
	}
}
