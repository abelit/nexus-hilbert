package main

import (
	"io"
	"log/slog"
	"net/http"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	federationdata "github.com/ongridio/ongrid/internal/manager/data/federation/store"
)

func TestFederationWiringRegistersRoutes(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := federationdata.Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	mod := bootstrapFederation(slog.New(slog.NewTextHandler(io.Discard, nil)), &storageModule{db: db}, &iamModule{})
	if mod == nil || mod.handler == nil {
		t.Fatal("bootstrapFederation returned no handler")
	}

	router := chi.NewRouter()
	mod.handler.Register(router)
	found := map[string]bool{}
	if err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		found[method+" "+route] = true
		return nil
	}); err != nil {
		t.Fatalf("walk: %v", err)
	}
	for _, want := range []string{
		"GET /v1/federation/alerts",
		"GET /v1/federation/connections",
		"POST /v1/federation/connections",
		"GET /v1/federation/connections/health",
		"DELETE /v1/federation/connections/{id}",
	} {
		if !found[want] {
			t.Fatalf("route %q missing; got %v", want, found)
		}
	}
}
