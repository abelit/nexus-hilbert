package plugins

import (
	"path/filepath"
	"runtime"
	"testing"
)

func TestBinaryName(t *testing.T) {
	tests := []struct {
		name   string
		plugin string
		goos   string
		want   string
	}{
		{name: "hostmetrics on linux", plugin: "node_exporter", goos: "linux", want: "node_exporter"},
		{name: "hostmetrics on darwin", plugin: "node_exporter", goos: "darwin", want: "node_exporter"},
		{name: "hostmetrics on windows", plugin: "node_exporter", goos: "windows", want: "windows_exporter.exe"},
		{name: "otelcol on linux", plugin: "otelcol-contrib", goos: "linux", want: "otelcol-contrib"},
		{name: "otelcol on windows", plugin: "otelcol-contrib", goos: "windows", want: "otelcol-contrib.exe"},
		{name: "process exporter on windows", plugin: "process_exporter", goos: "windows", want: "process_exporter.exe"},
		{name: "mysql exporter on windows", plugin: "mysqld_exporter", goos: "windows", want: "mysqld_exporter.exe"},
		{name: "postgres exporter on windows", plugin: "postgres_exporter", goos: "windows", want: "postgres_exporter.exe"},
		{name: "redis exporter on windows", plugin: "redis_exporter", goos: "windows", want: "redis_exporter.exe"},
		{name: "mongodb exporter on windows", plugin: "mongodb_exporter", goos: "windows", want: "mongodb_exporter.exe"},
		{name: "already exe on windows", plugin: "custom.exe", goos: "windows", want: "custom.exe"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := binaryName(tt.plugin, tt.goos); got != tt.want {
				t.Fatalf("binaryName(%q, %q) = %q, want %q", tt.plugin, tt.goos, got, tt.want)
			}
		})
	}
}

func TestBinaryPath(t *testing.T) {
	got := BinaryPath("/opt/ongrid-edge/bin", "otelcol-contrib")
	want := filepath.Join("/opt/ongrid-edge/bin", binaryName("otelcol-contrib", runtime.GOOS))
	if got != want {
		t.Fatalf("BinaryPath() = %q, want %q", got, want)
	}
}
