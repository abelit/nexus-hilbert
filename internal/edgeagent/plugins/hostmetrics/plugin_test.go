package hostmetrics

import (
	"strings"
	"testing"

	"github.com/ongridio/ongrid/internal/edgeagent/plugins"
)

const testTextfileDir = `C:\ProgramData\ongrid-edge\plugins\hostmetrics\textfile`

func TestBuildArgsWindowsOmitsNodeExporterFlags(t *testing.T) {
	cfg := plugins.PluginConfig{Spec: map[string]interface{}{
		"listen_address":      "127.0.0.1:19102",
		"collectors_enabled":  []interface{}{"cpu", "memory"},
		"collectors_disabled": []interface{}{"net"},
	}}
	args := buildArgsFor("windows", cfg, testTextfileDir)

	if !containsArg(args, "--web.listen-address=127.0.0.1:19102") {
		t.Fatalf("argv = %v, want --web.listen-address", args)
	}
	if !containsArg(args, "--collectors.enabled=cpu,memory") {
		t.Fatalf("argv = %v, want --collectors.enabled=cpu,memory", args)
	}
	if !containsArg(args, "--collectors.disabled=net") {
		t.Fatalf("argv = %v, want --collectors.disabled=net", args)
	}
	for _, arg := range args {
		if strings.HasPrefix(arg, "--collector.") || strings.HasPrefix(arg, "--no-collector.") {
			t.Fatalf("argv = %v, contains node_exporter-only flag %q", args, arg)
		}
	}
}

func TestBuildArgsWindowsTextfileOnlyWhenEnabled(t *testing.T) {
	cfg := plugins.PluginConfig{Spec: map[string]interface{}{
		"collectors_enabled": []interface{}{"cpu", "textfile"},
	}}
	args := buildArgsFor("windows", cfg, testTextfileDir)
	if !containsArg(args, "--collector.textfile.directories="+testTextfileDir) {
		t.Fatalf("argv = %v, want plural textfile directories flag", args)
	}
	for _, arg := range args {
		if strings.HasPrefix(arg, "--collector.textfile.directory=") {
			t.Fatalf("argv = %v, contains singular textfile flag %q", args, arg)
		}
	}

	defaults := buildArgsFor("windows", plugins.PluginConfig{}, testTextfileDir)
	for _, arg := range defaults {
		if strings.Contains(arg, "textfile") {
			t.Fatalf("default argv = %v, must not enable the textfile collector", defaults)
		}
	}
}

func TestBuildArgsLinuxUnchanged(t *testing.T) {
	cfg := plugins.PluginConfig{Spec: map[string]interface{}{
		"listen_address":      ":19102",
		"collectors_enabled":  []interface{}{"cpu", "textfile"},
		"collectors_disabled": []interface{}{"net"},
		"extra_args":          []interface{}{"--collector.extra"},
	}}
	want := []string{
		"--web.listen-address=:19102",
		"--collector.cpu",
		"--collector.textfile",
		"--no-collector.net",
		"--collector.extra",
		"--collector.textfile.directory=/var/lib/ongrid-edge/plugins/hostmetrics/textfile",
	}
	got := buildArgsFor("linux", cfg, "/var/lib/ongrid-edge/plugins/hostmetrics/textfile")
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv = %v, want %v", got, want)
	}
}

func containsArg(args []string, want string) bool {
	for _, arg := range args {
		if arg == want {
			return true
		}
	}
	return false
}
