//go:build windows

package main

// InstallService invokes the supervisor placed under BinDir. The supervisor
// owns DPAPI, sc.exe create, recovery actions, and start; the installer only
// supplies the restricted config file.
func InstallService(supervisorPath, configPath string) error {
	return installService(execRunner{}, supervisorPath, configPath)
}

// UninstallService invokes the installed supervisor with --uninstall. A
// service that was never installed is treated as success.
func UninstallService() error {
	return uninstallService(execRunner{}, defaultDeployPaths().supervisorPath())
}
