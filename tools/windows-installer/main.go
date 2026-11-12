// Command ongrid-edge-installer installs the Ongrid Edge agent on Windows.
//
// It lives in its own Go 1.20 module because the installer must run on
// Windows Server 2008 R2 SP1 and therefore cannot import the main module,
// which is built with a newer Go release.
//
// The installer downloads and verifies the artifacts, optionally enrolls the
// device, hardens the destination ACLs, places the supervisor/worker/plugins,
// and hands a restricted config file to supervisor.exe --install. Uninstall
// delegates to supervisor.exe --uninstall and removes the DPAPI secret.
package main

import (
	"context"
	"fmt"
	"io"
	"os"
)

// version is the installer version reported to the Manager during enrollment.
// Release builds may override it with -ldflags "-X main.version=vX.Y.Z".
var version = "dev"

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	opts, err := ParseArgs(args)
	if err != nil {
		fmt.Fprintf(stderr, "ongrid-edge-installer: %v\n", err)
		return 2
	}

	if opts.DryRun {
		fmt.Fprintln(stdout, "dry run: configuration is valid; no changes were made")
		return 0
	}
	if opts.Uninstall {
		if err := Uninstall(defaultUninstallDeps(), opts.Purge); err != nil {
			fmt.Fprintf(stderr, "ongrid-edge-installer: %v\n", err)
			return 1
		}
		fmt.Fprintln(stdout, "ongrid-edge-installer: uninstall completed")
		return 0
	}
	deps, err := defaultInstallDeps(opts)
	if err != nil {
		fmt.Fprintf(stderr, "ongrid-edge-installer: %v\n", err)
		return 1
	}
	if err := Install(context.Background(), opts, deps); err != nil {
		fmt.Fprintf(stderr, "ongrid-edge-installer: %v\n", err)
		return 1
	}
	fmt.Fprintln(stdout, "ongrid-edge-installer: installation completed")
	return 0
}
