package setting

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	model "github.com/ongridio/ongrid/internal/manager/model/setting"
)

func TestParseDeviceFileRoots(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"empty", "", nil},
		{"comma and newline", " /srv/app , D:\\data\n", []string{"/srv/app", `D:\data`}},
		{"dedupe", "/a,/a,/b", []string{"/a", "/b"}},
		{"skip oversized entry", "/ok," + strings.Repeat("x", maxDeviceFileRootLen+1), []string{"/ok"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ParseDeviceFileRoots(tc.in); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("ParseDeviceFileRoots(%q) = %#v, want %#v", tc.in, got, tc.want)
			}
		})
	}

	many := make([]string, 0, maxDeviceFileRoots+5)
	for i := 0; i < maxDeviceFileRoots+5; i++ {
		many = append(many, fmt.Sprintf("/p%d", i))
	}
	if got := ParseDeviceFileRoots(strings.Join(many, ",")); len(got) != maxDeviceFileRoots {
		t.Fatalf("len = %d, want cap %d", len(got), maxDeviceFileRoots)
	}
}

func TestDeviceFileRootsPrecedence(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	svc := New(repo, nil)
	t.Setenv("ONGRID_DEVICE_FILE_ROOTS", "/from-env")
	p := NewDeviceFileRoots(svc)

	if got, want := p.Roots(ctx), []string{"/from-env"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("env fallback = %#v, want %#v", got, want)
	}
	if err := svc.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileWriteRoots, "/from-db", false); err != nil {
		t.Fatal(err)
	}
	if got, want := p.Roots(ctx), []string{"/from-db"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("db value = %#v, want %#v", got, want)
	}
	if err := svc.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileWriteRoots, "", false); err != nil {
		t.Fatal(err)
	}
	if got := p.Roots(ctx); len(got) != 0 {
		t.Fatalf("explicit empty row = %#v, want sandbox-only", got)
	}
	if err := svc.Delete(ctx, model.CategoryPlatform, model.KeyDeviceFileWriteRoots); err != nil {
		t.Fatal(err)
	}
	if got, want := p.Roots(ctx), []string{"/from-env"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after delete = %#v, want env fallback %#v", got, want)
	}
}

func TestDeviceFileRootsFailsClosedOnReadError(t *testing.T) {
	repo := newFakeRepo()
	repo.getErr = errors.New("db down")
	svc := New(repo, nil)
	t.Setenv("ONGRID_DEVICE_FILE_ROOTS", "/from-env")
	p := NewDeviceFileRoots(svc)

	if got := p.Roots(context.Background()); len(got) != 0 {
		t.Fatalf("read error = %#v, want sandbox-only (no env fallback)", got)
	}
}

func TestDeviceFileRootsBypassesProcessCache(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	svc := New(repo, nil)
	t.Setenv("ONGRID_DEVICE_FILE_ROOTS", "/from-env")
	p := NewDeviceFileRoots(svc)

	if _, err := repo.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileWriteRoots, "/first", false); err != nil {
		t.Fatal(err)
	}
	if got, want := p.Roots(ctx), []string{"/first"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("first read = %#v, want %#v", got, want)
	}
	// Another manager instance writes the row; this process never saw a Set.
	if _, err := repo.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileWriteRoots, "/second", false); err != nil {
		t.Fatal(err)
	}
	if got, want := p.Roots(ctx), []string{"/second"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after cross-instance update = %#v, want %#v", got, want)
	}
}

func TestValidateDeviceFileWriteRoots(t *testing.T) {
	repo := newFakeRepo()
	svc := New(repo, nil)
	ctx := context.Background()

	if err := svc.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileWriteRoots, `D:\data,/srv/app`, false); err != nil {
		t.Fatalf("valid list rejected: %v", err)
	}
	if err := svc.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileWriteRoots, strings.Repeat("x", maxDeviceFileRootLen+1), false); err == nil {
		t.Fatal("oversized entry accepted")
	}
	tooMany := make([]string, maxDeviceFileRoots+1)
	for i := range tooMany {
		tooMany[i] = fmt.Sprintf("/p%d", i)
	}
	if err := svc.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileWriteRoots, strings.Join(tooMany, ","), false); err == nil {
		t.Fatal("oversized list accepted")
	}
	huge := make([]string, maxDeviceFileRoots)
	for i := range huge {
		huge[i] = fmt.Sprintf("/%02d%s", i, strings.Repeat("x", maxDeviceFileRootLen-3))
	}
	if err := svc.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileWriteRoots, strings.Join(huge, ","), false); err == nil {
		t.Fatal("list exceeding the preface budget accepted")
	}
	trimmed := ParseDeviceFileRoots(strings.Join(huge, "\n"))
	encoded, err := json.Marshal(trimmed)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) > maxDeviceFileRootsJSON {
		t.Fatalf("parsed roots JSON = %d bytes, want <= %d", len(encoded), maxDeviceFileRootsJSON)
	}
	if len(trimmed) == 0 || len(trimmed) >= len(huge) {
		t.Fatalf("parser did not trim to the budget: %d of %d entries", len(trimmed), len(huge))
	}
}
