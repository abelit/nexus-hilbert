package setting

import (
	"context"
	"errors"
	"testing"

	model "github.com/ongridio/ongrid/internal/manager/model/setting"
)

func TestValidateDeviceFileMaxUploadMB(t *testing.T) {
	repo := newFakeRepo()
	svc := New(repo, nil)
	ctx := context.Background()

	for _, value := range []string{"1", "1024", "8192", ""} {
		if err := svc.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileMaxUploadMB, value, false); err != nil {
			t.Fatalf("valid value %q rejected: %v", value, err)
		}
	}
	for _, value := range []string{"0", "-1", "8193", "abc", "1.5"} {
		if err := svc.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileMaxUploadMB, value, false); err == nil {
			t.Fatalf("invalid value %q accepted", value)
		}
	}
}

func TestDeviceFileUploadLimitDefaults(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	svc := New(repo, nil)
	p := NewDeviceFileUploadLimit(svc)

	if got, want := p.LimitBytes(ctx), int64(DefaultDeviceFileMaxUploadMB)<<20; got != want {
		t.Fatalf("default = %d, want %d", got, want)
	}
	if err := svc.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileMaxUploadMB, "1024", false); err != nil {
		t.Fatal(err)
	}
	if got, want := p.LimitBytes(ctx), int64(1024)<<20; got != want {
		t.Fatalf("configured = %d, want %d", got, want)
	}
	if err := svc.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileMaxUploadMB, "", false); err != nil {
		t.Fatal(err)
	}
	if got, want := p.LimitBytes(ctx), int64(DefaultDeviceFileMaxUploadMB)<<20; got != want {
		t.Fatalf("empty row = %d, want default %d", got, want)
	}
}

func TestDeviceFileUploadLimitFailsToDefaultOnReadError(t *testing.T) {
	repo := newFakeRepo()
	repo.getErr = errors.New("db down")
	svc := New(repo, nil)
	p := NewDeviceFileUploadLimit(svc)
	if got, want := p.LimitBytes(context.Background()), int64(DefaultDeviceFileMaxUploadMB)<<20; got != want {
		t.Fatalf("read error = %d, want default %d", got, want)
	}
}

func TestDeviceFileUploadLimitBypassesProcessCache(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	svc := New(repo, nil)
	p := NewDeviceFileUploadLimit(svc)

	if _, err := repo.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileMaxUploadMB, "1024", false); err != nil {
		t.Fatal(err)
	}
	if got, want := p.LimitBytes(ctx), int64(1024)<<20; got != want {
		t.Fatalf("first read = %d, want %d", got, want)
	}
	if _, err := repo.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileMaxUploadMB, "2048", false); err != nil {
		t.Fatal(err)
	}
	if got, want := p.LimitBytes(ctx), int64(2048)<<20; got != want {
		t.Fatalf("cross-instance update = %d, want %d", got, want)
	}
}
