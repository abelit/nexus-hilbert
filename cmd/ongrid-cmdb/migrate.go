package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	driver "github.com/go-sql-driver/mysql"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	cmdbdata "github.com/ongridio/ongrid/internal/cmdb/data"
	"github.com/ongridio/ongrid/internal/cmdb/data/cantorimport"
	"github.com/ongridio/ongrid/internal/pkg/dbx"
	applogger "github.com/ongridio/ongrid/internal/pkg/logger"
)

// migrateCantor is the one-off data import path. It is a subcommand of the
// service binary rather than a second image: the CMDB image already carries
// the schema migrators and the driver, and an operator running the import is
// already running the same version of the service.
func migrateCantor(args []string) error {
	fs := flag.NewFlagSet("migrate-cantor", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var (
		sourceDSN = fs.String("source-dsn", "", "cantor MySQL DSN (or ONGRID_CANTOR_DSN)")
		targetDSN = fs.String("target-dsn", "", "Ongrid MySQL DSN (or ONGRID_DB_DSN)")
		dryRun    = fs.Bool("dry-run", false, "read and validate every row without writing")
		resume    = fs.Bool("resume", false, "upsert into a target that already holds imported rows")
		userMode  = fs.String("users", string(cantorimport.UserModeCreate), "user attribution: create, preserve or admin")
		batchSize = fs.Int("batch-size", cantorimport.DefaultBatchSize, "rows per INSERT")
		tables    = fs.String("tables", "", "comma-separated table subset (default: every CMDB table)")
	)
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: ongrid-cmdb migrate-cantor --source-dsn DSN [--target-dsn DSN] [--dry-run]")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if strings.TrimSpace(*sourceDSN) == "" {
		*sourceDSN = strings.TrimSpace(os.Getenv("ONGRID_CANTOR_DSN"))
	}
	if strings.TrimSpace(*targetDSN) == "" {
		*targetDSN = strings.TrimSpace(os.Getenv("ONGRID_DB_DSN"))
	}
	if *sourceDSN == "" {
		return fmt.Errorf("migrate-cantor: --source-dsn or ONGRID_CANTOR_DSN is required")
	}
	if *targetDSN == "" {
		return fmt.Errorf("migrate-cantor: --target-dsn or ONGRID_DB_DSN is required")
	}
	mode := cantorimport.UserMode(*userMode)
	switch mode {
	case cantorimport.UserModeCreate, cantorimport.UserModePreserve, cantorimport.UserModeAdmin:
	default:
		return fmt.Errorf("migrate-cantor: --users must be create, preserve or admin")
	}

	sourceCfg, err := parseDSN(*sourceDSN)
	if err != nil {
		return fmt.Errorf("migrate-cantor: source DSN: %w", err)
	}
	targetCfg, err := parseDSN(*targetDSN)
	if err != nil {
		return fmt.Errorf("migrate-cantor: target DSN: %w", err)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	source, err := sql.Open("mysql", sourceCfg.FormatDSN())
	if err != nil {
		return fmt.Errorf("migrate-cantor: open source: %w", err)
	}
	defer func() { _ = source.Close() }()
	if err := ping(ctx, source); err != nil {
		return fmt.Errorf("migrate-cantor: source: %w", err)
	}

	targetGorm, err := gorm.Open(mysql.Open(targetCfg.FormatDSN()), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		return fmt.Errorf("migrate-cantor: open target: %w", err)
	}
	target, err := targetGorm.DB()
	if err != nil {
		return fmt.Errorf("migrate-cantor: target handle: %w", err)
	}
	defer func() { _ = target.Close() }()

	// A dry run must not create or alter the target schema either. The operator
	// is expected to have started the service once; the importer reports a
	// missing table with an actionable error otherwise.
	if !*dryRun {
		log := applogger.WithService(applogger.New(slog.LevelInfo), "ongrid-cmdb-migrate")
		if err := dbx.RunMigrationsLocked(ctx, targetGorm, 60*time.Second, log, cmdbdata.Migrate); err != nil {
			return fmt.Errorf("migrate-cantor: migrate target schema: %w", err)
		}
	}

	opts := cantorimport.Options{
		BatchSize: *batchSize,
		DryRun:    *dryRun,
		Resume:    *resume,
		UserMode:  mode,
		Tables:    splitTables(*tables),
		Logger:    applogger.WithService(applogger.New(slog.LevelInfo), "ongrid-cmdb-migrate"),
	}
	fmt.Fprintf(os.Stdout, "source: %s\ntarget: %s\n", cantorimport.DescribeDSN(sourceCfg.FormatDSN()), cantorimport.DescribeDSN(targetCfg.FormatDSN()))
	report, err := cantorimport.Run(ctx, source, target, opts)
	if err != nil {
		return fmt.Errorf("migrate-cantor: %w", err)
	}
	fmt.Fprint(os.Stdout, report.String())
	return nil
}

func parseDSN(dsn string) (*driver.Config, error) {
	cfg, err := driver.ParseDSN(strings.TrimSpace(dsn))
	if err != nil {
		return nil, err
	}
	// The importer needs time.Time values for datetime columns and UTF-8 for
	// Chinese labels; neither is optional for this copy.
	cfg.ParseTime = true
	if cfg.Params == nil {
		cfg.Params = map[string]string{}
	}
	cfg.Params["charset"] = "utf8mb4"
	return cfg, nil
}

func ping(ctx context.Context, db *sql.DB) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return db.PingContext(ctx)
}

func splitTables(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if table := strings.TrimSpace(part); table != "" {
			out = append(out, table)
		}
	}
	return out
}
