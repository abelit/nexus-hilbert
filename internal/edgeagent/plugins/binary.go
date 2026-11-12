package plugins

import (
	"path/filepath"
	"runtime"
	"strings"
)

// binaryName returns the executable file name for a plugin binary on goos.
// plugin is the logical name used by the Linux bundle (for example
// "node_exporter", "otelcol-contrib") and goos is a runtime.GOOS value. This
// is the single place that encodes platform naming differences; callers must
// use BinaryPath instead of branching on runtime.GOOS themselves.
func binaryName(plugin, goos string) string {
	if goos != "windows" {
		return plugin
	}
	name := plugin
	if name == "node_exporter" {
		// There is no node_exporter build for Windows; the bundled host
		// metrics exporter is windows_exporter.
		name = "windows_exporter"
	}
	if !strings.HasSuffix(strings.ToLower(name), ".exe") {
		name += ".exe"
	}
	return name
}

// BinaryPath joins binDir with the platform-specific executable name for
// plugin, using the running platform.
func BinaryPath(binDir, plugin string) string {
	return filepath.Join(binDir, binaryName(plugin, runtime.GOOS))
}
