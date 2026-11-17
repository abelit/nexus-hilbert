//go:build !windows

package webshell

// allowedPort keeps the historical Linux behaviour: any loopback TCP port
// may be selected by the manager (WebSSH uses non-22 ports on some hosts).
func allowedPort(uint16) bool { return true }
