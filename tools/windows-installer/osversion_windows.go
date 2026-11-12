//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

// osVersionInfoExW mirrors RTL_OSVERSIONINFOEXW from ntdll. Only the fields
// needed for variant selection are interpreted; the full structure is passed
// because RtlGetVersion validates OSVersionInfoSize.
type osVersionInfoExW struct {
	OSVersionInfoSize uint32
	MajorVersion      uint32
	MinorVersion      uint32
	BuildNumber       uint32
	PlatformID        uint32
	CSDVersion        [128]uint16
	ServicePackMajor  uint16
	ServicePackMinor  uint16
	SuiteMask         uint16
	ProductType       byte
	Reserved          byte
}

var (
	ntdllProcRtlGetVersion = syscall.NewLazyDLL("ntdll.dll").NewProc("RtlGetVersion")
)

// WindowsVersion reports the real Windows NT version.
//
// GetVersionEx reports a compatibility-shimmed version unless the executable
// embeds an application manifest, and the manifest would not cover every
// binary built from this module. RtlGetVersion reads the kernel version
// directly and is not affected by that shim.
func WindowsVersion() (OSVersion, error) {
	info := osVersionInfoExW{
		OSVersionInfoSize: uint32(unsafe.Sizeof(osVersionInfoExW{})),
	}
	status, _, callErr := ntdllProcRtlGetVersion.Call(uintptr(unsafe.Pointer(&info)))
	if status != 0 {
		return OSVersion{}, fmt.Errorf("RtlGetVersion failed: NTSTATUS 0x%08x: %w", uint32(status), callErr)
	}
	return OSVersion{
		Major: info.MajorVersion,
		Minor: info.MinorVersion,
		Build: info.BuildNumber,
	}, nil
}
