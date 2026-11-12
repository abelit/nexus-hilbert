//go:build windows

package main

import (
	"context"
	"log/slog"
	"path/filepath"

	edgebiz "github.com/ongridio/ongrid/internal/edgeagent/biz"
	edgeconfig "github.com/ongridio/ongrid/internal/edgeagent/config"
	edgeplugins "github.com/ongridio/ongrid/internal/edgeagent/plugins"
	edgeplugincustommetrics "github.com/ongridio/ongrid/internal/edgeagent/plugins/custommetrics"
	edgeplugindatabasemetrics "github.com/ongridio/ongrid/internal/edgeagent/plugins/databasemetrics"
	edgepluginhostmetrics "github.com/ongridio/ongrid/internal/edgeagent/plugins/hostmetrics"
	edgepluginlogs "github.com/ongridio/ongrid/internal/edgeagent/plugins/logs"
	edgepluginmetrics "github.com/ongridio/ongrid/internal/edgeagent/plugins/metrics"
	edgeplugintraces "github.com/ongridio/ongrid/internal/edgeagent/plugins/traces"
	"github.com/ongridio/ongrid/internal/pkg/config"
	"github.com/ongridio/ongrid/internal/pkg/tunnel"
	"golang.org/x/sync/errgroup"
)

// windowsUnsupportedPlugins are not registered on Windows. They either depend
// on Linux-only host facilities (autoapm/OBI capture, profiles) or are not
// part of the supported Windows bundle.
var windowsUnsupportedPlugins = []string{"autoapm", "profiles", "obi", "procmetrics"}

// windowsPlugins builds the supported Windows plugin set: metrics and
// custommetrics run in-process, the rest wrap bundled .exe subprocesses.
func windowsPlugins(binDir, workDir string, client tunnel.Client, edgeID func() uint64, log *slog.Logger) []edgeplugins.Plugin {
	return []edgeplugins.Plugin{
		edgepluginmetrics.New(client, edgeID, log),
		edgeplugincustommetrics.New(client, edgeID, log),
		edgepluginhostmetrics.New(binDir, workDir, log),
		edgepluginlogs.New(binDir, workDir, log),
		edgeplugintraces.New(binDir, workDir, log),
		edgeplugindatabasemetrics.New(binDir, workDir, client, edgeID, log),
	}
}

func startPlugins(ctx context.Context, cfg *config.Config, log *slog.Logger, client tunnel.Client, agent *edgebiz.Agent, k8sInfo *tunnel.KubernetesInfo, eg *errgroup.Group) {
	// Windows registers a reduced plugin set. The Kubernetes-only telemetry
	// gateway branch is not available here, and unsupported plugins stay
	// unregistered (their binaries may still be absent, which is reported via
	// plugin health rather than aborting startup).
	log.Info("windows: unsupported plugins disabled", slog.Any("plugins", windowsUnsupportedPlugins))

	pluginBinDir := edgeconfig.EnvOr("ONGRID_EDGE_PLUGIN_BIN_DIR", defaultPluginBinDir())
	pluginWorkDir := edgeconfig.EnvOr("ONGRID_EDGE_PLUGIN_WORK_DIR", defaultPluginWorkDir())
	pluginLog := log.With(slog.String("comp", "plugins"))

	edgeplugindatabasemetrics.RegisterSecretHandler(client, pluginLog)
	registered := windowsPlugins(pluginBinDir, pluginWorkDir, client, agent.EdgeID, pluginLog)

	pluginNames := make([]string, 0, len(registered))
	for _, p := range registered {
		pluginNames = append(pluginNames, p.Name())
	}
	tunnelFetcher := edgeplugins.NewTunnelConfigFetcherWithCredentials(
		client,
		pluginNames,
		cfg.Edge.AccessKey,
		cfg.Edge.SecretKey,
	)
	supervisor := edgeplugins.NewSupervisor(edgeplugins.SupervisorOpts{
		Fetcher: tunnelFetcher,
		Log:     pluginLog,
	})
	for _, p := range registered {
		supervisor.Register(p)
	}
	edgeplugintraces.RegisterApplicationReceiver(client, supervisor, filepath.Join(pluginWorkDir, edgeplugintraces.Name, "otelcol.yaml"), nil)
	agent.SetPluginHealthFn(supervisor.HealthWire)
	supervisor.RegisterReloadHandler(client)
	eg.Go(func() error { return supervisor.Run(ctx) })
}
