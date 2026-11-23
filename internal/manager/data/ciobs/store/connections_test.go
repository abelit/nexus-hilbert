package store_test

import (
	"context"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	ciobsdata "github.com/ongridio/ongrid/internal/manager/data/ciobs/store"
	model "github.com/ongridio/ongrid/internal/manager/model/ciobs"
)

func newStore(t *testing.T) (*ciobsdata.Repo, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := ciobsdata.Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return ciobsdata.NewRepo(db), db
}

// Upsert builds a fresh Link without timestamps; the update branch must keep
// the stored created_at instead of writing the zero datetime MySQL rejects.
func TestUpsertLinkKeepsCreatedAt(t *testing.T) {
	repo, db := newStore(t)
	ctx := context.Background()
	newLink := func(enabled bool) *model.Link {
		return &model.Link{
			Provider: model.ProviderGrafana, CITypeID: 3, Enabled: enabled,
			DashboardUID: "dash", OpenMode: model.OpenModeLink,
			VarMappingJSON: "[]", LabelMappingJSON: "[]", ExtraMatchersJSON: "[]",
		}
	}
	first := newLink(true)
	if err := repo.Upsert(ctx, first); err != nil {
		t.Fatalf("Upsert create: %v", err)
	}
	var stored model.Link
	if err := db.First(&stored, first.ID).Error; err != nil {
		t.Fatalf("load: %v", err)
	}
	if stored.CreatedAt.IsZero() {
		t.Fatalf("created_at was not persisted")
	}

	if err := repo.Upsert(ctx, newLink(false)); err != nil {
		t.Fatalf("Upsert update: %v", err)
	}
	var reloaded model.Link
	if err := db.First(&reloaded, stored.ID).Error; err != nil {
		t.Fatalf("reload: %v", err)
	}
	if reloaded.Enabled {
		t.Fatalf("enabled was not updated")
	}
	if !reloaded.CreatedAt.Equal(stored.CreatedAt) {
		t.Fatalf("created_at changed: %v -> %v", stored.CreatedAt, reloaded.CreatedAt)
	}
}

// UpdateConnection is called with a freshly built row that carries no
// timestamps. A full Save would write a zero created_at, which MySQL rejects
// under strict mode; the update must leave that column alone.
func TestUpdateConnectionKeepsCreatedAt(t *testing.T) {
	repo, db := newStore(t)
	ctx := context.Background()
	created := &model.Connection{
		Provider: model.ProviderGrafana, Name: "external",
		BaseURL: "https://grafana.example.com/grafana", AuthType: "bearer",
		AuthCipher: "cipher", Enabled: true,
	}
	if err := repo.CreateConnection(ctx, created); err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}
	var stored model.Connection
	if err := db.First(&stored, created.ID).Error; err != nil {
		t.Fatalf("load: %v", err)
	}
	if stored.CreatedAt.IsZero() {
		t.Fatalf("created_at was not persisted")
	}

	update := &model.Connection{
		ID: created.ID, Provider: model.ProviderGrafana, Name: "external",
		BaseURL: created.BaseURL, AuthType: "bearer", AuthCipher: "cipher",
		Enabled: false,
	}
	if err := repo.UpdateConnection(ctx, update); err != nil {
		t.Fatalf("UpdateConnection: %v", err)
	}
	var reloaded model.Connection
	if err := db.First(&reloaded, created.ID).Error; err != nil {
		t.Fatalf("reload: %v", err)
	}
	if reloaded.Enabled {
		t.Fatalf("enabled was not updated")
	}
	if !reloaded.CreatedAt.Equal(stored.CreatedAt) {
		t.Fatalf("created_at changed: %v -> %v", stored.CreatedAt, reloaded.CreatedAt)
	}
}
