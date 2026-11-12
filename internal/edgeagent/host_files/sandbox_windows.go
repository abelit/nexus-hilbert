//go:build windows

package host_files

// runtimePathSemantics selects Windows path handling for ValidatePath:
// backslash separators, drive-letter absolute paths, case-insensitive
// prefix matching, and the WindowsDeniedReadPaths baseline.
func runtimePathSemantics() pathSemantics {
	return windowsPathSemantics()
}
