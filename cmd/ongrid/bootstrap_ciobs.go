package main

import (
	"log/slog"

	ciobsbiz "github.com/ongridio/ongrid/internal/manager/biz/ciobs"
	ciobsdata "github.com/ongridio/ongrid/internal/manager/data/ciobs/store"
	ciobsserver "github.com/ongridio/ongrid/internal/manager/server/ciobs"
	ciobsservice "github.com/ongridio/ongrid/internal/manager/service/ciobs"
	cmdbclient "github.com/ongridio/ongrid/internal/manager/biz/aiops/tools/cmdb"
	"github.com/ongridio/ongrid/internal/pkg/promquery"
)

type ciobsModule struct {
	handler *ciobsserver.Handler
}

// bootstrapCIObs wires CI monitoring links. It reuses the global Grafana root
// (resolved in the SPA) and the shared Prom query client; no credentials are
// stored in ci_monitoring_links. A nil Prom client leaves Prometheus reads
// returning "prometheus_unavailable" instead of failing the process.
func bootstrapCIObs(log *slog.Logger, storage *storageModule, cmdbClient *cmdbclient.Client, prom *promquery.Client) *ciobsModule {
	logger := log.With(slog.String("comp", "ciobs"))
	repo := ciobsdata.NewRepo(storage.db)
	uc := ciobsbiz.NewUsecase(repo, cmdbFederationReader{client: cmdbClient}, prom, logger)
	return &ciobsModule{
		handler: ciobsserver.NewHandler(ciobsservice.New(uc), logger),
	}
}
