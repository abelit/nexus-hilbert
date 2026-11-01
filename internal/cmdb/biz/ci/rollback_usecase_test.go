package ci

import (
	"context"
	"testing"
	"time"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
	"github.com/ongridio/ongrid/internal/cmdb/model/value"
)

// rollbackRepo is a value store that returns one fixed state and records the
// update the rollback asks for.
type rollbackRepo struct {
	readRepo
	valueRepoStub
	queryRepoStub
	relationRepoStub
	dcimRepoStub

	ci      *cimodel.CI
	rows    []ValueRow
	history []HistoryChange

	lastCutoff RollbackCutoff
	updates    int
	lastUpdate UpdateInput
	changes    []Change
}

func (r *rollbackRepo) LoadCI(context.Context, model.ID) (*cimodel.CI, error) {
	return r.ci, nil
}

func (r *rollbackRepo) LoadValueRows(context.Context, model.ID) ([]ValueRow, error) {
	return r.rows, nil
}

func (r *rollbackRepo) CountCIsByType(context.Context, model.ID) (int64, error) { return 0, nil }

func (r *rollbackRepo) LoadAttributeHistory(_ context.Context, _ model.ID, cutoff RollbackCutoff) ([]HistoryChange, error) {
	r.lastCutoff = cutoff
	return r.history, nil
}

func (r *rollbackRepo) UpsertCIValues(_ context.Context, in UpdateInput) ([]Change, error) {
	r.updates++
	r.lastUpdate = in
	return r.changes, nil
}

func rollbackFixture() (*rollbackRepo, *resolverStub) {
	ct := citypemodel.CIType{Name: "host", Alias: "主机", UniqueID: 1, Enabled: true}
	ct.ID = 1
	specs := map[model.ID]AttributeSpec{
		1: {ID: 1, Name: "cpu_count", Alias: "CPU", ValueType: value.TypeInt, IsIndex: true},
		2: {ID: 2, Name: "hostname", Alias: "主机名", ValueType: value.TypeText, IsIndex: true},
	}
	ci := &cimodel.CI{TypeID: 1}
	ci.ID = 42
	repo := &rollbackRepo{
		ci:   ci,
		rows: []ValueRow{intRow(1, 16), textRow(2, "web-1")},
		history: []HistoryChange{
			change(100, 1, model.OperateUpdate, "8", "16"),
			change(101, 2, model.OperateUpdate, "web-0", "web-1"),
		},
	}
	resolver := &resolverStub{ct: ct, specs: specs, show: specs[2], unique: specs[2]}
	return repo, resolver
}

func TestRollbackAppliesTheRestoredValuesThroughTheUpdatePath(t *testing.T) {
	repo, resolver := rollbackFixture()
	uc := NewUsecase(repo, resolver, nil)
	before := time.Unix(1700000000, 0)

	plan, err := uc.Rollback(context.Background(), 42, RollbackCutoff{Before: before, RecordID: 100}, AuditInfo{
		Actor: 7, ActorEmail: "operator@example.test", Origin: "ui",
	})
	if err != nil {
		t.Fatalf("Rollback() error = %v", err)
	}
	if repo.updates != 1 {
		t.Fatalf("updates = %d, want one", repo.updates)
	}
	if repo.lastUpdate.Values[1] != int32(8) {
		t.Fatalf("cpu value = %#v, want int32(8)", repo.lastUpdate.Values[1])
	}
	if repo.lastUpdate.Values[2] != "web-0" {
		t.Fatalf("hostname value = %#v, want web-0", repo.lastUpdate.Values[2])
	}
	if repo.lastCutoff.RecordID != 100 || !repo.lastCutoff.Before.Equal(before) {
		t.Fatalf("cutoff = %+v, want record 100 before %v", repo.lastCutoff, before)
	}
	if repo.lastUpdate.Audit.Actor != 7 || repo.lastUpdate.Audit.Origin != "ui" {
		t.Fatalf("audit = %+v, want the caller's identity", repo.lastUpdate.Audit)
	}
	if repo.lastUpdate.Audit.Reason == "" {
		t.Fatal("audit reason is empty; a rollback must say what it restored")
	}
	if len(plan.Changes) != 2 {
		t.Fatalf("plan changes = %+v, want two", plan.Changes)
	}
}

func TestRollbackWritesNothingWhenTheTargetAlreadyMatches(t *testing.T) {
	repo, resolver := rollbackFixture()
	repo.rows = []ValueRow{intRow(1, 8), textRow(2, "web-0")}
	uc := NewUsecase(repo, resolver, nil)

	plan, err := uc.Rollback(context.Background(), 42, RollbackCutoff{RecordID: 100}, AuditInfo{Actor: 7})
	if err != nil {
		t.Fatalf("Rollback() error = %v", err)
	}
	if repo.updates != 0 {
		t.Fatalf("updates = %d, want none", repo.updates)
	}
	if len(plan.Changes) != 0 {
		t.Fatalf("plan changes = %+v, want none", plan.Changes)
	}
}

func TestBaselineOnlyReads(t *testing.T) {
	repo, resolver := rollbackFixture()
	uc := NewUsecase(repo, resolver, nil)

	plan, err := uc.PlanBaseline(context.Background(), 42, RollbackCutoff{RecordID: 100})
	if err != nil {
		t.Fatalf("PlanBaseline() error = %v", err)
	}
	if repo.updates != 0 {
		t.Fatalf("updates = %d; a preview must not write", repo.updates)
	}
	if len(plan.Changes) != 2 {
		t.Fatalf("plan changes = %+v, want two", plan.Changes)
	}
}

func TestBaselineRejectsAZeroCutoff(t *testing.T) {
	repo, resolver := rollbackFixture()
	uc := NewUsecase(repo, resolver, nil)

	if _, err := uc.PlanBaseline(context.Background(), 42, RollbackCutoff{}); err == nil {
		t.Fatal("PlanBaseline() accepted an empty cutoff")
	}
}
