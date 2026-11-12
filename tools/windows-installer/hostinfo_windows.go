//go:build windows

package main

import (
	"fmt"
	"os"
	"runtime"
	"syscall"
	"unsafe"
)

// machineGUIDRegistryPath is where Windows stores the per-install machine
// identifier used as this host's stable fingerprint.
const machineGUIDRegistryPath = `SOFTWARE\Microsoft\Cryptography`

// CollectHostInfo reports the Windows host identity used during enrollment.
//
// The Manager requires a non-empty hostname and fingerprint. Fingerprint and
// HardwareFingerprint both use the registry MachineGuid, falling back to the
// hostname when the registry value is unavailable.
func CollectHostInfo() (HostInfo, error) {
	kernelVersion := ""
	if version, err := WindowsVersion(); err == nil {
		kernelVersion = fmt.Sprintf("%d.%d.%d", version.Major, version.Minor, version.Build)
	}
	return buildHostInfo(hostInfoProbes{
		Hostname:      os.Hostname,
		MachineID:     machineGUID,
		GOARCH:        runtime.GOARCH,
		NumCPU:        runtime.NumCPU(),
		KernelVersion: kernelVersion,
	})
}

// machineGUID reads HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid.
func machineGUID() (string, error) {
	path, err := syscall.UTF16PtrFromString(machineGUIDRegistryPath)
	if err != nil {
		return "", err
	}
	var key syscall.Handle
	if err := syscall.RegOpenKeyEx(syscall.HKEY_LOCAL_MACHINE, path, 0, syscall.KEY_READ, &key); err != nil {
		return "", err
	}
	defer syscall.RegCloseKey(key)

	name, err := syscall.UTF16PtrFromString("MachineGuid")
	if err != nil {
		return "", err
	}
	var (
		valueType uint32
		buffer    [256]uint16
		bufferLen = uint32(len(buffer) * 2)
	)
	if err := syscall.RegQueryValueEx(
		key,
		name,
		nil,
		&valueType,
		(*byte)(unsafe.Pointer(&buffer[0])),
		&bufferLen,
	); err != nil {
		return "", err
	}
	if valueType != syscall.REG_SZ {
		return "", fmt.Errorf("MachineGuid has unexpected registry type %d", valueType)
	}
	return syscall.UTF16ToString(buffer[:]), nil
}
