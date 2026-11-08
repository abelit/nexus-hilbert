package store

import (
	"context"
	"fmt"
	"time"

	"gorm.io/gorm"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
)

// Relation cleanup: the explicit Phase 2 repair of the noise the audit found.
//
// IT IS NOT A BOOT MIGRATION. A cleanup that deletes rows must be an operator
// action with a dry-run and a report, not a side effect of starting the
// service. `ongrid-cmdb --cleanup-relations [--dry-run]` is the entry point.
//
// THE CATEGORIES ARE NON-OVERLAPPING: a self-loop is removed from the orphan
// candidate set, and both are removed from the duplicate set. That is why the
// report's total is the number of rows the run touches, not a sum of overlapping
// audit counts.
const cleanupIDLimit = 1000

// CleanupReport is the operator-facing result. IDs are capped; the counts are
// always the full numbers.
type CleanupReport struct {
	DryRun         bool                  `json:"dry_run"`
	SelfLoops      int                   `json:"self_loops"`
	OrphanEdges    int                   `json:"orphan_edges"`
	DuplicateEdges int                   `json:"duplicate_edges"`
	Total          int                   `json:"total"`
	IDs            map[string][]model.ID `json:"ids,omitempty"`
	IDsTruncated   bool                  `json:"ids_truncated,omitempty"`

	// all is the complete id set, used only by the writer.
	all []model.ID
}

// CleanupRelations reports (dry run) or soft-deletes (real run) the three
// classes of relation noise in one transaction. A second real run is a no-op.
func CleanupRelations(ctx context.Context, db *gorm.DB, dryRun bool) (*CleanupReport, error) {
	if db == nil {
		return nil, errNilDB
	}
	if dryRun {
		report, err := inspectRelationNoise(db.WithContext(ctx))
		if err != nil {
			return nil, err
		}
		report.DryRun = true
		return report, nil
	}

	var report *CleanupReport
	err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		got, err := inspectRelationNoise(tx)
		if err != nil {
			return err
		}
		report = got
		if got.Total == 0 {
			return nil
		}
		res := tx.Model(&cimodel.Relation{}).
			Where("id IN ?", got.all).
			Updates(map[string]any{
				"deleted_at":    time.Now().UTC(),
				"delete_marker": int64(1),
			})
		if res.Error != nil {
			return fmt.Errorf("cmdb ci: cleanup relations: %w", res.Error)
		}
		if res.RowsAffected != int64(len(got.all)) {
			return fmt.Errorf("cmdb ci: cleanup relations: soft-deleted %d of %d rows; rerun the command",
				res.RowsAffected, len(got.all))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return report, nil
}

// inspectRelationNoise runs the three non-overlapping queries. The caller owns
// the transaction; a dry run simply does not open one.
func inspectRelationNoise(db *gorm.DB) (*CleanupReport, error) {
	selfIDs, err := liveSelfLoopIDs(db)
	if err != nil {
		return nil, err
	}
	orphanIDs, err := liveOrphanEdgeIDs(db, selfIDs)
	if err != nil {
		return nil, err
	}
	exclude := append(append([]model.ID{}, selfIDs...), orphanIDs...)
	duplicateIDs, err := liveDuplicateEdgeIDs(db, exclude)
	if err != nil {
		return nil, err
	}

	report := &CleanupReport{
		SelfLoops:      len(selfIDs),
		OrphanEdges:    len(orphanIDs),
		DuplicateEdges: len(duplicateIDs),
		Total:          len(selfIDs) + len(orphanIDs) + len(duplicateIDs),
		IDs: map[string][]model.ID{
			"self_loops":      capIDs(selfIDs),
			"orphan_edges":    capIDs(orphanIDs),
			"duplicate_edges": capIDs(duplicateIDs),
		},
		IDsTruncated: len(selfIDs) > cleanupIDLimit ||
			len(orphanIDs) > cleanupIDLimit ||
			len(duplicateIDs) > cleanupIDLimit,
	}
	report.all = make([]model.ID, 0, report.Total)
	report.all = append(report.all, selfIDs...)
	report.all = append(report.all, orphanIDs...)
	report.all = append(report.all, duplicateIDs...)
	return report, nil
}

func capIDs(ids []model.ID) []model.ID {
	if len(ids) <= cleanupIDLimit {
		return ids
	}
	return ids[:cleanupIDLimit]
}

// liveSelfLoopIDs relies on GORM's soft-delete scope (delete_marker + deleted_at).
func liveSelfLoopIDs(db *gorm.DB) ([]model.ID, error) {
	var ids []model.ID
	if err := db.Model(&cimodel.Relation{}).
		Where("first_ci_id = second_ci_id").
		Order("id").
		Pluck("id", &ids).Error; err != nil {
		return nil, fmt.Errorf("cmdb ci: cleanup: load self-loops: %w", err)
	}
	return ids, nil
}

// liveOrphanEdgeIDs finds live edges whose model pair has no live forward rule.
// Self-loops are excluded by the caller's id list as well as by the SQL, so the
// report's categories stay disjoint even in a dry run.
func liveOrphanEdgeIDs(db *gorm.DB, exclude []model.ID) ([]model.ID, error) {
	q := `
SELECT cr.id
FROM c_ci_relations cr
JOIN c_cis a ON a.id = cr.first_ci_id AND a.delete_marker = 0 AND a.deleted_at IS NULL
JOIN c_cis b ON b.id = cr.second_ci_id AND b.delete_marker = 0 AND b.deleted_at IS NULL
WHERE cr.delete_marker = 0 AND cr.deleted_at IS NULL
  AND cr.first_ci_id <> cr.second_ci_id
  AND NOT EXISTS (
    SELECT 1 FROM c_ci_type_relations tr
    WHERE tr.delete_marker = 0 AND tr.deleted_at IS NULL
      AND tr.parent_id = a.type_id
      AND tr.child_id = b.type_id
      AND tr.relation_type_id = cr.relation_type_id
  )`
	args := make([]any, 0, len(exclude))
	if len(exclude) > 0 {
		q += " AND cr.id NOT IN (" + placeholders(len(exclude)) + ")"
		for _, id := range exclude {
			args = append(args, id)
		}
	}
	q += " ORDER BY cr.id"
	return scanIDs(db, q, args...)
}

// liveDuplicateEdgeIDs keeps the lowest id per (first, second, type, ancestor
// path) and returns the extras. The path is part of the identity; two edges on
// different paths are different tree positions, not duplicates.
func liveDuplicateEdgeIDs(db *gorm.DB, exclude []model.ID) ([]model.ID, error) {
	q := `
SELECT cr.id
FROM c_ci_relations cr
JOIN (
  SELECT first_ci_id, second_ci_id, relation_type_id,
         COALESCE(ancestor_ids, '') AS ancestor_key, MIN(id) AS keep_id
  FROM c_ci_relations
  WHERE delete_marker = 0 AND deleted_at IS NULL AND first_ci_id <> second_ci_id
  GROUP BY first_ci_id, second_ci_id, relation_type_id, COALESCE(ancestor_ids, '')
  HAVING COUNT(*) > 1
) d ON d.first_ci_id = cr.first_ci_id
   AND d.second_ci_id = cr.second_ci_id
   AND d.relation_type_id = cr.relation_type_id
   AND d.ancestor_key = COALESCE(cr.ancestor_ids, '')
WHERE cr.delete_marker = 0 AND cr.deleted_at IS NULL AND cr.id <> d.keep_id`
	args := make([]any, 0, len(exclude))
	if len(exclude) > 0 {
		q += " AND cr.id NOT IN (" + placeholders(len(exclude)) + ")"
		for _, id := range exclude {
			args = append(args, id)
		}
	}
	q += " ORDER BY cr.id"
	return scanIDs(db, q, args...)
}

func scanIDs(db *gorm.DB, query string, args ...any) ([]model.ID, error) {
	var rows []struct {
		ID model.ID `gorm:"column:id"`
	}
	if err := db.Raw(query, args...).Scan(&rows).Error; err != nil {
		return nil, fmt.Errorf("cmdb ci: cleanup: query edges: %w", err)
	}
	ids := make([]model.ID, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	return ids, nil
}
