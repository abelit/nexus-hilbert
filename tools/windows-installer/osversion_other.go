//go:build !windows

package main

import "errors"

// WindowsVersion is only meaningful on Windows. Tests on other platforms pass
// an OSVersion to Manifest.SelectVariant directly.
func WindowsVersion() (OSVersion, error) {
	return OSVersion{}, errors.New("windows version detection is only available on Windows")
}
