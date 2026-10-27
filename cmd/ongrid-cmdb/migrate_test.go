package main

import (
	"strings"
	"testing"

	"github.com/ongridio/ongrid/internal/cmdb/data/cantorimport"
)

func TestParseDSNForcesTheImporterRequirements(t *testing.T) {
	cfg, err := parseDSN("user:secret@tcp(127.0.0.1:3306)/cmdb?parseTime=false&charset=latin1")
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.ParseTime {
		t.Fatal("parseTime was not forced on")
	}
	if cfg.Params["charset"] != "utf8mb4" {
		t.Fatalf("charset = %q, want utf8mb4", cfg.Params["charset"])
	}
}

func TestSplitTables(t *testing.T) {
	got := splitTables(" c_cis, ,c_attributes ")
	if len(got) != 2 || got[0] != "c_cis" || got[1] != "c_attributes" {
		t.Fatalf("splitTables = %#v", got)
	}
	if splitTables("  ") != nil {
		t.Fatal("empty table list should be nil")
	}
}

func TestParseDSNRejectsMalformedInput(t *testing.T) {
	if _, err := parseDSN("not a dsn"); err == nil {
		t.Fatal("parseDSN accepted a malformed DSN")
	}
}

func TestDescribeDSNHidesThePassword(t *testing.T) {
	cfg, err := parseDSN("user:supersecret@tcp(127.0.0.1:3306)/cmdb")
	if err != nil {
		t.Fatal(err)
	}
	// The CLI prints the importer's description, not the raw DSN.
	got := cantorimport.DescribeDSN(cfg.FormatDSN())
	if strings.Contains(got, "supersecret") {
		t.Fatalf("description leaked the password: %s", got)
	}
	if !strings.Contains(got, "cmdb") {
		t.Fatalf("description = %q, want the database name", got)
	}
}
