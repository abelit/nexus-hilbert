package main

import (
	"fmt"
	"strings"
)

// HostInfo mirrors the host description accepted by
// internal/pkg/tunnel.HostInfo and the Manager enrollment endpoint. The
// installer keeps a local copy because this module must not import the main
// module; the JSON field names and omitempty behavior must stay in sync.
type HostInfo struct {
	Hostname            string `json:"hostname"`
	OS                  string `json:"os"`
	Arch                string `json:"arch"`
	KernelVersion       string `json:"kernel_version"`
	CPUCount            int    `json:"cpu_count"`
	MemTotalBytes       uint64 `json:"mem_total_bytes"`
	Fingerprint         string `json:"fingerprint,omitempty"`
	HardwareFingerprint string `json:"hardware_fingerprint,omitempty"`
	IPAddress           string `json:"ip_address,omitempty"`
}

// hostInfoProbes are the platform inputs used to assemble a HostInfo. They are
// functions and plain values so the Windows assembly can be exercised on any
// host in tests without touching the registry.
type hostInfoProbes struct {
	Hostname      func() (string, error)
	MachineID     func() (string, error)
	GOARCH        string
	NumCPU        int
	KernelVersion string
}

// buildHostInfo assembles the Windows host description. Fingerprint and
// HardwareFingerprint share one stable value because the Manager rejects an
// enrollment without a fingerprint and Windows has no separate hardware
// identity probe here.
func buildHostInfo(probes hostInfoProbes) (HostInfo, error) {
	hostname, err := probes.Hostname()
	if err != nil {
		return HostInfo{}, fmt.Errorf("read hostname: %w", err)
	}
	hostname = strings.TrimSpace(hostname)
	if hostname == "" {
		return HostInfo{}, fmt.Errorf("hostname is empty")
	}

	fingerprint := ""
	if probes.MachineID != nil {
		if machineID, err := probes.MachineID(); err == nil {
			fingerprint = strings.TrimSpace(machineID)
		}
	}
	if fingerprint == "" {
		fingerprint = hostname
	}

	return HostInfo{
		Hostname:            hostname,
		OS:                  "windows",
		Arch:                probes.GOARCH,
		KernelVersion:       strings.TrimSpace(probes.KernelVersion),
		CPUCount:            probes.NumCPU,
		MemTotalBytes:       0, // Memory size is optional; 0 is accepted by the Manager.
		Fingerprint:         fingerprint,
		HardwareFingerprint: fingerprint,
	}, nil
}
