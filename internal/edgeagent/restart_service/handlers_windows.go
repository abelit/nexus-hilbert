//go:build windows

// Package restart_service registers the Edge-side handler for
// MethodRestartService on Windows.
//
// The wire method name, request and response shapes are identical to the
// Linux implementation (handlers.go), so the manager-side BaseTool and the
// reviewer flow do not change. Windows drives the Service Control Manager
// through sc.exe instead of systemd's systemctl.
//
// Sequence: sc.exe stop <name> then sc.exe start <name>.
//
// We deliberately do NOT run sc.exe query first. sc.exe writes localised
// output ("RUNNING" is translated on non-English Windows), so parsing the
// query response is fragile. Instead the state machine is driven by exit
// codes: two expected races are benign and must not fail the restart:
//
//   - stop: 1062 ERROR_SERVICE_NOT_ACTIVE   (service already stopped)
//   - start: 1056 ERROR_SERVICE_ALREADY_RUNNING (service already running)
//
// Everything else (1060 service-not-exist, 5 access-denied, timeout, ...)
// is a hard failure. The restart never falls back to a shell: sc.exe gets
// the canonical service name as a separate argv element.
package restart_service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/ongridio/ongrid/internal/pkg/tunnel"
)

const (
	// restartHandlerTimeout caps one Edge-side invocation, matching the
	// Linux package's budget.
	restartHandlerTimeout = 10 * time.Second

	// restartOutputCap bounds each captured stream (stdout/stderr) so a
	// misbehaving sc.exe cannot grow the Edge heap. Matches cmdpolicy's
	// default stdout cap.
	restartOutputCap = 64 * 1024
)

// Windows SCM exit codes handled specially by the restart sequence.
const (
	scErrServiceAlreadyRunning = 1056 // ERROR_SERVICE_ALREADY_RUNNING
	scErrServiceDoesNotExist   = 1060 // ERROR_SERVICE_DOES_NOT_EXIST
	scErrServiceNotActive      = 1062 // ERROR_SERVICE_NOT_ACTIVE
)

// runner is the injectable sc.exe seam. Production uses execRunner; tests
// supply a recorder so command construction, allow-list denial and mocked
// mode can be asserted without a Windows SCM.
type runner interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
}

// execRunner executes sc.exe and bounds each captured stream.
type execRunner struct{}

func (execRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr cappedBuffer
	stdout.limit = restartOutputCap
	stderr.limit = restartOutputCap
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	out := append(stdout.Bytes(), stderr.Bytes()...)
	if err != nil {
		return out, fmt.Errorf("%s %s: %w", filepath.Base(name), strings.Join(args, " "), err)
	}
	return out, nil
}

// cappedBuffer is an io.Writer that records at most limit bytes and
// silently discards the rest while always reporting the full write. exec.Cmd
// copies child output through this writer; returning a short count or an
// error there would abort the copy (and may race the process shutdown).
type cappedBuffer struct {
	buf   bytes.Buffer
	limit int
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if c.limit > 0 {
		if remaining := c.limit - c.buf.Len(); remaining > 0 {
			if len(p) > remaining {
				p = p[:remaining]
			}
			_, _ = c.buf.Write(p)
		}
	}
	return n, nil
}

func (c *cappedBuffer) Bytes() []byte { return c.buf.Bytes() }

// Register installs the restart_service handler on client. It loads the
// allow-list from the operator policy file (defaults when missing) and
// resolves the absolute sc.exe path. Returns an error when the policy or
// tool path is unhealthy; the caller treats that as a soft failure and boots
// without the capability. log may be nil.
func Register(client tunnel.Client, log *slog.Logger) error {
	return registerWith(client, log, defaultPolicyPath)
}

// registerWith is Register with an explicit policy path, so tests can point
// at a temp file without a package-level mutable seam.
func registerWith(client tunnel.Client, log *slog.Logger, policyPath string) error {
	if log == nil {
		log = slog.Default()
	}
	sb, err := loadSandboxConfig(policyPath)
	if err != nil {
		return err
	}
	if err := sb.Validate(); err != nil {
		return err
	}
	scPath, err := resolveScExe()
	if err != nil {
		return err
	}
	log.Info("restart_service: sandbox ready",
		slog.Int("allowed_services", len(sb.AllowedServices)),
		slog.Bool("mocked", sb.Mocked),
		slog.String("sc", scPath),
	)
	client.RegisterHandler(tunnel.MethodRestartService, makeRestartHandler(sb, execRunner{}, scPath, log))
	return nil
}

// makeRestartHandler builds the per-call closure. Defense in depth: even
// after the manager-side BaseTool + reviewer approved the call, the Edge
// re-checks the service against its OWN allow-list before any sc.exe
// invocation.
func makeRestartHandler(sb *SandboxConfig, r runner, scPath string, log *slog.Logger) tunnel.Handler {
	if log == nil {
		log = slog.Default()
	}
	return func(ctx context.Context, _ tunnel.Session, _ string, body []byte) ([]byte, error) {
		var req tunnel.RestartServiceRequest
		if len(body) > 0 {
			if err := json.Unmarshal(body, &req); err != nil {
				return nil, fmt.Errorf("restart_service: bad req: %w", err)
			}
		}
		if canonicalServiceName(req.Service) == "" {
			return nil, errors.New("restart_service: service name required")
		}
		service, ok := sb.Resolve(req.Service)
		if !ok {
			return nil, fmt.Errorf("restart_service: service %q not in allow-list (%s)",
				req.Service, strings.Join(sb.AllowedServices, " "))
		}

		log.Info("restart_service invoked",
			slog.String("service", service),
			slog.String("reason", req.Reason),
			slog.Bool("mocked", sb.Mocked),
		)

		cctx, cancel := context.WithTimeout(ctx, restartHandlerTimeout)
		defer cancel()

		startedAt := time.Now().UTC()
		resp := tunnel.RestartServiceResponse{
			Service:   service,
			Restarted: true,
			Mocked:    sb.Mocked,
			StartedAt: startedAt,
		}

		if sb.Mocked {
			if err := cctx.Err(); err != nil {
				return nil, fmt.Errorf("restart_service: %w", err)
			}
		} else {
			if scPath == "" {
				return nil, errors.New("restart_service: sc.exe path not configured")
			}
			if err := stopThenStart(cctx, r, scPath, service); err != nil {
				return nil, fmt.Errorf("restart_service: %w", err)
			}
		}

		resp.EndedAt = time.Now().UTC()
		return json.Marshal(resp)
	}
}

// stopThenStart stops and then starts the service. The stop error
// ERROR_SERVICE_NOT_ACTIVE and the start error ERROR_SERVICE_ALREADY_RUNNING
// are benign: the post-condition (service running) still holds.
func stopThenStart(ctx context.Context, r runner, scPath, service string) error {
	out, err := r.Run(ctx, scPath, "stop", service)
	if err != nil && !isSCExit(err, scErrServiceNotActive) {
		return fmt.Errorf("sc.exe stop %s: %w%s", service, err, outputSuffix(out))
	}
	out, err = r.Run(ctx, scPath, "start", service)
	if err != nil && !isSCExit(err, scErrServiceAlreadyRunning) {
		return fmt.Errorf("sc.exe start %s: %w%s", service, err, outputSuffix(out))
	}
	return nil
}

// isSCExit reports whether err carries the given Windows SCM exit code.
// *exec.ExitError and test doubles both expose ExitCode() int.
func isSCExit(err error, code int) bool {
	var coder interface{ ExitCode() int }
	if errors.As(err, &coder) {
		return coder.ExitCode() == code
	}
	return false
}

// outputSuffix appends a bounded, trimmed sc.exe output snippet to an
// error message so operators can act without drowning the log.
func outputSuffix(out []byte) string {
	s := strings.TrimSpace(string(out))
	if s == "" {
		return ""
	}
	if len(s) > 200 {
		s = s[:200] + "..."
	}
	return ": " + s
}
