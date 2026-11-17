package main

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/ongridio/ongrid/internal/edgeagent/edgedirs"
)

// pluginBinDir resolves the exporter directory used by the upgrade machine's
// bundle validation. The install-time service environment wins; otherwise
// derive <install root>\plugins from BinDir so dev/external launches still
// accept plugin entries in a Windows bundle.
func pluginBinDir() string {
	if v := strings.TrimSpace(os.Getenv("ONGRID_EDGE_PLUGIN_BIN_DIR")); v != "" {
		return v
	}
	return filepath.Join(filepath.Dir(edgedirs.BinDir), "plugins")
}
