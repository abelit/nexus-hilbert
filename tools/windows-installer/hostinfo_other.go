//go:build !windows

package main

import "errors"

// CollectHostInfo is only meaningful on Windows. Tests on other platforms pass
// a fixed HostInfo to Enroll or exercise buildHostInfo directly.
func CollectHostInfo() (HostInfo, error) {
	return HostInfo{}, errors.New("host info collection is only available on Windows")
}
