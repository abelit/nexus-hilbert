package main

import (
	"log/slog"
	"time"

	"github.com/ongridio/ongrid/internal/manager/biz/aiops/tools/cmdb"
	"github.com/ongridio/ongrid/internal/pkg/auth"
	"github.com/ongridio/ongrid/internal/pkg/config"
)

// cmdbCallerTokenTTL is deliberately short: the token is minted per request
// and only needs to outlive one CMDB round-trip.
const cmdbCallerTokenTTL = time.Minute

// newCMDBClient builds the read-only CMDB client used by the assistant's
// tools. An empty ONGRID_CMDB_API_URL (or a nil signer) disables the tools
// instead of leaving a client that fails on every call. See ADR-037.
func newCMDBClient(cfg *config.Config, signer *auth.Signer, log *slog.Logger) *cmdb.Client {
	if cfg == nil || signer == nil {
		return nil
	}
	return cmdb.New(cfg.CMDB.APIURL, cmdb.NewSignerMinter(signer, cmdbCallerTokenTTL), nil, log)
}
