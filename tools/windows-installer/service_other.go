//go:build !windows

package main

import "fmt"

// InstallService is only meaningful on Windows.
func InstallService(supervisorPath, configPath string) error {
	return fmt.Errorf("install service: %w", ErrUnsupportedPlatform)
}

// UninstallService is only meaningful on Windows.
func UninstallService() error {
	return fmt.Errorf("uninstall service: %w", ErrUnsupportedPlatform)
}
