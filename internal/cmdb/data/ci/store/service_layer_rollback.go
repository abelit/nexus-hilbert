package store

import (
	"context"
	"fmt"

	cibiz "github.com/ongridio/ongrid/internal/cmdb/biz/ci"
	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
)

// LayerMappingsForBatch returns every live mapping of one migration batch.
func (r *Repo) LayerMappingsForBatch(ctx context.Context, batch string) ([]cimodel.LayerMapping, error) {
	if r.db == nil {
		return nil, errNilDB
	}
	var rows []cimodel.LayerMapping
	if err := r.db.WithContext(ctx).Where("batch = ?", batch).Order("id").Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("cmdb ci: service layer rollback: mappings: %w", err)
	}
	return rows, nil
}

// RelationsTouching returns the live relations incident to any of the CIs,
// with the relation type name and the evidence source the rollback guard reads.
func (r *Repo) RelationsTouching(ctx context.Context, ciIDs []model.ID) ([]cibiz.ServiceLayerRelation, error) {
	if r.db == nil {
		return nil, errNilDB
	}
	if len(ciIDs) == 0 {
		return nil, nil
	}
	var rows []struct {
		ID             model.ID `gorm:"column:id"`
		FirstCIID      model.ID `gorm:"column:first_ci_id"`
		SecondCIID     model.ID `gorm:"column:second_ci_id"`
		RelationType   string   `gorm:"column:relation_type"`
		EvidenceSource string   `gorm:"column:evidence_source"`
	}
	if err := r.db.WithContext(ctx).Raw(`SELECT cr.id, cr.first_ci_id, cr.second_ci_id,
			rt.name AS relation_type, cr.evidence_source
		FROM c_ci_relations cr
		JOIN c_relation_types rt ON rt.id = cr.relation_type_id
		WHERE cr.deleted_at IS NULL AND (cr.first_ci_id IN ? OR cr.second_ci_id IN ?)`,
		ciIDs, ciIDs).Scan(&rows).Error; err != nil {
		return nil, fmt.Errorf("cmdb ci: service layer rollback: relations: %w", err)
	}
	out := make([]cibiz.ServiceLayerRelation, 0, len(rows))
	for _, row := range rows {
		out = append(out, cibiz.ServiceLayerRelation{
			ID: row.ID, FirstCIID: row.FirstCIID, SecondCIID: row.SecondCIID,
			RelationType: row.RelationType, EvidenceSource: row.EvidenceSource,
		})
	}
	return out, nil
}

// DeleteLayerMappings soft-deletes every mapping of the batch and reports the
// row count.
func (r *Repo) DeleteLayerMappings(ctx context.Context, batch string) (int64, error) {
	if r.db == nil {
		return 0, errNilDB
	}
	res := r.db.WithContext(ctx).Where("batch = ?", batch).Delete(&cimodel.LayerMapping{})
	if res.Error != nil {
		return 0, fmt.Errorf("cmdb ci: service layer rollback: delete mappings: %w", res.Error)
	}
	return res.RowsAffected, nil
}
