//go:build !windows

package host_files

// runtimePathSemantics selects Unix path handling for ValidatePath:
// slash separators, byte-exact prefix matching, and the Unix
// DefaultDeniedReadPaths baseline. This preserves Linux/Darwin behavior.
func runtimePathSemantics() pathSemantics {
	return unixPathSemantics()
}
