// Command ongrid-edge-installer installs the Ongrid Edge agent on Windows.
//
// It lives in its own Go 1.20 module because the installer must run on
// Windows Server 2008 R2 SP1 and therefore cannot import the main module,
// which is built with a newer Go release.
//
// The install, download, enrollment, and service-control flows are added in
// later tasks; this skeleton wires up argument validation and the manifest
// model.
package main

import (
	"fmt"
	"io"
	"os"
)

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
		fmt.Fprintln(stderr, "ongrid-edge-installer: uninstall flow is not implemented yet")
		return 1
	}
	fmt.Fprintln(stderr, "ongrid-edge-installer: install flow is not implemented yet")
	return 1
}
