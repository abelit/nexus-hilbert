package edge

import (
	"testing"

	devicemodel "github.com/ongridio/ongrid/internal/manager/model/device"
)

func TestBundleArchForDevice(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		os      string
		arch    string
		kernel  string
		osVer   string
		want    string
		wantErr bool
	}{
		{"linux amd64", "linux", "amd64", "", "", "linux-amd64", false},
		{"empty os defaults to linux", "", "x86_64", "", "", "linux-amd64", false},
		{"linux arm64", "linux", "aarch64", "", "", "linux-arm64", false},
		{"windows 2016", "windows", "amd64", "10.0.14393.1884 Build 14393.1884", "", "windows-amd64", false},
		{"windows 2019", "windows", "amd64", "10.0.17763.1", "", "windows-amd64", false},
		{"windows 2008 r2", "windows", "amd64", "6.1.7601.17514", "", "legacy-windows-amd64", false},
		{"windows build from os_version", "windows", "amd64", "", "10.0.14393.0", "windows-amd64", false},
		{"windows unsupported build", "windows", "amd64", "6.1.7600.1", "", "", true},
		{"windows unknown version", "windows", "amd64", "", "", "", true},
		{"windows arm64 unsupported", "windows", "arm64", "10.0.17763.1", "", "", true},
		{"darwin unsupported", "darwin", "amd64", "", "", "", true},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			device := &devicemodel.Device{
				OS: tc.os, Arch: tc.arch, KernelVersion: tc.kernel, OSVersion: tc.osVer,
			}
			got, err := bundleArchForDevice(device)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("bundleArchForDevice() = %q, want error", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("bundleArchForDevice() error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("bundleArchForDevice() = %q, want %q", got, tc.want)
			}
		})
	}
}
