//go:build windows

// Package restart_service registers the Edge-side handler for
// MethodRestartService on Windows.
//
// The wire method name, request and response shapes are identical to the
// Linux implementation (handlers.go), so the manager-side BaseTool and the
// reviewer flow do not change. Windows drives the Service Control Manager
// through sc.exe instead of systemd's systemctl.
//
// Sequence: sc.exe query → sc.exe stop → poll query until STOPPED →
// sc.exe start.
//
// sc.exe stop is asynchronous: it returns while the service is still
// STOP_PENDING. Starting immediately can either report 1056 (already
// running, before the stop took effect — a false success) or 1061 (cannot
// accept control, because the service is mid-stop — leaving it stopped).
// We therefore poll sc.exe query until the numeric state is STOPPED (1)
// before starting. The query STATE line's numeric code is used instead of
// its status word because sc.exe localises output on non-English Windows.
// The poll is bounded by the handler context (10 s).
//
// Exit codes handled explicitly:
//
//   - stop:  1062 ERROR_SERVICE_NOT_ACTIVE is benign (already stopped).
//   - start: 1056 ERROR_SERVICE_ALREADY_RUNNING is benign only when the
//     service was known RUNNING before the stop (a concurrent actor won the
//     restart race); otherwise it is a hard failure.
//   - start: 1061 ERROR_SERVICE_CANNOT_ACCEPT_CTRL is retried after a poll
//     (the service is still transitioning), not treated as fatal.
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
	"strconv"
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

	// stopPollInterval is how often sc.exe query is re-run while waiting
	// for a stop to complete.
	stopPollInterval = 200 * time.Millisecond
)

// Windows SCM exit codes handled specially by the restart sequence.
const (
	scErrServiceAlreadyRunning   = 1056 // ERROR_SERVICE_ALREADY_RUNNING
	scErrServiceDoesNotExist     = 1060 // ERROR_SERVICE_DOES_NOT_EXIST
	scErrServiceCannotAcceptCtrl = 1061 // ERROR_SERVICE_CANNOT_ACCEPT_CTRL
	scErrServiceNotActive        = 1062 // ERROR_SERVICE_NOT_ACTIVE
)

// Windows SCM service states reported by `sc.exe query`.
const (
	scStateStopped         = 1
	scStateStartPending    = 2
	scStateStopPending     = 3
	scStateRunning         = 4
	scStateContinuePending = 5
	scStatePausePending    = 6
	scStatePaused          = 7
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

// makeRestartHandler builds the per-call closure with the production
// poll interval and context-aware sleep. Tests that need to control the
// polling clock call makeRestartHandlerWithSequencer instead.
func makeRestartHandler(sb *SandboxConfig, r runner, scPath string, log *slog.Logger) tunnel.Handler {
	return makeRestartHandlerWithSequencer(sb, newSCSequencer(r, scPath), log)
}

// makeRestartHandlerWithSequencer builds the closure around an explicit
// sequencer. Defense in depth: even after the manager-side BaseTool +
// reviewer approved the call, the Edge re-checks the service against its
// OWN allow-list before any sc.exe invocation.
func makeRestartHandlerWithSequencer(sb *SandboxConfig, seq *scSequencer, log *slog.Logger) tunnel.Handler {
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
			if seq == nil || seq.r == nil || seq.scPath == "" {
				return nil, errors.New("restart_service: sc.exe runner not configured")
			}
			if err := seq.restart(cctx, service); err != nil {
				return nil, fmt.Errorf("restart_service: %w", err)
			}
		}

		resp.EndedAt = time.Now().UTC()
		return json.Marshal(resp)
	}
}

// scSequencer owns the sc.exe stop/wait/start state machine. sleep is a
// seam so tests can exercise the bounded poll without wall-clock delays.
type scSequencer struct {
	r            runner
	scPath       string
	sleep        func(context.Context, time.Duration) error
	pollInterval time.Duration
}

func newSCSequencer(r runner, scPath string) *scSequencer {
	return &scSequencer{
		r:            r,
		scPath:       scPath,
		sleep:        sleepCtx,
		pollInterval: stopPollInterval,
	}
}

// restart stops the service, waits until the SCM reports STOPPED, then
// starts it. A service that is already stopped is started directly.
func (s *scSequencer) restart(ctx context.Context, service string) error {
	state, err := s.queryState(ctx, service)
	if err != nil {
		return err
	}
	wasRunning := state == scStateRunning
	if state != scStateStopped {
		out, err := s.r.Run(ctx, s.scPath, "stop", service)
		if err != nil && !isSCExit(err, scErrServiceNotActive) {
			return fmt.Errorf("sc.exe stop %s: %w%s", service, err, outputSuffix(out))
		}
		if err := s.waitForStopped(ctx, service); err != nil {
			return err
		}
	}
	return s.start(ctx, service, wasRunning)
}

// waitForStopped polls sc.exe query until the numeric state is STOPPED.
// The loop is bounded by ctx (the handler applies the 10 s timeout); a
// deadline surfaces as an error rather than a false success.
func (s *scSequencer) waitForStopped(ctx context.Context, service string) error {
	for {
		state, err := s.queryState(ctx, service)
		if err != nil {
			return err
		}
		if state == scStateStopped {
			return nil
		}
		if err := s.sleep(ctx, s.pollInterval); err != nil {
			return fmt.Errorf("sc.exe stop %s: timed out waiting for state STOPPED: %w", service, err)
		}
	}
}

// start starts the service. 1056 is benign only when the service was known
// RUNNING before the stop (another actor started it while we waited and the
// post-condition holds). 1061 means the service is still transitioning, so
// we wait, re-query, and retry until success or the context deadline.
func (s *scSequencer) start(ctx context.Context, service string, wasRunning bool) error {
	for {
		out, err := s.r.Run(ctx, s.scPath, "start", service)
		if err == nil {
			return nil
		}
		switch {
		case isSCExit(err, scErrServiceAlreadyRunning):
			if wasRunning {
				return nil
			}
			return fmt.Errorf("sc.exe start %s: %w%s", service, err, outputSuffix(out))
		case isSCExit(err, scErrServiceCannotAcceptCtrl):
			if sleepErr := s.sleep(ctx, s.pollInterval); sleepErr != nil {
				return fmt.Errorf("sc.exe start %s: service did not accept control: %w%s", service, err, outputSuffix(out))
			}
			state, qerr := s.queryState(ctx, service)
			if qerr == nil && state == scStateRunning {
				return nil
			}
			continue
		default:
			return fmt.Errorf("sc.exe start %s: %w%s", service, err, outputSuffix(out))
		}
	}
}

// queryState runs sc.exe query and returns the numeric SCM state.
func (s *scSequencer) queryState(ctx context.Context, service string) (int, error) {
	out, err := s.r.Run(ctx, s.scPath, "query", service)
	if err != nil {
		return 0, fmt.Errorf("sc.exe query %s: %w%s", service, err, outputSuffix(out))
	}
	state, ok := parseServiceState(out, service)
	if !ok {
		return 0, fmt.Errorf("sc.exe query %s: cannot determine service state", service)
	}
	return state, nil
}

// sleepCtx sleeps for d or returns ctx's error, whichever comes first.
func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		d = time.Millisecond
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// parseServiceState extracts the numeric state for service from sc.exe
// query output. sc.exe localises labels and status words, so the parser:
//
//   - splits blocks on unindented header lines and matches the service name
//     value (locale-independent), then
//   - accepts the first "<label>: <1..7> <word>" value inside the block.
//
// Other numeric fields (TYPE=10/20/110, WIN32_EXIT_CODE=0, CHECKPOINT=0x0)
// are outside the 1..7 range or not plain decimal, so they cannot be
// mistaken for a state.
func parseServiceState(out []byte, service string) (int, bool) {
	lines := strings.Split(string(out), "\n")
	inTarget := false
	haveHeader := false
	for _, raw := range lines {
		line := strings.TrimRight(raw, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		if line[0] != ' ' && line[0] != '\t' {
			haveHeader = true
			name := ""
			if i := strings.IndexByte(line, ':'); i >= 0 {
				name = strings.TrimSpace(line[i+1:])
			}
			inTarget = strings.EqualFold(name, service)
			continue
		}
		if !inTarget {
			continue
		}
		if state, ok := parseStateValue(line); ok {
			return state, true
		}
	}
	// A single-service report whose header could not be matched (for
	// example a localised header that still echoes the name differently)
	// is still safe to parse when there is exactly one state value.
	if !haveHeader {
		for _, raw := range lines {
			if state, ok := parseStateValue(strings.TrimRight(raw, "\r")); ok {
				return state, true
			}
		}
	}
	return 0, false
}

// parseStateValue recognises an sc.exe detail line carrying a state code:
// "<label> : <1..7>  <status word>". The word is not interpreted.
func parseStateValue(line string) (int, bool) {
	i := strings.IndexByte(line, ':')
	if i < 0 {
		return 0, false
	}
	fields := strings.Fields(line[i+1:])
	if len(fields) < 2 {
		return 0, false
	}
	n, err := strconv.Atoi(fields[0])
	if err != nil || n < scStateStopped || n > scStatePaused {
		return 0, false
	}
	if _, err := strconv.Atoi(fields[1]); err == nil {
		return 0, false
	}
	return n, true
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
