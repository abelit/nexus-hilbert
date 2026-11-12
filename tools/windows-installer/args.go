package main

import (
	"flag"
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"
)

// Options is the validated installer command line.
type Options struct {
	ManagerURL      string
	EnrollmentToken string
	AccessKey       string
	SecretKey       string
	ServerEdgeAddr  string
	TLSCAFile       string
	TLSServerName   string
	TLSInsecure     bool
	Variant         string
	Uninstall       bool
	Purge           bool
	DryRun          bool
	LogFile         string
}

// ParseArgs parses and validates the installer command line. Unknown flags,
// positional arguments, conflicting credentials, and unsafe URLs are errors.
func ParseArgs(args []string) (Options, error) {
	fs := flag.NewFlagSet("ongrid-edge-installer", flag.ContinueOnError)
	fs.SetOutput(io.Discard)

	var opts Options
	fs.StringVar(&opts.ManagerURL, "manager-url", "", "Manager HTTPS root URL")
	fs.StringVar(&opts.EnrollmentToken, "enrollment-token", "", "batch enrollment token")
	fs.StringVar(&opts.AccessKey, "access-key", "", "single-device access key")
	fs.StringVar(&opts.SecretKey, "secret-key", "", "single-device secret key")
	fs.StringVar(&opts.ServerEdgeAddr, "server-edge-addr", "", "Frontier server edge address (host:port)")
	fs.StringVar(&opts.TLSCAFile, "tls-ca-file", "", "PEM CA bundle used to verify the Manager")
	fs.StringVar(&opts.TLSServerName, "tls-server-name", "", "override the TLS server name")
	fs.BoolVar(&opts.TLSInsecure, "tls-insecure", false, "skip TLS certificate verification (self-signed testing only)")
	fs.StringVar(&opts.Variant, "variant", "auto", "artifact variant: auto, modern, or legacy")
	fs.BoolVar(&opts.Uninstall, "uninstall", false, "uninstall the service")
	fs.BoolVar(&opts.Purge, "purge", false, "remove installed binaries, plugins, and data on uninstall")
	fs.BoolVar(&opts.DryRun, "dry-run", false, "validate the configuration without changing the host")
	fs.StringVar(&opts.LogFile, "log-file", "", "installer log file")

	if err := fs.Parse(args); err != nil {
		return Options{}, fmt.Errorf("parse arguments: %w", err)
	}
	if fs.NArg() > 0 {
		return Options{}, fmt.Errorf("unexpected positional arguments: %s", strings.Join(fs.Args(), " "))
	}

	opts.ManagerURL = strings.TrimSpace(opts.ManagerURL)
	opts.ServerEdgeAddr = strings.TrimSpace(opts.ServerEdgeAddr)

	if err := opts.validateCredentials(); err != nil {
		return Options{}, err
	}
	if !opts.Uninstall {
		if opts.ManagerURL == "" {
			return Options{}, fmt.Errorf("--manager-url is required for installation")
		}
		if opts.ServerEdgeAddr == "" {
			return Options{}, fmt.Errorf("--server-edge-addr is required for installation")
		}
	}
	if opts.ManagerURL != "" {
		if err := validateManagerURL(opts.ManagerURL); err != nil {
			return Options{}, err
		}
	}
	if opts.ServerEdgeAddr != "" {
		if err := validateServerEdgeAddr(opts.ServerEdgeAddr); err != nil {
			return Options{}, err
		}
	}
	return opts, nil
}

func (o Options) validateCredentials() error {
	hasEnrollment := o.EnrollmentToken != ""
	hasAccess := o.AccessKey != ""
	hasSecret := o.SecretKey != ""

	if hasEnrollment && (hasAccess || hasSecret) {
		return fmt.Errorf("--enrollment-token cannot be combined with --access-key or --secret-key")
	}
	if hasAccess != hasSecret {
		return fmt.Errorf("--access-key and --secret-key must be provided together")
	}
	if !hasEnrollment && !hasAccess && !o.Uninstall {
		return fmt.Errorf("installation requires --enrollment-token or --access-key/--secret-key")
	}
	return nil
}

func validateManagerURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("--manager-url %q: %w", raw, err)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return fmt.Errorf("--manager-url %q: scheme must be https (http is only allowed for loopback)", raw)
	}
	if u.Host == "" {
		return fmt.Errorf("--manager-url %q: missing host", raw)
	}
	if scheme == "http" && !isLoopbackHost(u.Hostname()) {
		return fmt.Errorf("--manager-url %q: http is only allowed for loopback hosts", raw)
	}
	return nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func validateServerEdgeAddr(raw string) error {
	host, port, err := net.SplitHostPort(raw)
	if err != nil {
		return fmt.Errorf("--server-edge-addr %q: %w", raw, err)
	}
	if host == "" {
		return fmt.Errorf("--server-edge-addr %q: missing host", raw)
	}
	if port == "" {
		return fmt.Errorf("--server-edge-addr %q: missing port", raw)
	}
	return nil
}
