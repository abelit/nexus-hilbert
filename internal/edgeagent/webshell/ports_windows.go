//go:build windows

package webshell

// allowedPort restricts Windows stream forwards to the two remote-console
// services. WebSSH port selection does not apply here (there is no SSH
// daemon by default), so keeping the surface minimal is deliberate.
func allowedPort(port uint16) bool {
	return port == 5900 || port == 3389
}
