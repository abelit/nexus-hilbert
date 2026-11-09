package store

import (
	"context"
	"fmt"

	"gorm.io/gorm"

	cibiz "github.com/ongridio/ongrid/internal/cmdb/biz/ci"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
)

// VocabularyReport is the result of ensuring the managed relation vocabulary.
type VocabularyReport struct {
	DryRun   bool     `json:"dry_run"`
	Created  []string `json:"created,omitempty"`
	Existing []string `json:"existing,omitempty"`
}

// EnsureRelationVocabulary creates every target relation type that is absent,
// with its semantic mirror. It is an explicit operator command, not a startup
// side effect: a database that has never run it keeps whatever vocabulary the
// split and the built-in bootstrap created.
//
// THE EXISTING ROW WINS. A type that is already present — synced from
// topocortex, edited by an operator, or created by an earlier split — is never
// overwritten; only the missing words are created. That makes the command
// safe to rerun and safe on a migrated database.
//
// It exists because some target words (CALLS is the first) have no legacy rule
// to split, and the built-in bootstrap only creates the three words its own
// DCIM/IPAM rules need. Without this command those words could not be used by
// a new writer until something created them with semantics.
func EnsureRelationVocabulary(ctx context.Context, db *gorm.DB, dryRun bool) (*VocabularyReport, error) {
	if db == nil {
		return nil, errNilDB
	}
	if dryRun {
		report := &VocabularyReport{DryRun: true}
		for _, spec := range cibiz.TargetRelationTypes() {
			var n int64
			if err := db.WithContext(ctx).Model(&citypemodel.RelationType{}).
				Where("name = ?", spec.Name).Count(&n).Error; err != nil {
				return nil, fmt.Errorf("cmdb ci: ensure vocabulary: check %s: %w", spec.Name, err)
			}
			if n == 0 {
				report.Created = append(report.Created, spec.Name)
			} else {
				report.Existing = append(report.Existing, spec.Name)
			}
		}
		return report, nil
	}

	report := &VocabularyReport{}
	err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, spec := range cibiz.TargetRelationTypes() {
			_, created, err := ensureRelationType(tx, spec)
			if err != nil {
				return err
			}
			if created {
				report.Created = append(report.Created, spec.Name)
			} else {
				report.Existing = append(report.Existing, spec.Name)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return report, nil
}
