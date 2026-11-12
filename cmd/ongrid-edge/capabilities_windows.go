//go:build windows

package main

import (
	"log/slog"

	edgehostfiles "github.com/ongridio/ongrid/internal/edgeagent/host_files"
	edgerestartservice "github.com/ongridio/ongrid/internal/edgeagent/restart_service"
	"github.com/ongridio/ongrid/internal/pkg/tunnel"
)

// registerEdgeCapabilities registers the platform-specific edge capability
// handlers with the tunnel client. Windows: host_files and restart_service.
// restart_service drives the Windows SCM through an absolute
// %SystemRoot%\System32\sc.exe (see the package for the allow-list policy).
//
// bash and the interactive operator/WebSSH stack remain Linux-only and are
// gated in main.go; they need the Linux cmdpolicy/systemctl toolset (or a
// validated PowerShell equivalent).
//
// All Register calls are soft-fail: the edge keeps booting and the
// operator sees a warning in the log when a capability is disabled.
func registerEdgeCapabilities(client tunnel.Client, log *slog.Logger) {
	if err := edgehostfiles.Register(client, log); err != nil {
		log.Warn("host_files register failed; capability disabled", slog.Any("err", err))
	}
	if err := edgerestartservice.Register(client, log); err != nil {
		log.Warn("restart_service register failed; capability disabled", slog.Any("err", err))
	}
}
