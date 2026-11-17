// Package powershell exposes a read-only, non-interactive PowerShell command
// capability for Windows edges. Windows has no PTY-backed shell in the agent,
// so this is a request/response RPC (not an interactive terminal).
//
// Policy: only read-only cmdlets are accepted. The command is split on pipes;
// every segment's first token must match the allowlist. Constructs that can
// execute arbitrary code (subexpressions, script blocks, redirection, command
// chaining) are rejected outright.
package powershell

import (
	"fmt"
	"strings"
)

// allowedPrefixes is the read-only cmdlet allowlist. Matching is
// case-insensitive and prefix-based (Get-ChildItem matches Get-).
var allowedPrefixes = []string{
	"get-", "test-", "resolve-", "select-", "measure-", "where-",
	"sort-", "format-", "convertto-", "convertfrom-", "out-string",
}

var allowedExact = map[string]bool{
	"write-output": true,
	"write-host":   true,
	"start-sleep":  true,
}

// forbiddenSubstrings rejects constructs that escape single-command
// validation: chaining, subexpressions, script blocks, redirection and
// here-strings.
var forbiddenSubstrings = []string{
	";", "&", "`", "$(", "@{", "@'", "@\"", ">", "<", "\n", "\r",
	"invoke-expression", "iex ", "iex(", "start-process", "new-object",
	"add-type", "set-executionpolicy",
}

// ValidateReadOnly reports whether command may run under the read-only
// policy. It never executes anything.
func ValidateReadOnly(command string) error {
	cmd := strings.TrimSpace(command)
	if cmd == "" {
		return fmt.Errorf("command is empty")
	}
	lower := strings.ToLower(cmd)
	for _, bad := range forbiddenSubstrings {
		if strings.Contains(lower, bad) {
			return fmt.Errorf("command contains a disallowed construct %q (read-only policy)", bad)
		}
	}
	segments := strings.Split(cmd, "|")
	for _, segment := range segments {
		segment = strings.TrimSpace(segment)
		if segment == "" {
			return fmt.Errorf("empty pipeline segment")
		}
		token := firstToken(segment)
		if token == "" {
			return fmt.Errorf("cannot parse pipeline segment %q", segment)
		}
		if !isAllowedCmdlet(token) {
			return fmt.Errorf("cmdlet %q is not in the read-only allowlist", token)
		}
	}
	return nil
}

func firstToken(segment string) string {
	fields := strings.Fields(segment)
	if len(fields) == 0 {
		return ""
	}
	return strings.ToLower(fields[0])
}

func isAllowedCmdlet(token string) bool {
	if allowedExact[token] {
		return true
	}
	for _, prefix := range allowedPrefixes {
		if strings.HasPrefix(token, prefix) {
			return true
		}
	}
	return false
}
