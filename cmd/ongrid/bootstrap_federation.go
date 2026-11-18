package main

import (
	"log/slog"

	federationbiz "github.com/ongridio/ongrid/internal/manager/biz/federation"
	federationdata "github.com/ongridio/ongrid/internal/manager/data/federation/store"
	federationserver "github.com/ongridio/ongrid/internal/manager/server/federation"
	federationservice "github.com/ongridio/ongrid/internal/manager/service/federation"
	"github.com/ongridio/ongrid/internal/pkg/secretbox"
)

// federationModule wires the read-only external alert/ITSM sources. Its
// config lives in dedicated tables (migrated from bootstrap_storage) and its
// credentials use the platform secret box.
type federationModule struct {
	handler *federationserver.Handler
}

// secretboxCrypto is the production at-rest crypto for federation
// credentials. The biz layer owns the keep/clear/replace semantics; this
// adapter only delegates to the platform primitive.
type secretboxCrypto struct{}

func (secretboxCrypto) Encrypt(plain string) (string, error) { return secretbox.Encrypt(plain) }
func (secretboxCrypto) Decrypt(cipher string) (string, error) { return secretbox.Decrypt(cipher) }
func (secretboxCrypto) Weak() bool                           { return secretbox.KeyIsWeak() }

func bootstrapFederation(log *slog.Logger, storage *storageModule) *federationModule {
	logger := log.With(slog.String("comp", "federation"))
	repo := federationdata.NewRepo(storage.db)
	uc := federationbiz.NewUsecase(repo, federationdata.NewUpstream(), secretboxCrypto{}, logger)
	return &federationModule{
		handler: federationserver.NewHandler(federationservice.New(uc), logger),
	}
}
