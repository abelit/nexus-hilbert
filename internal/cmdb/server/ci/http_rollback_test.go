package ci

import (
	"net/http"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestCutoffAcceptsEitherAPointOrARecord(t *testing.T) {
	at := time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC)

	cutoff, err := parseCutoff(at.Format(time.RFC3339), 0)
	if err != nil {
		t.Fatalf("parseCutoff(time) error = %v", err)
	}
	if !cutoff.Before.Equal(at) || cutoff.RecordID != 0 {
		t.Fatalf("cutoff = %+v, want the timestamp only", cutoff)
	}

	cutoff, err = parseCutoff("", 42)
	if err != nil {
		t.Fatalf("parseCutoff(record) error = %v", err)
	}
	if cutoff.RecordID != 42 || !cutoff.Before.IsZero() {
		t.Fatalf("cutoff = %+v, want the record only", cutoff)
	}

	cutoff, err = parseCutoff(at.Format(time.RFC3339), 42)
	if err != nil {
		t.Fatalf("parseCutoff(both) error = %v", err)
	}
	if !cutoff.Before.Equal(at) || cutoff.RecordID != 42 {
		t.Fatalf("cutoff = %+v, want both", cutoff)
	}
}

func TestCutoffRejectsMissingOrMalformedInput(t *testing.T) {
	if _, err := parseCutoff("", 0); err == nil {
		t.Fatal("an empty cutoff was accepted")
	}
	if _, err := parseCutoff("yesterday", 0); err == nil {
		t.Fatal("a malformed timestamp was accepted")
	}
	if _, err := parseCutoff("", -1); err == nil {
		t.Fatal("a negative record id was accepted")
	}
}

func TestRollbackRoutesAreRegistered(t *testing.T) {
	r := chi.NewRouter()
	NewHandler(nil).Register(r)

	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/v1/cmdb/instances/1/baseline"},
		{http.MethodPost, "/v1/cmdb/instances/1/rollback"},
	} {
		routeCtx := chi.NewRouteContext()
		if !r.Match(routeCtx, tc.method, tc.path) {
			t.Errorf("%s %s did not match any route", tc.method, tc.path)
		}
	}
}
