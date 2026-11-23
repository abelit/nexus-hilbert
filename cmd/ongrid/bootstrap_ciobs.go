package main

import (
	"context"
	"errors"
	"log/slog"

	ciobsbiz "github.com/ongridio/ongrid/internal/manager/biz/ciobs"
	cmdbclient "github.com/ongridio/ongrid/internal/manager/biz/aiops/tools/cmdb"
	managerbizgrafana "github.com/ongridio/ongrid/internal/manager/biz/grafana"
	ciobsdata "github.com/ongridio/ongrid/internal/manager/data/ciobs/store"
	ciobsserver "github.com/ongridio/ongrid/internal/manager/server/ciobs"
	ciobsservice "github.com/ongridio/ongrid/internal/manager/service/ciobs"
	"github.com/ongridio/ongrid/internal/pkg/promquery"
)

type ciobsModule struct {
	handler *ciobsserver.Handler
}

// ciobsGlobalProbe checks the platform's INTERNAL Grafana/Prometheus. The
// external connections are probed inside the ciobs use case.
type ciobsGlobalProbe struct {
	grafana *managerbizgrafana.Service
	prom    *promquery.Client
}

func (p ciobsGlobalProbe) ProbeGrafana(ctx context.Context) error {
	if p.grafana == nil {
		return errors.New("grafana is not configured")
	}
	return p.grafana.Test(ctx)
}

func (p ciobsGlobalProbe) ProbeProm(ctx context.Context) error {
	if p.prom == nil {
		return errors.New("prometheus is not configured")
	}
	_, err := p.prom.Alerts(ctx)
	return err
}

// bootstrapCIObs wires CI monitoring links and their connection management.
// It reuses the global Grafana root (resolved in the SPA) and the shared Prom
// query client for the internal connection; external connections carry their
// own encrypted credentials.
func bootstrapCIObs(log *slog.Logger, storage *storageModule, cmdbClient *cmdbclient.Client, prom *promquery.Client, settings *settingsModule) *ciobsModule {
	logger := log.With(slog.String("comp", "ciobs"))
	repo := ciobsdata.NewRepo(storage.db)
	uc := ciobsbiz.NewUsecase(repo, cmdbFederationReader{client: cmdbClient}, prom, logger)
	uc.SetCrypto(secretboxCrypto{})
	uc.SetGlobalProbe(ciobsGlobalProbe{grafana: settings.grafanaSvc, prom: prom})
	uc.SetPlatformToggles(settings.settingSvc)
	return &ciobsModule{
		handler: ciobsserver.NewHandler(ciobsservice.New(uc), logger),
	}
}
