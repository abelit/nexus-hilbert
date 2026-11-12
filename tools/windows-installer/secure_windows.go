//go:build windows

package main

// SecureDir removes inherited ACLs from path and grants full control only to
// SYSTEM and the Administrators group. It must be called on every install
// root and on the download staging directory before any artifact is written.
func SecureDir(path string) error {
	return runSecureDir(execRunner{}, path)
}
