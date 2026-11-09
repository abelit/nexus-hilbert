// Command ongrid-cmdb is the standalone CMDB service. It owns the CMDB
// schema migrations, serves /api/v1/cmdb/*, and verifies the same bearer
// tokens the manager issues.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/sync/errgroup"

	cibiz "github.com/ongridio/ongrid/internal/cmdb/biz/ci"
	cmdbcitypebiz "github.com/ongridio/ongrid/internal/cmdb/biz/citype"
	cmdbdiscoverybiz "github.com/ongridio/ongrid/internal/cmdb/biz/discovery"
	cmdbfilebiz "github.com/ongridio/ongrid/internal/cmdb/biz/file"
	cmdbdata "github.com/ongridio/ongrid/internal/cmdb/data"
	cistore "github.com/ongridio/ongrid/internal/cmdb/data/ci/store"
	cmdbcitypedata "github.com/ongridio/ongrid/internal/cmdb/data/citype/store"
	"github.com/ongridio/ongrid/internal/pkg/auth"
	"github.com/ongridio/ongrid/internal/pkg/config"
	"github.com/ongridio/ongrid/internal/pkg/dbx"
	"github.com/ongridio/ongrid/internal/pkg/httpserver"
	"github.com/ongridio/ongrid/internal/pkg/logger"
	"github.com/ongridio/ongrid/internal/pkg/prom"
	"github.com/ongridio/ongrid/internal/pkg/tracing"
)

// version is overwritten at build time via -ldflags.
var version = "dev"

const (
	defaultHTTPAddr    = ":8082"
	defaultMetricsAddr = ":9102"
)

func main() {
	var cleanupRelations, dryRun, planRelationSplit, splitRelations, ensureVocabulary, ensureBuiltinModels, planServiceLayers bool
	for _, arg := range os.Args[1:] {
		switch arg {
		case "--version", "-v":
			fmt.Fprintf(os.Stdout, "ongrid-cmdb %s\n", version)
			return
		case "--healthcheck":
			addr := strings.TrimSpace(os.Getenv("ONGRID_HTTP_ADDR"))
			if addr == "" {
				addr = defaultHTTPAddr
			}
			if err := runHealthcheck(addr, 3*time.Second); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			return
		case "--cleanup-relations":
			cleanupRelations = true
		case "--dry-run":
			dryRun = true
		case "--plan-relation-split":
			planRelationSplit = true
		case "--split-relations":
			splitRelations = true
		case "--ensure-relation-vocabulary":
			ensureVocabulary = true
		case "--ensure-builtin-models":
			ensureBuiltinModels = true
		case "--plan-service-layers":
			planServiceLayers = true
		}
	}
	if dryRun && !cleanupRelations && !splitRelations && !ensureVocabulary {
		fmt.Fprintln(os.Stderr, "--dry-run is only valid with --cleanup-relations, --split-relations or --ensure-relation-vocabulary")
		os.Exit(1)
	}
	commands := 0
	for _, on := range []bool{cleanupRelations, splitRelations, planRelationSplit, ensureVocabulary, ensureBuiltinModels, planServiceLayers} {
		if on {
			commands++
		}
	}
	if commands > 1 {
		fmt.Fprintln(os.Stderr, "choose one of --cleanup-relations, --split-relations, --plan-relation-split, --ensure-relation-vocabulary, --ensure-builtin-models, --plan-service-layers")
		os.Exit(1)
	}

	// The standalone binary's defaults are its own ports, not the manager's
	// :8080/:9100. Setting them before config.Load keeps a bare `./ongrid-cmdb`
	// and `--healthcheck` (which reads the same env) on the same address.
	if strings.TrimSpace(os.Getenv("ONGRID_HTTP_ADDR")) == "" {
		_ = os.Setenv("ONGRID_HTTP_ADDR", defaultHTTPAddr)
	}
	if strings.TrimSpace(os.Getenv("ONGRID_METRICS_ADDR")) == "" {
		_ = os.Setenv("ONGRID_METRICS_ADDR", defaultMetricsAddr)
	}
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "config load: %v\n", err)
		os.Exit(1)
	}

	log := logger.WithService(logger.New(slog.LevelInfo), "ongrid-cmdb")
	// cmdbdata.Migrate uses slog.Default() for schema-lineage messages; make
	// those lines carry the same service/JSON shape as the rest of the process.
	slog.SetDefault(log)
	log.Info("configuration loaded",
		slog.String("http_addr", cfg.HTTPAddr),
		slog.String("metrics_addr", cfg.MetricsAddr),
		slog.String("version", version))

	rootCtx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	otelEndpoint := strings.TrimSpace(os.Getenv("ONGRID_OTEL_ENDPOINT"))
	if otelEndpoint == "" {
		otelEndpoint = "tempo:4318"
	}
	otelSamplingRatio := 1.0
	if raw := strings.TrimSpace(os.Getenv("ONGRID_OTEL_SAMPLING_RATIO")); raw != "" {
		ratio, parseErr := strconv.ParseFloat(raw, 64)
		if parseErr != nil || math.IsNaN(ratio) || ratio < 0 || ratio > 1 {
			log.Warn("tracing: invalid sampling ratio, using 1.0", slog.String("value", raw))
		} else {
			otelSamplingRatio = ratio
		}
	}
	otelShutdown, err := tracing.Init(rootCtx, tracing.Config{
		ServiceName:      "ongrid-cmdb",
		ServiceNamespace: "ongrid",
		Environment:      "internal",
		Endpoint:         otelEndpoint,
		Insecure:         true,
		SamplingRatio:    otelSamplingRatio,
	})
	if err != nil {
		// tracing.Init returns a nil shutdown on its error paths; registering a
		// defer that calls it would panic during ordinary shutdown.
		log.Warn("tracing: init failed (continuing without OTel)", slog.Any("err", err))
	} else {
		defer func() {
			shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer shutdownCancel()
			_ = otelShutdown(shutdownCtx)
		}()
	}

	db, err := dbx.Open(cfg.DB, log)
	if err != nil {
		fatal(log, "open database", err)
	}

	// The CMDB service is the ONLY owner of these migrations. The manager no
	// longer calls cmdbdata.Migrate; keeping it out of the manager also keeps
	// two processes from AutoMigrating the same schema at once.
	if err := dbx.RunMigrationsLocked(rootCtx, db, 60*time.Second, log, cmdbdata.Migrate); err != nil {
		fatal(log, "run cmdb migrations", err)
	}

	// The Phase 2 relation cleanup is an EXPLICIT operator command, not a
	// startup side effect. It prints a JSON report; --dry-run skips the edge
	// writes, though the migrations above still ran.
	if cleanupRelations {
		report, err := cistore.CleanupRelations(rootCtx, db, dryRun)
		if err != nil {
			fatal(log, "cleanup relations", err)
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(report); err != nil {
			fatal(log, "encode cleanup report", err)
		}
		return
	}
	if splitRelations {
		report, err := cistore.ApplyRelationSplit(rootCtx, db, dryRun)
		if err != nil {
			fatal(log, "split relations", err)
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(report); err != nil {
			fatal(log, "encode split report", err)
		}
		return
	}
	if planRelationSplit {
		report, err := cistore.PlanRelationSplit(rootCtx, db)
		if err != nil {
			fatal(log, "plan relation split", err)
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(report); err != nil {
			fatal(log, "encode relation split plan", err)
		}
		return
	}
	// The service-layer plan is read-only: it reports what the RFC-011 M1
	// classification can decide and what needs a human. Creating the target
	// CIs is a separate apply step after the review queue is empty.
	if planServiceLayers {
		report, err := cistore.PlanServiceLayers(rootCtx, db)
		if err != nil {
			fatal(log, "plan service layers", err)
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(report); err != nil {
			fatal(log, "encode service layer plan", err)
		}
		return
	}
	// The managed vocabulary is provisioned EXPLICITLY. Some target words have
	// no legacy rule to split and are not needed by the built-in bootstrap, so
	// without this command a new writer would have no semantically configured
	// type to use. Existing rows are never overwritten.
	if ensureVocabulary {
		report, err := cistore.EnsureRelationVocabulary(rootCtx, db, dryRun)
		if err != nil {
			fatal(log, "ensure relation vocabulary", err)
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(report); err != nil {
			fatal(log, "encode vocabulary report", err)
		}
		return
	}
	// The built-in model bootstrap is the same explicit admin action the HTTP
	// endpoint exposes, available to an operator without a session. It creates
	// the DCIM/IPAM models and the RFC-011 service-layer template, and leaves
	// every existing model untouched.
	if ensureBuiltinModels {
		citypeUC := cmdbcitypebiz.NewUsecase(cmdbcitypedata.NewRepo(db), log)
		got, err := citypeUC.EnsureBuiltinModels(rootCtx, cmdbcitypebiz.BuiltinEnsureInput{
			Models:    cibiz.AllBuiltinModels(),
			Relations: cibiz.AllBuiltinRelations(),
		})
		if err != nil {
			fatal(log, "ensure builtin models", err)
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(got); err != nil {
			fatal(log, "encode builtin model report", err)
		}
		return
	}

	// A malformed dedicated signing seed must stop the process: continuing
	// without a trust anchor would silently downgrade task verification.
	if _, _, err := cmdbdiscoverybiz.SigningKeyFromEnv(); err != nil {
		fatal(log, "discovery task signing key", err)
	}

	s3UseSSL := cfg.FileStorage.S3UseSSL
	handlers, closeTriggers := buildHandlers(db, log, cmdbfilebiz.Options{
		DefaultLocalPath:        cfg.FileStorage.LocalDir,
		DefaultStorageBackend:   cfg.FileStorage.Backend,
		DefaultS3EndpointURL:    cfg.FileStorage.S3EndpointURL,
		DefaultS3AccessKey:      cfg.FileStorage.S3AccessKey,
		DefaultS3SecretKey:      cfg.FileStorage.S3SecretKey,
		DefaultS3BucketName:     cfg.FileStorage.S3BucketName,
		DefaultS3Region:         cfg.FileStorage.S3Region,
		DefaultS3UseSSL:         &s3UseSSL,
		DefaultPreviewURL:       cfg.FileStorage.PreviewURL,
		DefaultFileFetchBaseURL: cfg.FileStorage.FileFetchBaseURL,
		PreviewInternalURL:      cfg.FileStorage.PreviewInternalURL,
		DefaultMaxFileSizeMB:    cfg.FileStorage.MaxFileSizeMB,
		SignerSecret:            cfg.JWT.Secret,
	})
	signer := auth.NewSigner(cfg.JWT.Secret, cfg.JWT.AccessTTL, cfg.JWT.RefreshTTL)
	apiMux := newRouter(db, signer, handlers, version)

	apiServer := httpserver.New(cfg.HTTPAddr, apiMux, log.With(slog.String("listener", "api")))
	metricsMux := chi.NewRouter()
	metricsMux.Handle("/metrics", prom.Handler(prom.NewRegistry()))
	metricsServer := httpserver.New(cfg.MetricsAddr, metricsMux, log.With(slog.String("listener", "metrics")))

	eg, egCtx := errgroup.WithContext(rootCtx)
	eg.Go(func() error { return apiServer.Start(egCtx) })
	eg.Go(func() error { return metricsServer.Start(egCtx) })
	if err := eg.Wait(); err != nil && !errors.Is(err, context.Canceled) {
		fatal(log, "service stopped with error", err)
	}

	// The HTTP servers have stopped, so no more writes can enqueue firings.
	// Draining here gives the queued ones their deadline instead of dropping
	// them at process exit.
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := closeTriggers(shutdownCtx); err != nil {
		log.Warn("trigger dispatcher did not drain", slog.Any("err", err))
	}
	log.Info("shutdown complete", slog.String("version", version))
}

func fatal(log *slog.Logger, msg string, err error) {
	log.Error(msg, slog.Any("err", err))
	os.Exit(1)
}
