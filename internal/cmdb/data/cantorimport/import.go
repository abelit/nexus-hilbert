// Package cantorimport copies the CMDB tables of a nexus-cantor installation
// into an Ongrid CMDB schema.
//
// THE SOURCE IS CANTOR'S MYSQL SCHEMA, NOT A DUMP. cantor versioned its schema
// with Alembic and wrote `int` ids, nullable booleans and a `deleted` flag;
// Ongrid's models add `delete_marker`, `props_json` and NOT NULL defaults.
// Copying rows verbatim leaves deleted models and prefs visible and puts NULLs
// into columns the target declares NOT NULL, so every table is transformed as
// it is copied.
//
// THE COPY IS A ONE-WAY DATA MIGRATION, not an in-place adoption. The target
// keeps its own fresh schema, its own c_schema_meta lineage and its own
// migration lock; only the data rows and the user attribution around them
// move. The source database is only read.
//
// SECRETS ARE COPIED AS OPAQUE CIPHERTEXT. cantor encrypted choice webhooks
// and trigger credentials with its own SECRET_KEY/InnerCrypt, and the port
// deliberately does not decrypt them: decrypting would require the cantor key
// to be present in the CMDB service and would turn a data import into a
// credential-decryption operation. The port already treats adopted values as
// opaque (see cmdb/biz/citype), so the rows remain readable and a person can
// re-enter a credential when they need it. No secret is logged.
package cantorimport

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	driver "github.com/go-sql-driver/mysql"
)

// UserMode controls what happens to cantor's numeric user references.
type UserMode string

const (
	// UserModeCreate maps existing cantor users to Ongrid users by email and
	// creates a disabled, passwordless identity for users that do not exist.
	// The administrator (cantor uid 1) maps to the target superuser.
	UserModeCreate UserMode = "create"
	// UserModePreserve copies the numeric ids unchanged. The history page will
	// show #id for identities the target does not know.
	UserModePreserve UserMode = "preserve"
	// UserModeAdmin attributes every imported reference to the target
	// administrator. It is the fallback when the source has no users table.
	UserModeAdmin UserMode = "admin"
)

// Options are the import controls an operator can change.
type Options struct {
	// BatchSize is the number of rows inserted per statement. Zero uses
	// DefaultBatchSize.
	BatchSize int
	// DryRun reads and transforms every row but writes neither data nor users.
	DryRun bool
	// Resume permits a target that already holds rows and upserts by primary
	// key. Without it, any non-empty target table is refused.
	Resume bool
	// UserMode defaults to UserModeCreate.
	UserMode UserMode
	// Tables restricts the import to a subset of cmdbTables. Empty means all.
	Tables []string
	// Logger receives progress and warnings. Nil discards them.
	Logger *slog.Logger
}

// DefaultBatchSize is the multi-row INSERT batch size.
const DefaultBatchSize = 500

// TableReport is what happened to one source table.
type TableReport struct {
	Table        string
	SourceRows   int64
	ImportedRows int64
	SourceLive   int64
	TargetLive   int64
}

// SkippedTable is a source CMDB table this port does not own, or a manifest
// table the source does not have.
type SkippedTable struct {
	Table  string
	Rows   int64
	Reason string
}

// Report is the operator-facing result. It never contains a DSN password or a
// data value.
type Report struct {
	Tables         []TableReport
	Skipped        []SkippedTable
	UsersMapped    int
	UsersCreated   int
	UsersPreserved int
	Warnings       []string
	DryRun         bool
}

// Run copies the selected tables from source to target.
//
// Both handles must point at MySQL databases. The target schema must already
// have been migrated by the CMDB service; Run refuses to guess a schema.
func Run(ctx context.Context, source, target *sql.DB, opts Options) (*Report, error) {
	if source == nil || target == nil {
		return nil, errors.New("cantor import: nil database handle")
	}
	opts = opts.withDefaults()
	if err := opts.validate(); err != nil {
		return nil, err
	}
	log := opts.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	report := &Report{DryRun: opts.DryRun}
	tables := opts.Tables
	if len(tables) == 0 {
		tables = cmdbTables
	}

	existing, err := existingTables(ctx, source, target, tables)
	if err != nil {
		return nil, err
	}
	if err := refuseNonEmptyTarget(ctx, target, existing, opts); err != nil {
		return nil, err
	}

	userMap, err := prepareUsers(ctx, source, target, opts, report, log)
	if err != nil {
		return nil, err
	}

	for _, table := range tables {
		if !existing[table] {
			rows, countErr := sourceTableRows(ctx, source, table)
			if countErr != nil {
				return nil, countErr
			}
			report.Skipped = append(report.Skipped, SkippedTable{
				Table: table, Rows: rows, Reason: "table is not present in the source",
			})
			continue
		}
		tr, err := copyTable(ctx, source, target, table, opts, userMap, report, log)
		if err != nil {
			return nil, err
		}
		report.Tables = append(report.Tables, tr)
		log.Info("cmdb import: table copied",
			slog.String("table", tr.Table),
			slog.Int64("rows", tr.ImportedRows),
			slog.Bool("dry_run", opts.DryRun))
	}

	if !opts.DryRun {
		if err := verifyCounts(ctx, source, target, report); err != nil {
			return nil, err
		}
	}
	if err := collectUnsupported(ctx, source, report); err != nil {
		return nil, err
	}
	return report, nil
}

func (o Options) withDefaults() Options {
	if o.BatchSize == 0 {
		o.BatchSize = DefaultBatchSize
	}
	if o.UserMode == "" {
		o.UserMode = UserModeCreate
	}
	return o
}

func (o Options) validate() error {
	switch o.UserMode {
	case UserModeCreate, UserModePreserve, UserModeAdmin:
	default:
		return fmt.Errorf("cantor import: unknown user mode %q", o.UserMode)
	}
	if o.BatchSize < 1 {
		return fmt.Errorf("cantor import: batch size must be positive")
	}
	for _, table := range o.Tables {
		if !isCMDBTable(table) {
			return fmt.Errorf("cantor import: %q is not a CMDB table this importer owns", table)
		}
	}
	return nil
}

// existingTables reports which manifest tables exist in the source. A missing
// target table is a schema error: the CMDB service must have migrated it.
func existingTables(ctx context.Context, source, target *sql.DB, tables []string) (map[string]bool, error) {
	out := make(map[string]bool, len(tables))
	for _, table := range tables {
		ok, err := tableExists(ctx, source, table)
		if err != nil {
			return nil, err
		}
		if ok {
			ok, err = tableExists(ctx, target, table)
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, fmt.Errorf("cantor import: target is missing table %s; start the CMDB service once to migrate it", table)
			}
		}
		out[table] = ok
	}
	return out, nil
}

func refuseNonEmptyTarget(ctx context.Context, target *sql.DB, existing map[string]bool, opts Options) error {
	if opts.Resume || opts.DryRun {
		return nil
	}
	var nonEmpty []string
	for _, table := range sortedKeys(existing) {
		if !existing[table] {
			continue
		}
		n, err := countRows(ctx, target, table)
		if err != nil {
			return err
		}
		if n > 0 {
			nonEmpty = append(nonEmpty, fmt.Sprintf("%s (%d rows)", table, n))
		}
	}
	if len(nonEmpty) > 0 {
		return fmt.Errorf("cantor import: target already holds CMDB data: %s; re-run with --resume only if this is a partial import",
			strings.Join(nonEmpty, ", "))
	}
	return nil
}

// --- table metadata -------------------------------------------------------

type column struct {
	Name     string
	DataType string
	Nullable bool
	Default  *string
}

func tableExists(ctx context.Context, db *sql.DB, table string) (bool, error) {
	var n int
	err := db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
		table).Scan(&n)
	if err != nil {
		return false, fmt.Errorf("cantor import: inspect table %s: %w", table, err)
	}
	return n > 0, nil
}

func tableColumns(ctx context.Context, db *sql.DB, table string) ([]column, error) {
	rows, err := db.QueryContext(ctx, `
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = ?
ORDER BY ordinal_position`, table)
	if err != nil {
		return nil, fmt.Errorf("cantor import: columns for %s: %w", table, err)
	}
	defer rows.Close()
	var out []column
	for rows.Next() {
		var c column
		var nullable string
		var def sql.NullString
		if err := rows.Scan(&c.Name, &c.DataType, &nullable, &def); err != nil {
			return nil, err
		}
		c.Nullable = strings.EqualFold(nullable, "YES")
		if def.Valid {
			s := def.String
			c.Default = &s
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func countRows(ctx context.Context, db *sql.DB, table string) (int64, error) {
	q, err := quoteIdent(table)
	if err != nil {
		return 0, err
	}
	var n int64
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+q).Scan(&n); err != nil {
		return 0, fmt.Errorf("cantor import: count %s: %w", table, err)
	}
	return n, nil
}

func sourceTableRows(ctx context.Context, db *sql.DB, table string) (int64, error) {
	ok, err := tableExists(ctx, db, table)
	if err != nil || !ok {
		return 0, err
	}
	return countRows(ctx, db, table)
}

// collectUnsupported reports source c_* tables that have no target model. They
// remain in cantor; this tool does not silently drop them from the report.
func collectUnsupported(ctx context.Context, source *sql.DB, report *Report) error {
	rows, err := source.QueryContext(ctx, `
SELECT table_name FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_name LIKE 'c\\_%'
ORDER BY table_name`)
	if err != nil {
		return fmt.Errorf("cantor import: list source tables: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			return err
		}
		if isCMDBTable(table) || table == "c_schema_meta" {
			continue
		}
		n, err := countRows(ctx, source, table)
		if err != nil {
			return err
		}
		reason := "no target model; dashboards, ACL, legacy value tables and raw configuration stay in cantor"
		if table == "c_ad_counter" {
			reason = "the target computes ADC counters from c_ad_ci"
		}
		report.Skipped = append(report.Skipped, SkippedTable{
			Table: table, Rows: n, Reason: reason,
		})
	}
	return rows.Err()
}

// --- copy -----------------------------------------------------------------

type columnPlan struct {
	Target string
	Source string

	DeleteMarker bool
	PropsJSON    bool
	DeletedAt    bool
	UserRef      bool

	Default    any
	HasDefault bool
	Nullable   bool
}

func planTable(sourceCols, targetCols []column) ([]columnPlan, error) {
	source := make(map[string]column, len(sourceCols))
	for _, c := range sourceCols {
		source[c.Name] = c
	}
	plans := make([]columnPlan, 0, len(targetCols))
	for _, t := range targetCols {
		p := columnPlan{Target: t.Name, Nullable: t.Nullable}
		if _, ok := source[t.Name]; ok {
			p.Source = t.Name
			// A source row may still hold NULL in a column cantor declared
			// nullable and the port declared NOT NULL with a default. Keep the
			// target default available for that case; it is used only when the
			// source value is NULL.
			if t.Default != nil {
				p.Default, p.HasDefault = targetDefault(t), true
			}
		} else {
			switch t.Name {
			case "delete_marker":
				p.DeleteMarker = true
			case "props_json":
				p.PropsJSON = true
			default:
				d, err := defaultValue(t)
				if err != nil {
					return nil, err
				}
				p.Default, p.HasDefault = d, true
			}
		}
		switch {
		case t.Name == "delete_marker":
			p.DeleteMarker = true
		case p.Source == "deleted_at":
			p.DeletedAt = true
		case p.Source == "uid":
			p.UserRef = true
		case p.Source == "owner" && p.Target == "owner":
			// c_ad_rules.owner points at users, unlike a generic owner column.
			p.UserRef = true
		}
		plans = append(plans, p)
	}
	return plans, nil
}

func targetDefault(c column) any {
	if c.Default == nil {
		return nil
	}
	if strings.EqualFold(*c.Default, "CURRENT_TIMESTAMP") {
		return time.Now().UTC()
	}
	return *c.Default
}

func defaultValue(c column) (any, error) {
	if c.Default != nil {
		return targetDefault(c), nil
	}
	if c.Nullable {
		return nil, nil
	}
	return nil, fmt.Errorf("cantor import: target column %s is NOT NULL but has no default", c.Name)
}

func copyTable(ctx context.Context, source, target *sql.DB, table string, opts Options, users map[int64]int64, report *Report, log *slog.Logger) (TableReport, error) {
	tr := TableReport{Table: table}
	sourceCols, err := tableColumns(ctx, source, table)
	if err != nil {
		return tr, err
	}
	targetCols, err := tableColumns(ctx, target, table)
	if err != nil {
		return tr, err
	}
	if len(sourceCols) == 0 || len(targetCols) == 0 {
		return tr, fmt.Errorf("cantor import: %s has no columns", table)
	}
	plans, err := planTable(sourceCols, targetCols)
	if err != nil {
		return tr, fmt.Errorf("cantor import: plan %s: %w", table, err)
	}
	selectCols, err := sourceSelectColumns(plans, sourceCols)
	if err != nil {
		return tr, err
	}
	selectSQL, err := selectStatement(table, selectCols)
	if err != nil {
		return tr, err
	}
	rows, err := source.QueryContext(ctx, selectSQL)
	if err != nil {
		return tr, fmt.Errorf("cantor import: read %s: %w", table, err)
	}
	defer rows.Close()

	insertSQL, err := insertStatement(table, plans, opts.Resume)
	if err != nil {
		return tr, err
	}
	batch := make([][]any, 0, opts.BatchSize)
	flush := func() error {
		if len(batch) == 0 || opts.DryRun {
			batch = batch[:0]
			return nil
		}
		if err := insertBatch(ctx, target, insertSQL, batch); err != nil {
			return fmt.Errorf("cantor import: insert %s: %w", table, err)
		}
		tr.ImportedRows += int64(len(batch))
		batch = batch[:0]
		return nil
	}

	for rows.Next() {
		raw := make([]any, len(selectCols))
		ptrs := make([]any, len(raw))
		for i := range raw {
			ptrs[i] = &raw[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return tr, fmt.Errorf("cantor import: scan %s: %w", table, err)
		}
		sourceValues := make(map[string]any, len(selectCols))
		for i, name := range selectCols {
			sourceValues[name] = raw[i]
		}
		deleted := sourceDeleted(sourceValues)
		if deleted {
			// The source count is useful even when the row is not written in a
			// dry run.
			tr.SourceLive--
		}
		out, err := rowValues(table, plans, sourceValues, deleted, users, opts.UserMode)
		if err != nil {
			return tr, fmt.Errorf("cantor import: row %d of %s: %w", tr.SourceRows+1, table, err)
		}
		tr.SourceRows++
		batch = append(batch, out)
		if len(batch) >= opts.BatchSize {
			if err := flush(); err != nil {
				return tr, err
			}
		}
	}
	if err := rows.Err(); err != nil {
		return tr, fmt.Errorf("cantor import: read %s: %w", table, err)
	}
	if err := flush(); err != nil {
		return tr, err
	}
	if !opts.DryRun {
		tr.SourceLive = 0
		if hasSourceColumn(sourceCols, "deleted") {
			var live int64
			q, _ := quoteIdent(table)
			if err := source.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+q+" WHERE `deleted` = 0 OR `deleted` IS NULL").Scan(&live); err != nil {
				return tr, fmt.Errorf("cantor import: count live %s: %w", table, err)
			}
			tr.SourceLive = live
		} else {
			tr.SourceLive = tr.SourceRows
		}
	}
	if opts.DryRun {
		tr.ImportedRows = 0
		tr.SourceLive = 0
		if hasSourceColumn(sourceCols, "deleted") {
			q, _ := quoteIdent(table)
			if err := source.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+q+" WHERE `deleted` = 0 OR `deleted` IS NULL").Scan(&tr.SourceLive); err != nil {
				return tr, fmt.Errorf("cantor import: count live %s: %w", table, err)
			}
		} else {
			tr.SourceLive = tr.SourceRows
		}
	}
	log.Debug("cmdb import: table finished", slog.String("table", table), slog.Int64("rows", tr.SourceRows))
	return tr, nil
}

func sourceSelectColumns(plans []columnPlan, sourceCols []column) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	add := func(name string) error {
		if name == "" || seen[name] {
			return nil
		}
		if _, err := quoteIdent(name); err != nil {
			return err
		}
		seen[name] = true
		out = append(out, name)
		return nil
	}
	for _, p := range plans {
		if err := add(p.Source); err != nil {
			return nil, err
		}
	}
	// `deleted` has no target column, but the soft-delete transform reads it.
	if hasSourceColumn(sourceCols, "deleted") {
		if err := add("deleted"); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func selectStatement(table string, cols []string) (string, error) {
	tq, err := quoteIdent(table)
	if err != nil {
		return "", err
	}
	if len(cols) == 0 {
		return "", fmt.Errorf("cantor import: %s has no shared columns", table)
	}
	quoted := make([]string, len(cols))
	for i, c := range cols {
		quoted[i], err = quoteIdent(c)
		if err != nil {
			return "", err
		}
	}
	return "SELECT " + strings.Join(quoted, ", ") + " FROM " + tq, nil
}

func insertStatement(table string, plans []columnPlan, resume bool) (string, error) {
	tq, err := quoteIdent(table)
	if err != nil {
		return "", err
	}
	cols := make([]string, len(plans))
	placeholders := make([]string, len(plans))
	updates := make([]string, 0, len(plans))
	for i, p := range plans {
		cols[i], err = quoteIdent(p.Target)
		if err != nil {
			return "", err
		}
		placeholders[i] = "?"
		if resume && p.Target != "id" {
			q, _ := quoteIdent(p.Target)
			updates = append(updates, q+"=VALUES("+q+")")
		}
	}
	sqlText := "INSERT INTO " + tq + " (" + strings.Join(cols, ", ") + ") VALUES (" + strings.Join(placeholders, ", ") + ")"
	if resume && len(updates) > 0 {
		sqlText += " ON DUPLICATE KEY UPDATE " + strings.Join(updates, ", ")
	}
	return sqlText, nil
}

func insertBatch(ctx context.Context, target *sql.DB, statement string, batch [][]any) error {
	if len(batch) == 0 {
		return nil
	}
	width := len(batch[0])
	placeholders := make([]string, len(batch))
	args := make([]any, 0, len(batch)*width)
	for i, row := range batch {
		if len(row) != width {
			return fmt.Errorf("row has %d values, want %d", len(row), width)
		}
		group := make([]string, width)
		for j := range group {
			group[j] = "?"
		}
		placeholders[i] = "(" + strings.Join(group, ", ") + ")"
		args = append(args, row...)
	}
	head := strings.SplitN(statement, " VALUES ", 2)
	if len(head) != 2 {
		return fmt.Errorf("malformed insert statement")
	}
	sqlText := head[0] + " VALUES " + strings.Join(placeholders, ", ")
	if idx := strings.Index(head[1], " ON DUPLICATE KEY UPDATE "); idx >= 0 {
		sqlText += head[1][idx:]
	}
	tx, err := target.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, sqlText, args...); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func rowValues(table string, plans []columnPlan, source map[string]any, deleted bool, users map[int64]int64, mode UserMode) ([]any, error) {
	out := make([]any, len(plans))
	for i, p := range plans {
		switch {
		case p.DeleteMarker:
			if deleted {
				out[i] = int64(1)
			} else {
				out[i] = int64(0)
			}
		case p.PropsJSON:
			// The read path falls back to the value tables when the snapshot is
			// empty. The next write renders it; a backfill here would duplicate
			// the renderer and its model-resolution rules.
			out[i] = ""
		case p.DeletedAt:
			v := source[p.Source]
			if v == nil && deleted {
				v = firstNonNil(source["updated_at"], source["created_at"])
			}
			out[i] = v
		case p.UserRef:
			v := source[p.Source]
			if v == nil {
				// A nullable user reference (c_ad_rules.owner) stays unowned; a
				// required one (c_records.uid) has to point somewhere, and the
				// built-in administrator is the only identity always present.
				if mode == UserModePreserve || p.Nullable {
					out[i] = nil
				} else {
					out[i] = adminOrDefault(users)
				}
				break
			}
			old, err := asInt64(v)
			if err != nil {
				return nil, fmt.Errorf("%s.%s: %w", table, p.Target, err)
			}
			if mode == UserModePreserve || users == nil {
				out[i] = old
				break
			}
			newID, ok := users[old]
			if !ok {
				return nil, fmt.Errorf("%s.%s references unmapped user %d", table, p.Target, old)
			}
			out[i] = newID
		default:
			v := source[p.Source]
			if v == nil {
				if p.HasDefault {
					out[i] = p.Default
					break
				}
				if p.Nullable {
					out[i] = nil
					break
				}
				return nil, fmt.Errorf("%s.%s is NULL and the target requires a value", table, p.Target)
			}
			out[i] = v
		}
	}
	return out, nil
}

func adminOrDefault(users map[int64]int64) any {
	if len(users) == 0 {
		return nil
	}
	// The administrator is the only mapping every mode guarantees. The map is
	// keyed by source id; id 1 is cantor's built-in administrator.
	if id, ok := users[1]; ok {
		return id
	}
	return nil
}

func sourceDeleted(values map[string]any) bool {
	v, ok := values["deleted"]
	if !ok || v == nil {
		return false
	}
	switch x := v.(type) {
	case bool:
		return x
	case int64:
		return x != 0
	case []byte:
		return string(x) == "1" || strings.EqualFold(string(x), "true")
	case string:
		return x == "1" || strings.EqualFold(x, "true")
	default:
		return false
	}
}

func firstNonNil(values ...any) any {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}

func asInt64(v any) (int64, error) {
	switch x := v.(type) {
	case int64:
		return x, nil
	case int32:
		return int64(x), nil
	case int:
		return int64(x), nil
	case uint64:
		return int64(x), nil
	case []byte:
		n, err := strconv.ParseInt(string(x), 10, 64)
		if err != nil {
			return 0, fmt.Errorf("not an integer: %q", string(x))
		}
		return n, nil
	case string:
		n, err := strconv.ParseInt(x, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("not an integer: %q", x)
		}
		return n, nil
	default:
		return 0, fmt.Errorf("not an integer: %T", v)
	}
}

func hasSourceColumn(cols []column, name string) bool {
	for _, c := range cols {
		if c.Name == name {
			return true
		}
	}
	return false
}

// --- verification ---------------------------------------------------------

func verifyCounts(ctx context.Context, source, target *sql.DB, report *Report) error {
	for i := range report.Tables {
		tr := &report.Tables[i]
		if tr.Table == "" {
			continue
		}
		sourceRows, err := countRows(ctx, source, tr.Table)
		if err != nil {
			return err
		}
		targetRows, err := countRows(ctx, target, tr.Table)
		if err != nil {
			return err
		}
		if sourceRows != targetRows {
			return fmt.Errorf("cantor import: %s has %d source rows but %d target rows", tr.Table, sourceRows, targetRows)
		}
		tr.SourceRows, tr.ImportedRows = sourceRows, targetRows
		cols, err := tableColumns(ctx, source, tr.Table)
		if err != nil {
			return err
		}
		if hasSourceColumn(cols, "deleted") {
			var sourceLive int64
			q, _ := quoteIdent(tr.Table)
			if err := source.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+q+" WHERE `deleted` = 0 OR `deleted` IS NULL").Scan(&sourceLive); err != nil {
				return err
			}
			var targetLive int64
			if err := target.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+q+" WHERE `delete_marker` = 0").Scan(&targetLive); err != nil {
				return err
			}
			if sourceLive != targetLive {
				return fmt.Errorf("cantor import: %s has %d live source rows but %d live target rows", tr.Table, sourceLive, targetLive)
			}
			tr.SourceLive, tr.TargetLive = sourceLive, targetLive
		} else {
			tr.SourceLive, tr.TargetLive = sourceRows, targetRows
		}
	}
	return nil
}

// --- identifiers ----------------------------------------------------------

var identifierRE = regexp.MustCompile(`^[A-Za-z0-9_]+$`)

func quoteIdent(name string) (string, error) {
	if !identifierRE.MatchString(name) {
		return "", fmt.Errorf("cantor import: unsafe identifier %q", name)
	}
	return "`" + name + "`", nil
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// DescribeDSN is safe to log: password and query parameters are dropped.
func DescribeDSN(dsn string) string { return describeDSN(dsn) }

// describeDSN is safe to log: password and query parameters are dropped.
func describeDSN(dsn string) string {
	cfg, err := driver.ParseDSN(dsn)
	if err != nil {
		return "invalid DSN"
	}
	addr := cfg.Addr
	if addr == "" {
		addr = "local"
	}
	return addr + "/" + cfg.DBName
}

func (r *Report) String() string {
	if r == nil {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Cantor CMDB import (%s)\n", map[bool]string{true: "dry run", false: "write"}[r.DryRun])
	fmt.Fprintf(&b, "users: mapped=%d created=%d preserved=%d\n", r.UsersMapped, r.UsersCreated, r.UsersPreserved)
	for _, tr := range r.Tables {
		fmt.Fprintf(&b, "  %-32s source=%d imported=%d live=%d\n", tr.Table, tr.SourceRows, tr.ImportedRows, tr.SourceLive)
	}
	for _, s := range r.Skipped {
		fmt.Fprintf(&b, "  skipped %-24s rows=%d (%s)\n", s.Table, s.Rows, s.Reason)
	}
	for _, w := range r.Warnings {
		fmt.Fprintf(&b, "warning: %s\n", w)
	}
	return b.String()
}
