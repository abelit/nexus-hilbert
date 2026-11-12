//go:build windows

package main

import (
	"io"
	"log/slog"
	"testing"
)

func TestWindowsPluginSet(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	registered := windowsPlugins(t.TempDir(), t.TempDir(), nil, func() uint64 { return 0 }, log)

	want := []string{
		"metrics",
		"custommetrics",
		"hostmetrics",
		"logs",
		"traces",
		"databasemetrics",
	}
	got := make([]string, 0, len(registered))
	for _, p := range registered {
		got = append(got, p.Name())
	}
	if len(got) != len(want) {
		t.Fatalf("registered plugins = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("registered plugins = %v, want %v", got, want)
		}
	}
}

func TestWindowsPluginSetExcludesUnsupported(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	registered := windowsPlugins(t.TempDir(), t.TempDir(), nil, func() uint64 { return 0 }, log)

	names := make(map[string]bool, len(registered))
	for _, p := range registered {
		names[p.Name()] = true
	}
	for _, excluded := range []string{"autoapm", "profiles", "obi", "procmetrics"} {
		if names[excluded] {
			t.Fatalf("plugin %q must not be registered on windows", excluded)
		}
	}
}
