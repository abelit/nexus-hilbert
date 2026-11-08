package main

import (
	"log/slog"
	"testing"
	"time"

	"github.com/ongridio/ongrid/internal/pkg/auth"
	"github.com/ongridio/ongrid/internal/pkg/config"
)

func TestNewCMDBClientGatedOnURL(t *testing.T) {
	signer := auth.NewSigner("test-secret", time.Minute, time.Hour)
	if got := newCMDBClient(&config.Config{}, signer, slog.Default()); got != nil {
		t.Fatal("empty URL must disable CMDB tools")
	}

	cfg := &config.Config{CMDB: config.CMDBConfig{APIURL: "http://ongrid-cmdb:8082"}}
	if got := newCMDBClient(cfg, signer, slog.Default()); got == nil {
		t.Fatal("configured URL must build a client")
	}
}
