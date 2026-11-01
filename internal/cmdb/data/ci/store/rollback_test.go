package store

import (
	"context"
	"testing"
	"time"

	cibiz "github.com/ongridio/ongrid/internal/cmdb/biz/ci"
	cmdbmodel "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
)

// twoUpdates seeds a CI and writes cpu_count 8 -> 16 -> 32, returning the
// operation records in order (create, first update, second update).
func twoUpdates(t *testing.T, repo *Repo) (*cimodel.CI, []cimodel.OperationRecord) {
	t.Helper()
	ctx := context.Background()
	ci := seedCI(t, repo, map[cmdbmodel.ID]any{1: "web-1", 2: 8})

	for _, value := range []int32{16, 32} {
		if _, err := repo.UpsertCIValues(ctx, cibiz.UpdateInput{
			CIID: ci.ID, TypeID: ci.TypeID, Specs: fullSpecs(),
			Values: map[cmdbmodel.ID]any{2: value},
			Audit:  cibiz.AuditInfo{Actor: 7, ActorEmail: "edit@example.test", Origin: "ui"},
		}); err != nil {
			t.Fatalf("UpsertCIValues() error = %v", err)
		}
	}

	var records []cimodel.OperationRecord
	if err := repo.db.Order("id ASC").Find(&records).Error; err != nil {
		t.Fatalf("load operation records: %v", err)
	}
	if len(records) != 3 {
		t.Fatalf("operation records = %d, want 3", len(records))
	}
	return ci, records
}

func TestLoadAttributeHistoryStartsAtTheRecordCutoff(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	repo := NewRepo(db)
	ci, records := twoUpdates(t, repo)

	got, err := repo.LoadAttributeHistory(context.Background(), ci.ID, cibiz.RollbackCutoff{RecordID: records[1].ID})
	if err != nil {
		t.Fatalf("LoadAttributeHistory() error = %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("rows = %d, want the two changes from the first update onward: %+v", len(got), got)
	}
	if got[0].Old == nil || *got[0].Old != "8" || got[0].New == nil || *got[0].New != "16" {
		t.Fatalf("first row = %+v, want 8 -> 16", got[0])
	}
	if got[1].Old == nil || *got[1].Old != "16" || got[1].New == nil || *got[1].New != "32" {
		t.Fatalf("second row = %+v, want 16 -> 32", got[1])
	}
}

func TestLoadAttributeHistoryStartsAtTheTimestampCutoff(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	repo := NewRepo(db)
	ci, records := twoUpdates(t, repo)

	backdated := time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC)
	for i, record := range records {
		if err := db.Model(&cimodel.OperationRecord{}).Where("id = ?", record.ID).
			Update("created_at", backdated.Add(time.Duration(i)*time.Minute)).Error; err != nil {
			t.Fatalf("backdate record: %v", err)
		}
	}

	// Records sit at +0m, +1m and +2m; +30s selects the two updates.
	cutoff := backdated.Add(30 * time.Second)
	got, err := repo.LoadAttributeHistory(context.Background(), ci.ID, cibiz.RollbackCutoff{Before: cutoff})
	if err != nil {
		t.Fatalf("LoadAttributeHistory() error = %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("rows = %d, want two: %+v", len(got), got)
	}
}

func TestLoadAttributeHistoryIsScopedToOneInstance(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	repo := NewRepo(db)
	ctx := context.Background()
	ci := seedCI(t, repo, map[cmdbmodel.ID]any{1: "web-1", 2: 8})
	other := seedCI(t, repo, map[cmdbmodel.ID]any{1: "web-2", 2: 8})

	if _, err := repo.UpsertCIValues(ctx, cibiz.UpdateInput{
		CIID: other.ID, TypeID: other.TypeID, Specs: fullSpecs(),
		Values: map[cmdbmodel.ID]any{2: 32},
		Audit:  cibiz.AuditInfo{Actor: 7},
	}); err != nil {
		t.Fatalf("UpsertCIValues() error = %v", err)
	}

	var latest cimodel.OperationRecord
	if err := db.Order("id DESC").First(&latest).Error; err != nil {
		t.Fatalf("load latest record: %v", err)
	}
	got, err := repo.LoadAttributeHistory(ctx, ci.ID, cibiz.RollbackCutoff{RecordID: latest.ID})
	if err != nil {
		t.Fatalf("LoadAttributeHistory() error = %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("rows = %+v, want none for this instance", got)
	}
}
