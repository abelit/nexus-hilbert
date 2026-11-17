package tunnel

// MethodPowershellExec runs a non-interactive PowerShell command on a
// Windows edge. It is intentionally separate from bash.exec / operator.exec:
// Windows has no PTY-backed shell in the edge, and the command is validated
// against a read-only allowlist before execution.
const MethodPowershellExec = "powershell.exec"

// PowershellExecRequest is the wire body for MethodPowershellExec.
type PowershellExecRequest struct {
	Command string `json:"command"`
	// TimeoutSeconds is clamped by the edge (default 15s, max 120s).
	TimeoutSeconds int `json:"timeout_seconds,omitempty"`
}

// PowershellExecResponse carries the combined output and exit status.
// Allowed=false means the edge rejected the command by policy; no command
// was executed.
type PowershellExecResponse struct {
	Output     string `json:"output"`
	ExitCode   int    `json:"exit_code"`
	DurationMs int64  `json:"duration_ms"`
	Allowed    bool   `json:"allowed"`
	Reason     string `json:"reason,omitempty"`
}
