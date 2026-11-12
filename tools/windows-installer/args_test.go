package main

import "testing"

func TestParseArgsValid(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want Options
	}{
		{
			name: "enrollment token install",
			args: []string{
				"--manager-url", "https://manager.example.com",
				"--enrollment-token", "enroll-token",
				"--server-edge-addr", "edge.example.com:40012",
			},
			want: Options{
				ManagerURL:      "https://manager.example.com",
				EnrollmentToken: "enroll-token",
				ServerEdgeAddr:  "edge.example.com:40012",
				Variant:         "auto",
			},
		},
		{
			name: "access and secret install",
			args: []string{
				"--manager-url", "https://manager.example.com/ongrid",
				"--access-key", "access",
				"--secret-key", "secret",
				"--server-edge-addr", "edge.example.com:40012",
			},
			want: Options{
				ManagerURL:     "https://manager.example.com/ongrid",
				AccessKey:      "access",
				SecretKey:      "secret",
				ServerEdgeAddr: "edge.example.com:40012",
				Variant:        "auto",
			},
		},
		{
			name: "uninstall needs no credentials",
			args: []string{"--uninstall"},
			want: Options{
				Uninstall: true,
				Variant:   "auto",
			},
		},
		{
			name: "dry run with tls and logging options",
			args: []string{
				"--manager-url", "https://manager.example.com",
				"--enrollment-token", "enroll-token",
				"--server-edge-addr", "edge.example.com:40012",
				"--tls-ca-file", `C:\ProgramData\ongrid-edge\ca.pem`,
				"--tls-server-name", "manager.internal",
				"--tls-insecure",
				"--variant", "legacy",
				"--dry-run",
				"--log-file", `C:\ProgramData\ongrid-edge\install.log`,
			},
			want: Options{
				ManagerURL:      "https://manager.example.com",
				EnrollmentToken: "enroll-token",
				ServerEdgeAddr:  "edge.example.com:40012",
				TLSCAFile:       `C:\ProgramData\ongrid-edge\ca.pem`,
				TLSServerName:   "manager.internal",
				TLSInsecure:     true,
				Variant:         "legacy",
				DryRun:          true,
				LogFile:         `C:\ProgramData\ongrid-edge\install.log`,
			},
		},
		{
			name: "loopback ipv4 http for local development",
			args: []string{
				"--manager-url", "http://127.0.0.1:8080",
				"--enrollment-token", "enroll-token",
				"--server-edge-addr", "127.0.0.1:40012",
			},
			want: Options{
				ManagerURL:      "http://127.0.0.1:8080",
				EnrollmentToken: "enroll-token",
				ServerEdgeAddr:  "127.0.0.1:40012",
				Variant:         "auto",
			},
		},
		{
			name: "loopback localhost http for local development",
			args: []string{
				"--manager-url", "http://localhost:8080",
				"--access-key", "access",
				"--secret-key", "secret",
				"--server-edge-addr", "localhost:40012",
			},
			want: Options{
				ManagerURL:     "http://localhost:8080",
				AccessKey:      "access",
				SecretKey:      "secret",
				ServerEdgeAddr: "localhost:40012",
				Variant:        "auto",
			},
		},
		{
			name: "loopback ipv6 http for local development",
			args: []string{
				"--manager-url", "http://[::1]:8080",
				"--enrollment-token", "enroll-token",
				"--server-edge-addr", "[::1]:40012",
			},
			want: Options{
				ManagerURL:      "http://[::1]:8080",
				EnrollmentToken: "enroll-token",
				ServerEdgeAddr:  "[::1]:40012",
				Variant:         "auto",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseArgs(tt.args)
			if err != nil {
				t.Fatalf("ParseArgs() error = %v", err)
			}
			if got != tt.want {
				t.Fatalf("ParseArgs() = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestParseArgsRejectsInvalidArgs(t *testing.T) {
	validInstall := []string{
		"--manager-url", "https://manager.example.com",
		"--enrollment-token", "enroll-token",
		"--server-edge-addr", "edge.example.com:40012",
	}
	withArgs := func(extra ...string) []string {
		args := make([]string, 0, len(validInstall)+len(extra))
		args = append(args, validInstall...)
		return append(args, extra...)
	}

	tests := []struct {
		name string
		args []string
	}{
		{
			name: "unknown flag",
			args: []string{"--nope"},
		},
		{
			name: "leftover positional argument",
			args: []string{"--uninstall", "extra"},
		},
		{
			name: "enrollment token with access key",
			args: withArgs("--access-key", "access", "--secret-key", "secret"),
		},
		{
			name: "enrollment token with secret key only",
			args: withArgs("--secret-key", "secret"),
		},
		{
			name: "access key without secret",
			args: []string{
				"--manager-url", "https://manager.example.com",
				"--access-key", "access",
				"--server-edge-addr", "edge.example.com:40012",
			},
		},
		{
			name: "secret key without access",
			args: []string{
				"--manager-url", "https://manager.example.com",
				"--secret-key", "secret",
				"--server-edge-addr", "edge.example.com:40012",
			},
		},
		{
			name: "no credentials and no uninstall",
			args: []string{
				"--manager-url", "https://manager.example.com",
				"--server-edge-addr", "edge.example.com:40012",
			},
		},
		{
			name: "install missing manager url",
			args: []string{
				"--enrollment-token", "enroll-token",
				"--server-edge-addr", "edge.example.com:40012",
			},
		},
		{
			name: "install missing server edge addr",
			args: []string{
				"--manager-url", "https://manager.example.com",
				"--enrollment-token", "enroll-token",
			},
		},
		{
			name: "plain http to remote host",
			args: []string{
				"--manager-url", "http://manager.example.com",
				"--enrollment-token", "enroll-token",
				"--server-edge-addr", "edge.example.com:40012",
			},
		},
		{
			name: "plain http to non-loopback ip",
			args: []string{
				"--manager-url", "http://10.0.0.5:8080",
				"--enrollment-token", "enroll-token",
				"--server-edge-addr", "edge.example.com:40012",
			},
		},
		{
			name: "unsupported manager url scheme",
			args: []string{
				"--manager-url", "ftp://manager.example.com",
				"--enrollment-token", "enroll-token",
				"--server-edge-addr", "edge.example.com:40012",
			},
		},
		{
			name: "manager url without scheme",
			args: []string{
				"--manager-url", "manager.example.com",
				"--enrollment-token", "enroll-token",
				"--server-edge-addr", "edge.example.com:40012",
			},
		},
		{
			name: "manager url without host",
			args: []string{
				"--manager-url", "https://",
				"--enrollment-token", "enroll-token",
				"--server-edge-addr", "edge.example.com:40012",
			},
		},
		{
			name: "server edge addr without port",
			args: []string{
				"--manager-url", "https://manager.example.com",
				"--enrollment-token", "enroll-token",
				"--server-edge-addr", "edge.example.com",
			},
		},
		{
			name: "uninstall with invalid manager url",
			args: []string{"--uninstall", "--manager-url", "http://manager.example.com"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := ParseArgs(tt.args); err == nil {
				t.Fatal("ParseArgs() succeeded, want error")
			}
		})
	}
}

func TestParseArgsUninstallPurge(t *testing.T) {
	opts, err := ParseArgs([]string{"--uninstall", "--purge"})
	if err != nil {
		t.Fatalf("ParseArgs() error: %v", err)
	}
	if !opts.Uninstall || !opts.Purge {
		t.Fatalf("opts = %+v, want Uninstall and Purge set", opts)
	}
}
