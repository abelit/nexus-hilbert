//go:build !windows

package main

import "fmt"

// SecureDir is only meaningful on Windows, where icacls manages directory
// ACLs. Keeping the symbol available on other platforms lets the orchestration
// and its tests compile without platform-specific branching.
func SecureDir(path string) error {
	return fmt.Errorf("secure dir %s: %w", path, ErrUnsupportedPlatform)
}
