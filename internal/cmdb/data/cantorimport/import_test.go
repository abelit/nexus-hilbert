package cantorimport

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"
	"time"

	driver "github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	cmdbdata "github.com/ongridio/ongrid/internal/cmdb/data"
)

// These tests need a real MySQL because the importer reads MySQL's
// information_schema, writes MySQL's JSON/TEXT/DATETIME shapes, and relies on
// ON DUPLICATE KEY UPDATE for resume. SQLite would exercise a different
// implementation than the one operations run.
func newTestPair(t *testing.T) (source, target *sql.DB) {
	t.Helper()
	dsn := os.Getenv("ONGRID_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set ONGRID_TEST_MYSQL_DSN to run the cantor import tests")
	}
	cfg, err := driver.ParseDSN(dsn)
	if err != nil {
		t.Fatalf("invalid ONGRID_TEST_MYSQL_DSN: %v", err)
	}
	cfg.ParseTime = true
	cfg.DBName = ""
	admin, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close() })
	if err := admin.Ping(); err != nil {
		t.Fatalf("ping MySQL: %v", err)
	}

	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	sourceName := "cantor_src_" + suffix
	targetName := "cantor_dst_" + suffix
	for _, name := range []string{sourceName, targetName} {
		if _, err := admin.Exec("CREATE DATABASE `" + name + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"); err != nil {
			t.Fatalf("create database %s: %v", name, err)
		}
	}
	t.Cleanup(func() {
		_, _ = admin.Exec("DROP DATABASE IF EXISTS `" + sourceName + "`")
		_, _ = admin.Exec("DROP DATABASE IF EXISTS `" + targetName + "`")
	})

	sourceCfg := *cfg
	sourceCfg.DBName = sourceName
	source, err = sql.Open("mysql", sourceCfg.FormatDSN())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = source.Close() })

	targetCfg := *cfg
	targetCfg.DBName = targetName
	targetGorm, err := gorm.Open(mysql.Open(targetCfg.FormatDSN()), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := cmdbdata.Migrate(targetGorm); err != nil {
		t.Fatalf("migrate target: %v", err)
	}
	target, err = targetGorm.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = target.Close() })

	seedTargetUsers(t, target)
	seedCantorSource(t, source)
	return source, target
}

func seedTargetUsers(t *testing.T, target *sql.DB) {
	t.Helper()
	_, err := target.Exec(`
CREATE TABLE users (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  email varchar(256) DEFAULT NULL,
  pass_hash varchar(512) DEFAULT NULL,
  display_name varchar(128) NOT NULL DEFAULT '',
  phone varchar(32) NOT NULL DEFAULT '',
  role varchar(32) DEFAULT 'user',
  is_superuser tinyint(1) NOT NULL DEFAULT 0,
  status varchar(32) DEFAULT 'active',
  created_at datetime(3) DEFAULT NULL,
  updated_at datetime(3) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
	if err != nil {
		t.Fatalf("create users: %v", err)
	}
	if _, err := target.Exec(
		"INSERT INTO users (email, display_name, role, is_superuser, status) VALUES (?, ?, 'admin', 1, 'active')",
		"admin@target.test", "admin",
	); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
}

func seedCantorSource(t *testing.T, source *sql.DB) {
	t.Helper()
	stmts := []string{
		`CREATE TABLE users (
			uid int NOT NULL AUTO_INCREMENT,
			username varchar(32) DEFAULT NULL,
			nickname varchar(20) DEFAULT NULL,
			email varchar(100) DEFAULT NULL,
			mobile varchar(14) DEFAULT NULL,
			date_joined datetime DEFAULT NULL,
			deleted tinyint(1) DEFAULT NULL,
			PRIMARY KEY (uid)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
		`CREATE TABLE c_relation_types (
			id int NOT NULL AUTO_INCREMENT,
			deleted_at datetime DEFAULT NULL,
			deleted tinyint(1) DEFAULT NULL,
			created_at datetime DEFAULT NULL,
			updated_at datetime DEFAULT NULL,
			name varchar(16) NOT NULL,
			color varchar(7) DEFAULT NULL,
			PRIMARY KEY (id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
		`CREATE TABLE c_attributes (
			id int NOT NULL AUTO_INCREMENT,
			deleted_at datetime DEFAULT NULL,
			deleted tinyint(1) DEFAULT NULL,
			created_at datetime DEFAULT NULL,
			updated_at datetime DEFAULT NULL,
			name varchar(32) NOT NULL,
			alias varchar(32) NOT NULL,
			value_type varchar(1) DEFAULT NULL,
			uid int DEFAULT NULL,
			is_password tinyint(1) DEFAULT NULL,
			PRIMARY KEY (id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
		`CREATE TABLE c_ci_types (
			id int NOT NULL AUTO_INCREMENT,
			deleted_at datetime DEFAULT NULL,
			deleted tinyint(1) DEFAULT NULL,
			created_at datetime DEFAULT NULL,
			updated_at datetime DEFAULT NULL,
			name varchar(32) NOT NULL,
			alias varchar(32) NOT NULL,
			unique_id int NOT NULL,
			enabled tinyint(1) DEFAULT NULL,
			is_attached tinyint(1) DEFAULT NULL,
			` + "`order`" + ` smallint DEFAULT NULL,
			uid int DEFAULT NULL,
			PRIMARY KEY (id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
		`CREATE TABLE c_cis (
			id int NOT NULL AUTO_INCREMENT,
			deleted_at datetime DEFAULT NULL,
			deleted tinyint(1) DEFAULT NULL,
			created_at datetime DEFAULT NULL,
			updated_at datetime DEFAULT NULL,
			type_id int DEFAULT NULL,
			status varchar(1) DEFAULT NULL,
			heartbeat datetime DEFAULT NULL,
			a tinyint(1) DEFAULT NULL,
			updated_by varchar(64) DEFAULT NULL,
			PRIMARY KEY (id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
		`CREATE TABLE c_value_index_texts (
			id int NOT NULL AUTO_INCREMENT,
			deleted_at datetime DEFAULT NULL,
			deleted tinyint(1) DEFAULT NULL,
			created_at datetime DEFAULT NULL,
			updated_at datetime DEFAULT NULL,
			ci_id int NOT NULL,
			attr_id int NOT NULL,
			value varchar(128) NOT NULL,
			PRIMARY KEY (id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
		`CREATE TABLE c_records (
			id int NOT NULL AUTO_INCREMENT,
			created_at datetime DEFAULT NULL,
			uid int NOT NULL,
			PRIMARY KEY (id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
		`CREATE TABLE c_ci_type_histories (
			id int NOT NULL AUTO_INCREMENT,
			deleted_at datetime DEFAULT NULL,
			deleted tinyint(1) DEFAULT NULL,
			created_at datetime DEFAULT NULL,
			updated_at datetime DEFAULT NULL,
			type_id int NOT NULL,
			uid int DEFAULT NULL,
			operate_type varchar(2) DEFAULT NULL,
			` + "`change`" + ` json DEFAULT NULL,
			PRIMARY KEY (id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
		`INSERT INTO users (uid, username, nickname, email, date_joined, deleted) VALUES
			(1, 'admin', 'admin', 'admin@source.test', '2024-01-01 00:00:00', 0),
			(3, 'worker', 'Worker', 'worker@source.test', '2024-01-01 00:00:00', 0),
			(46, 'demo', 'Demo', 'demo@source.test', '2024-01-01 00:00:00', 0)`,
		`INSERT INTO c_relation_types (id, deleted, deleted_at, created_at, updated_at, name, color) VALUES
			(1, 0, NULL, '2024-01-01 00:00:00', '2024-01-01 00:00:00', 'runs_on', '#111111'),
			(2, 1, '2024-01-02 00:00:00', '2024-01-01 00:00:00', '2024-01-02 00:00:00', 'gone', NULL)`,
		`INSERT INTO c_attributes (id, deleted, deleted_at, created_at, updated_at, name, alias, value_type, uid, is_password) VALUES
			(10, 0, NULL, '2024-01-01 00:00:00', '2024-01-01 00:00:00', 'hostname', '主机名', '2', 3, 0),
			(11, 1, '2024-01-02 00:00:00', '2024-01-01 00:00:00', '2024-01-02 00:00:00', 'old_attr', '旧字段', '2', 3, 0),
			(12, 0, NULL, '2024-01-01 00:00:00', '2024-01-01 00:00:00', 'root_password', '密码', '2', 872, 1)`,
		`INSERT INTO c_ci_types (id, deleted, deleted_at, created_at, updated_at, name, alias, unique_id, enabled, is_attached, ` + "`order`" + `, uid) VALUES
			(20, 0, NULL, '2024-01-01 00:00:00', '2024-01-01 00:00:00', 'host', '主机', 10, 1, 0, 0, 1),
			(21, 1, '2024-01-02 00:00:00', '2024-01-01 00:00:00', '2024-01-02 00:00:00', 'gone', '已删', 10, 1, 0, 0, 1)`,
		`INSERT INTO c_cis (id, deleted, deleted_at, created_at, updated_at, type_id, status, heartbeat, a, updated_by) VALUES
			(100, 0, NULL, '2024-01-01 00:00:00', '2024-01-01 00:00:00', 20, '1', NULL, NULL, 'admin'),
			(101, 1, NULL, '2024-01-01 00:00:00', '2024-01-03 00:00:00', 20, '1', NULL, 1, 'admin')`,
		`INSERT INTO c_value_index_texts (id, deleted, deleted_at, created_at, updated_at, ci_id, attr_id, value) VALUES
			(1, 0, NULL, '2024-01-01 00:00:00', '2024-01-01 00:00:00', 100, 10, 'web-01'),
			(2, 1, '2024-01-02 00:00:00', '2024-01-01 00:00:00', '2024-01-02 00:00:00', 101, 10, 'gone-01')`,
		`INSERT INTO c_records (id, created_at, uid) VALUES (1, '2024-01-01 00:00:00', 46)`,
		`INSERT INTO c_ci_type_histories (id, deleted, deleted_at, created_at, updated_at, type_id, uid, operate_type, ` + "`change`" + `) VALUES
			(1, 0, NULL, '2024-01-01 00:00:00', '2024-01-01 00:00:00', 20, 46, '1', '{"name":"host"}')`,
	}
	for _, stmt := range stmts {
		if _, err := source.Exec(stmt); err != nil {
			t.Fatalf("seed source: %v\n%s", err, stmt)
		}
	}
}

var testTables = []string{
	"c_relation_types", "c_attributes", "c_ci_types", "c_cis",
	"c_value_index_texts", "c_records", "c_ci_type_histories",
}

func runTestImport(t *testing.T, source, target *sql.DB, opts Options) *Report {
	t.Helper()
	if opts.Tables == nil {
		opts.Tables = testTables
	}
	if opts.UserMode == "" {
		opts.UserMode = UserModeCreate
	}
	report, err := Run(context.Background(), source, target, opts)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if report == nil {
		t.Fatal("Run() returned a nil report")
	}
	return report
}

func testCount(t *testing.T, db *sql.DB, table string) int64 {
	t.Helper()
	var n int64
	if err := db.QueryRow("SELECT COUNT(*) FROM `" + table + "`").Scan(&n); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return n
}

func userIDByEmail(t *testing.T, db *sql.DB, email string) int64 {
	t.Helper()
	var id int64
	if err := db.QueryRow("SELECT id FROM users WHERE email = ?", email).Scan(&id); err != nil {
		t.Fatalf("user %q: %v", email, err)
	}
	return id
}

func TestRunCopiesCantorRowsAndNormalisesTheSchema(t *testing.T) {
	source, target := newTestPair(t)

	report := runTestImport(t, source, target, Options{BatchSize: 2})

	if got, want := testCount(t, target, "c_relation_types"), testCount(t, source, "c_relation_types"); got != want {
		t.Fatalf("relation types = %d, want %d", got, want)
	}
	if got, want := testCount(t, target, "c_cis"), testCount(t, source, "c_cis"); got != want {
		t.Fatalf("CIs = %d, want %d", got, want)
	}

	// cantor's `deleted` flag becomes GORM's delete_marker, and a missing
	// cantor deleted_at is filled from the row's updated_at so the deletion is
	// still datable.
	var marker int64
	var deletedAt *time.Time
	if err := target.QueryRow("SELECT delete_marker, deleted_at FROM c_cis WHERE id = 101").Scan(&marker, &deletedAt); err != nil {
		t.Fatal(err)
	}
	if marker == 0 {
		t.Fatal("soft-deleted CI was imported as live")
	}
	if deletedAt == nil || !deletedAt.Equal(time.Date(2024, 1, 3, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("deleted_at = %v, want the source updated_at", deletedAt)
	}
	if err := target.QueryRow("SELECT delete_marker FROM c_cis WHERE id = 100").Scan(&marker); err != nil {
		t.Fatal(err)
	}
	if marker != 0 {
		t.Fatalf("live CI delete_marker = %d, want 0", marker)
	}

	// Target-only columns are filled from the target schema, not left NULL.
	var a int64
	if err := target.QueryRow("SELECT a FROM c_cis WHERE id = 100").Scan(&a); err != nil {
		t.Fatal(err)
	}
	if a != 0 {
		t.Fatalf("c_cis.a = %d, want the target default 0", a)
	}
	var props string
	if err := target.QueryRow("SELECT props_json FROM c_cis WHERE id = 100").Scan(&props); err != nil {
		t.Fatal(err)
	}
	if props != "" {
		t.Fatalf("props_json = %q, want an empty document", props)
	}

	// The source users are mapped to real, disabled IAM identities. The
	// administrator is the existing target administrator, not a new row.
	adminID := userIDByEmail(t, target, "admin@target.test")
	workerID := userIDByEmail(t, target, "worker@source.test")
	demoID := userIDByEmail(t, target, "demo@source.test")
	placeholderID := userIDByEmail(t, target, "cantor-uid-872@invalid.local")
	if adminID != 1 {
		t.Fatalf("admin id = %d, want the existing target admin", adminID)
	}
	for _, id := range []int64{workerID, demoID, placeholderID} {
		var status, passHash string
		if err := target.QueryRow("SELECT status, pass_hash FROM users WHERE id = ?", id).Scan(&status, &passHash); err != nil {
			t.Fatal(err)
		}
		if status != "disabled" || passHash != "" {
			t.Fatalf("user %d = status %q pass_hash %q, want a disabled identity with no password", id, status, passHash)
		}
	}
	if demoID == placeholderID {
		t.Fatalf("demo and placeholder mapped to the same user %d", demoID)
	}

	var recordUID, attrUID, historyUID int64
	if err := target.QueryRow("SELECT uid FROM c_records WHERE id = 1").Scan(&recordUID); err != nil {
		t.Fatal(err)
	}
	if err := target.QueryRow("SELECT uid FROM c_attributes WHERE id = 12").Scan(&attrUID); err != nil {
		t.Fatal(err)
	}
	if err := target.QueryRow("SELECT uid FROM c_ci_type_histories WHERE id = 1").Scan(&historyUID); err != nil {
		t.Fatal(err)
	}
	if recordUID != demoID || historyUID != demoID {
		t.Fatalf("record/history uid = %d/%d, want demo id %d", recordUID, historyUID, demoID)
	}
	if attrUID != placeholderID {
		t.Fatalf("attribute uid = %d, want placeholder id %d", attrUID, placeholderID)
	}

	var userCount int64
	if err := target.QueryRow("SELECT COUNT(*) FROM users").Scan(&userCount); err != nil {
		t.Fatal(err)
	}
	if userCount != 4 {
		t.Fatalf("target users = %d, want admin + worker + demo + placeholder", userCount)
	}
	if report.UsersCreated != 3 || report.UsersMapped != 1 {
		t.Fatalf("user report = %+v, want 3 created and 1 mapped", report)
	}

	var value string
	if err := target.QueryRow("SELECT value FROM c_value_index_texts WHERE id = 1").Scan(&value); err != nil {
		t.Fatal(err)
	}
	if value != "web-01" {
		t.Fatalf("value = %q, want web-01", value)
	}
}

func TestRunResumeIsIdempotent(t *testing.T) {
	source, target := newTestPair(t)
	runTestImport(t, source, target, Options{BatchSize: 2})
	before := map[string]int64{}
	for _, table := range testTables {
		before[table] = testCount(t, target, table)
	}

	report := runTestImport(t, source, target, Options{BatchSize: 2, Resume: true})
	if report.UsersCreated != 0 {
		t.Fatalf("resume created %d users, want 0", report.UsersCreated)
	}
	for _, table := range testTables {
		if got := testCount(t, target, table); got != before[table] {
			t.Fatalf("%s rows after resume = %d, want %d", table, got, before[table])
		}
	}
}

func TestRunRefusesANonEmptyTargetWithoutResume(t *testing.T) {
	source, target := newTestPair(t)
	runTestImport(t, source, target, Options{BatchSize: 2})

	if _, err := Run(context.Background(), source, target, Options{
		Tables: testTables, UserMode: UserModeCreate, BatchSize: 2,
	}); err == nil {
		t.Fatal("Run() on a non-empty target = nil error, want a refusal")
	}
}

func TestRunDryRunWritesNothing(t *testing.T) {
	source, target := newTestPair(t)
	report := runTestImport(t, source, target, Options{BatchSize: 2, DryRun: true})

	for _, table := range testTables {
		if got := testCount(t, target, table); got != 0 {
			t.Fatalf("%s has %d rows after a dry run", table, got)
		}
	}
	var users int64
	if err := target.QueryRow("SELECT COUNT(*) FROM users").Scan(&users); err != nil {
		t.Fatal(err)
	}
	if users != 1 {
		t.Fatalf("users = %d after a dry run, want only the seeded admin", users)
	}
	if len(report.Tables) == 0 {
		t.Fatal("dry run reported no tables")
	}
}

func TestManifestCoversEveryTargetCMDBTable(t *testing.T) {
	_, target := newTestPair(t)
	rows, err := target.Query(
		`SELECT table_name FROM information_schema.tables
		 WHERE table_schema = DATABASE() AND table_name LIKE 'c\_%' AND table_name <> 'c_schema_meta'
		 ORDER BY table_name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	have := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		have[name] = true
	}
	for _, name := range cmdbTables {
		if !have[name] {
			t.Fatalf("manifest table %s does not exist in the target schema", name)
		}
		delete(have, name)
	}
	if len(have) > 0 {
		t.Fatalf("target CMDB tables missing from the manifest: %v", have)
	}
}

func TestRequiredTargetColumnsWithoutDefaultsFail(t *testing.T) {
	source, target := newTestPair(t)
	if _, err := source.Exec("INSERT INTO c_cis (id, deleted, created_at, updated_at, type_id) VALUES (102, 0, NOW(), NOW(), NULL)"); err != nil {
		t.Fatal(err)
	}
	_, err := Run(context.Background(), source, target, Options{
		Tables: []string{"c_cis"}, UserMode: UserModeCreate, BatchSize: 2,
	})
	if err == nil || !strings.Contains(err.Error(), "type_id") {
		t.Fatalf("Run() error = %v, want a required type_id error", err)
	}
}

func TestReportIncludesSkippedSourceTables(t *testing.T) {
	source, target := newTestPair(t)
	if _, err := source.Exec("CREATE TABLE c_c_d (id int PRIMARY KEY, name varchar(64))"); err != nil {
		t.Fatal(err)
	}
	if _, err := source.Exec("INSERT INTO c_c_d (id, name) VALUES (1, 'dashboard')"); err != nil {
		t.Fatal(err)
	}
	report := runTestImport(t, source, target, Options{BatchSize: 2})
	found := false
	for _, skipped := range report.Skipped {
		if skipped.Table == "c_c_d" && skipped.Rows == 1 {
			found = true
		}
	}
	if !found {
		t.Fatalf("skipped tables = %+v, want c_c_d with 1 row", report.Skipped)
	}
}

func TestUsersCanBePreservedInsteadOfCreated(t *testing.T) {
	source, target := newTestPair(t)
	report := runTestImport(t, source, target, Options{BatchSize: 2, UserMode: UserModePreserve})
	if report.UsersCreated != 0 {
		t.Fatalf("preserve mode created %d users", report.UsersCreated)
	}
	var uid int64
	if err := target.QueryRow("SELECT uid FROM c_records WHERE id = 1").Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if uid != 46 {
		t.Fatalf("record uid = %d, want the preserved source id 46", uid)
	}
}

func TestValidateOptions(t *testing.T) {
	for _, tc := range []struct {
		name string
		opts Options
	}{
		{name: "unknown user mode", opts: Options{UserMode: "wat"}},
		{name: "negative batch", opts: Options{BatchSize: -1, UserMode: UserModeCreate}},
		{name: "unknown table", opts: Options{Tables: []string{"c_nope"}, UserMode: UserModeCreate}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.opts.validate(); err == nil {
				t.Fatal("validate() = nil, want an error")
			}
		})
	}
}

func TestDSNMetadataNeverPrintsThePassword(t *testing.T) {
	got := describeDSN("user:supersecret@tcp(127.0.0.1:3306)/cmdb")
	if strings.Contains(got, "supersecret") {
		t.Fatalf("describeDSN leaked the password: %s", got)
	}
	if !strings.Contains(got, "cmdb") {
		t.Fatalf("describeDSN = %q, want the database name", got)
	}
	if got := describeDSN("not a dsn"); got != "invalid DSN" {
		t.Fatalf("describeDSN(invalid) = %q", got)
	}
}

func TestFormatReportDoesNotLeakCredentials(t *testing.T) {
	report := &Report{Tables: []TableReport{{Table: "c_cis", SourceRows: 1}}}
	out := report.String()
	if out == "" || !strings.Contains(out, "c_cis") {
		t.Fatalf("report = %q", out)
	}
	if strings.Contains(out, "password") {
		t.Fatalf("report leaked a credential: %s", out)
	}
}
