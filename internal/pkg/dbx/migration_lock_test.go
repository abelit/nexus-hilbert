package dbx

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gorm.io/gorm"

	"github.com/ongridio/ongrid/internal/pkg/config"
)

// The MySQL branch is exercised against a real server in integration runs;
// these tests pin the SQLite file-lock behavior that keeps two CMDB replicas
// from running AutoMigrate at the same time.

func openSQLiteFile(t *testing.T) *gorm.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ongrid.db")
	db, err := Open(config.DBConfig{Dialect: "sqlite", Path: path}, nil)
	if err != nil {
		t.Fatalf("Open(%s): %v", path, err)
	}
	return db
}

func TestRunMigrationsLocked_SerializesConcurrentSQLiteMigrations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ongrid.db")
	db1, err := Open(config.DBConfig{Dialect: "sqlite", Path: path}, nil)
	if err != nil {
		t.Fatalf("open db1: %v", err)
	}
	db2, err := Open(config.DBConfig{Dialect: "sqlite", Path: path}, nil)
	if err != nil {
		t.Fatalf("open db2: %v", err)
	}

	var active, maxActive int32
	migrator := func(db *gorm.DB) error {
		n := atomic.AddInt32(&active, 1)
		for {
			m := atomic.LoadInt32(&maxActive)
			if n <= m || atomic.CompareAndSwapInt32(&maxActive, m, n) {
				break
			}
		}
		time.Sleep(150 * time.Millisecond)
		atomic.AddInt32(&active, -1)
		return db.AutoMigrate(&fakeModel{})
	}

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, db := range []*gorm.DB{db1, db2} {
		wg.Add(1)
		go func(db *gorm.DB) {
			defer wg.Done()
			errs <- RunMigrationsLocked(context.Background(), db, 5*time.Second, nil, migrator)
		}(db)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("RunMigrationsLocked: %v", err)
		}
	}
	if got := atomic.LoadInt32(&maxActive); got != 1 {
		t.Fatalf("max concurrent migrations = %d, want 1", got)
	}
}

func TestRunMigrationsLocked_TimesOutWhenLockHeld(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ongrid.db")
	db, err := Open(config.DBConfig{Dialect: "sqlite", Path: path}, nil)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}

	release, err := acquireMigrationLock(context.Background(), db, 2*time.Second)
	if err != nil {
		t.Fatalf("acquire first lock: %v", err)
	}
	defer func() { _ = release() }()

	err = RunMigrationsLocked(context.Background(), db, 100*time.Millisecond, nil, fakeMigrator)
	if err == nil {
		t.Fatal("expected timeout error while the lock is held")
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("error = %q, want a timeout message", err)
	}
}

func TestRunMigrationsLocked_InMemorySkipsFileLock(t *testing.T) {
	db, err := Open(config.DBConfig{Dialect: "sqlite", Path: ":memory:"}, nil)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := RunMigrationsLocked(context.Background(), db, time.Second, nil, fakeMigrator); err != nil {
		t.Fatalf("RunMigrationsLocked(:memory:): %v", err)
	}
	var name string
	if err := db.Raw(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, "fake_models").Scan(&name).Error; err != nil {
		t.Fatalf("lookup fake_models: %v", err)
	}
	if name != "fake_models" {
		t.Fatalf("fake_models table missing (got %q)", name)
	}
}

func TestRunMigrationsLocked_NilDBRejected(t *testing.T) {
	if err := RunMigrationsLocked(context.Background(), nil, time.Second, nil, fakeMigrator); err == nil {
		t.Fatal("expected error for nil db")
	}
}
