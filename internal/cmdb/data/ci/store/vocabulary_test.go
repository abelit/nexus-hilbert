package store

import (
	"context"
	"strings"
	"testing"

	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
)

// The vocabulary command creates only the missing words, with semantics, and
// never overwrites a row that is already configured.
func TestEnsureRelationVocabularyCreatesMissingAndIsIdempotent(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	ctx := context.Background()

	dry, err := EnsureRelationVocabulary(ctx, db, true)
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if !dry.DryRun || len(dry.Created) == 0 || len(dry.Existing) != 0 {
		t.Fatalf("dry report = %+v, want created and no existing", dry)
	}
	if !containsString(dry.Created, "CALLS") || !containsString(dry.Created, "CONTAINS") {
		t.Fatalf("dry report does not name the target vocabulary: %+v", dry.Created)
	}
	var n int64
	if err := db.Model(&citypemodel.RelationType{}).Where("name = ?", "CALLS").Count(&n).Error; err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("dry run created CALLS")
	}

	report, err := EnsureRelationVocabulary(ctx, db, false)
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if len(report.Created) == 0 || len(report.Existing) != 0 {
		t.Fatalf("report = %+v", report)
	}

	var calls citypemodel.RelationType
	if err := db.Where("name = ?", "CALLS").First(&calls).Error; err != nil {
		t.Fatalf("CALLS was not created: %v", err)
	}
	if calls.Category != "dependency" || calls.Direction != "dst_to_src" ||
		!calls.PropagatesDefault || calls.WeightDefault != 0.9 || calls.Revision != 1 {
		t.Fatalf("CALLS semantics = %+v", calls)
	}
	var contains citypemodel.RelationType
	if err := db.Where("name = ?", "CONTAINS").First(&contains).Error; err != nil {
		t.Fatal(err)
	}
	if contains.InverseOf != "PART_OF" || !contains.Transitive || contains.WeightDefault != 0 {
		t.Fatalf("CONTAINS semantics = %+v", contains)
	}

	again, err := EnsureRelationVocabulary(ctx, db, false)
	if err != nil {
		t.Fatalf("second ensure: %v", err)
	}
	if len(again.Created) != 0 || len(again.Existing) == 0 {
		t.Fatalf("second report = %+v, want an idempotent no-op", again)
	}
}

func TestEnsureRelationVocabularyKeepsConfiguredRows(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	configured := citypemodel.RelationType{
		Name: "CALLS", Category: "custom", Direction: "src_to_dst", Revision: 9,
	}
	if err := db.Create(&configured).Error; err != nil {
		t.Fatal(err)
	}

	report, err := EnsureRelationVocabulary(context.Background(), db, false)
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if containsString(report.Created, "CALLS") {
		t.Fatalf("report claims it created an existing type: %+v", report)
	}
	var got citypemodel.RelationType
	if err := db.First(&got, configured.ID).Error; err != nil {
		t.Fatal(err)
	}
	if got.Category != "custom" || got.Direction != "src_to_dst" || got.Revision != 9 {
		t.Fatalf("configured row was overwritten: %+v", got)
	}
}

func TestEnsureRelationVocabularyRejectsNilDB(t *testing.T) {
	if _, err := EnsureRelationVocabulary(context.Background(), nil, false); err == nil {
		t.Fatal("EnsureRelationVocabulary(nil) = nil error, want error")
	}
}

func containsString(haystack []string, needle string) bool {
	for _, item := range haystack {
		if strings.EqualFold(item, needle) {
			return true
		}
	}
	return false
}
