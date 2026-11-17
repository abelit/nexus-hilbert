//go:build windows

package powershell

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/ongridio/ongrid/internal/pkg/tunnel"
)

const (
	defaultTimeout = 15 * time.Second
	maxTimeout     = 120 * time.Second
	outputCap      = 64 << 10
)

// Register installs the powershell.exec handler on client.
func Register(client tunnel.Client, log *slog.Logger) {
	if log == nil {
		log = slog.Default()
	}
	log.Info("powershell: read-only exec ready", slog.String("method", tunnel.MethodPowershellExec))
	client.RegisterHandler(tunnel.MethodPowershellExec, makeHandler(log))
}

func makeHandler(log *slog.Logger) tunnel.Handler {
	return func(ctx context.Context, _ tunnel.Session, _ string, body []byte) ([]byte, error) {
		var req tunnel.PowershellExecRequest
		if len(body) > 0 {
			if err := json.Unmarshal(body, &req); err != nil {
				return nil, fmt.Errorf("powershell: bad req: %w", err)
			}
		}
		if err := ValidateReadOnly(req.Command); err != nil {
			log.Warn("powershell: command rejected", slog.String("err", err.Error()))
			return json.Marshal(tunnel.PowershellExecResponse{Allowed: false, ExitCode: -1, Reason: err.Error()})
		}
		exe, err := powershellExe()
		if err != nil {
			return json.Marshal(tunnel.PowershellExecResponse{Allowed: false, ExitCode: -1, Reason: err.Error()})
		}

		timeout := time.Duration(req.TimeoutSeconds) * time.Second
		if timeout <= 0 {
			timeout = defaultTimeout
		}
		if timeout > maxTimeout {
			timeout = maxTimeout
		}
		cctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()

		start := time.Now()
		cmd := exec.CommandContext(cctx, exe,
			"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
			"-Command", req.Command)
		out, runErr := cmd.CombinedOutput()
		exitCode := 0
		if runErr != nil {
			var exitErr *exec.ExitError
			if errors.As(runErr, &exitErr) {
				exitCode = exitErr.ExitCode()
			} else {
				exitCode = -1
			}
			if errors.Is(cctx.Err(), context.DeadlineExceeded) {
				exitCode = -2
				out = append(out, []byte("\ncommand timed out")...)
			}
		}
		output := string(out)
		if len(output) > outputCap {
			output = output[:outputCap] + "\n… output truncated"
		}
		duration := time.Since(start)
		log.Info("powershell: exec completed",
			slog.Int("exit_code", exitCode),
			slog.Int64("duration_ms", duration.Milliseconds()),
			slog.String("command", truncate(req.Command, 200)),
		)
		return json.Marshal(tunnel.PowershellExecResponse{
			Output:     output,
			ExitCode:   exitCode,
			DurationMs: duration.Milliseconds(),
			Allowed:    true,
		})
	}
}

func powershellExe() (string, error) {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = os.Getenv("windir")
	}
	if root == "" {
		return "", fmt.Errorf("SystemRoot environment variable not set")
	}
	path := filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("powershell.exe not found: %w", err)
	}
	return path, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
