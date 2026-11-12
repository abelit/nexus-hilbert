// Command legacy-spike is the Phase 0 go/no-go probe for the Windows Edge
// installation plan.
//
// It intentionally lives in its own Go 1.20 module and never imports the main
// Ongrid module. On the target host it reports:
//
//  1. the Go runtime version the binary was built with, because Go 1.21+
//     binaries no longer run on Windows Server 2008 R2;
//  2. whether net/http can reach the Manager /healthz endpoint, including the
//     negotiated TLS version and cipher suite;
//  3. whether the geminio client can complete a dial and handshake against
//     Frontier.
//
// Reachability failures are recorded rather than treated as fatal: the point
// of the spike is to observe what works on legacy Windows, not to assert that
// the test host has a live Manager and Frontier.
package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/singchia/geminio/client"
)

const defaultTimeout = 10 * time.Second

type config struct {
	managerURL   string
	frontierAddr string
	timeout      time.Duration
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	cfg, err := parseConfig(args, stderr)
	if err != nil {
		fmt.Fprintf(stderr, "legacy-spike: %v\n", err)
		return 2
	}

	fmt.Fprintf(stdout, "runtime: %s (%s/%s)\n", runtime.Version(), runtime.GOOS, runtime.GOARCH)

	if cfg.managerURL == "" {
		fmt.Fprintln(stdout, "manager: SKIP (set -manager or ONGRID_MANAGER_URL)")
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), cfg.timeout)
		httpClient := &http.Client{Timeout: cfg.timeout}
		res, err := checkManager(ctx, httpClient, cfg.managerURL)
		cancel()
		if err != nil {
			if res.tlsVersion != 0 {
				// The TLS handshake succeeded but the endpoint answered with a
				// non-2xx status. Keep the TLS evidence in the output.
				fmt.Fprintf(
					stdout,
					"manager: FAIL %s: %v (status=%d tls=%s cipher=%s)\n",
					cfg.managerURL,
					err,
					res.statusCode,
					tlsVersionName(res.tlsVersion),
					tls.CipherSuiteName(res.cipherSuite),
				)
			} else {
				fmt.Fprintf(stdout, "manager: FAIL %s: %v\n", cfg.managerURL, err)
			}
		} else {
			fmt.Fprintf(
				stdout,
				"manager: OK %s status=%d tls=%s cipher=%s\n",
				cfg.managerURL,
				res.statusCode,
				tlsVersionName(res.tlsVersion),
				tls.CipherSuiteName(res.cipherSuite),
			)
		}
	}

	if cfg.frontierAddr == "" {
		fmt.Fprintln(stdout, "frontier: SKIP (set -frontier or ONGRID_EDGE_FRONTIER_ADDR)")
	} else {
		start := time.Now()
		err := dialFrontier(cfg.frontierAddr, cfg.timeout)
		elapsed := time.Since(start).Round(time.Millisecond)
		if err != nil {
			fmt.Fprintf(stdout, "frontier: DIAL-ERROR %s after %s: %v\n", cfg.frontierAddr, elapsed, err)
		} else {
			fmt.Fprintf(stdout, "frontier: OK %s geminio handshake completed in %s\n", cfg.frontierAddr, elapsed)
		}
	}

	fmt.Fprintln(stdout, "legacy-spike: finished; copy these lines into the plan Decision Log")
	return 0
}

func parseConfig(args []string, output io.Writer) (config, error) {
	fs := flag.NewFlagSet("legacy-spike", flag.ContinueOnError)
	fs.SetOutput(output)
	manager := fs.String("manager", os.Getenv("ONGRID_MANAGER_URL"), "Manager base URL or full /healthz URL (env ONGRID_MANAGER_URL)")
	frontier := fs.String("frontier", os.Getenv("ONGRID_EDGE_FRONTIER_ADDR"), "Frontier edgebound host:port, e.g. host:40012 (env ONGRID_EDGE_FRONTIER_ADDR; not the manager servicebound 40011)")
	timeout := fs.Duration("timeout", defaultTimeout, "timeout for each probe")

	if err := fs.Parse(args); err != nil {
		return config{}, err
	}
	if *timeout <= 0 {
		return config{}, fmt.Errorf("-timeout must be positive, got %s", *timeout)
	}

	cfg := config{
		managerURL:   strings.TrimSpace(*manager),
		frontierAddr: strings.TrimSpace(*frontier),
		timeout:      *timeout,
	}
	if cfg.managerURL != "" {
		health, err := healthURL(cfg.managerURL)
		if err != nil {
			return config{}, err
		}
		cfg.managerURL = health
	}
	if cfg.frontierAddr != "" {
		if _, _, err := net.SplitHostPort(cfg.frontierAddr); err != nil {
			return config{}, fmt.Errorf("-frontier %q: %w", cfg.frontierAddr, err)
		}
	}
	return cfg, nil
}

// healthURL accepts either a Manager base URL or a URL that already ends in
// /healthz and always returns the /healthz endpoint.
func healthURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("-manager %q: %w", raw, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("-manager %q: scheme must be http or https", raw)
	}
	if u.Host == "" {
		return "", fmt.Errorf("-manager %q: missing host", raw)
	}
	path := strings.TrimSuffix(u.Path, "/")
	if !strings.HasSuffix(path, "/healthz") {
		path += "/healthz"
	}
	u.Path = path
	return u.String(), nil
}

type healthResult struct {
	statusCode  int
	tlsVersion  uint16
	cipherSuite uint16
}

func checkManager(ctx context.Context, httpClient *http.Client, target string) (healthResult, error) {
	var res healthResult

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return res, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return res, err
	}
	defer resp.Body.Close()

	// Drain a bounded amount so the probe behaves well behind proxies that
	// send a short error body.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))

	res.statusCode = resp.StatusCode
	if resp.TLS != nil {
		res.tlsVersion = resp.TLS.Version
		res.cipherSuite = resp.TLS.CipherSuite
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return res, fmt.Errorf("unexpected status %s", resp.Status)
	}
	return res, nil
}

func tlsVersionName(version uint16) string {
	switch version {
	case 0:
		return "none"
	case tls.VersionTLS10:
		return "TLS 1.0"
	case tls.VersionTLS11:
		return "TLS 1.1"
	case tls.VersionTLS12:
		return "TLS 1.2"
	case tls.VersionTLS13:
		return "TLS 1.3"
	default:
		return fmt.Sprintf("0x%04x", version)
	}
}

// dialFrontier completes a geminio client handshake against Frontier. A
// dial or handshake error is returned so the caller can print it; the plan
// only requires that the connection attempt is made and diagnosed.
func dialFrontier(addr string, timeout time.Duration) error {
	dialer := func() (net.Conn, error) {
		conn, err := net.DialTimeout("tcp", addr, timeout)
		if err != nil {
			return nil, err
		}
		// Bound the geminio handshake as well as the TCP connect; a peer that
		// accepts the socket but never speaks the protocol must not hang the
		// probe.
		if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
			_ = conn.Close()
			return nil, err
		}
		return conn, nil
	}

	end, err := client.NewEndWithDialer(dialer)
	if err != nil {
		return err
	}
	// Best-effort cleanup: the probe measures the handshake result, and a
	// close error on a discarded connection adds no useful signal.
	_ = end.Close()
	return nil
}
