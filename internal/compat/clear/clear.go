// Package clear provides the Go 1.21 clear builtin for slice call sites.
//
// The builtin was added in Go 1.21. The legacy Edge build runs on Go 1.20, so
// the harness rewrites the few slice call sites to this helper. It is
// intentionally build-tag free: the loop is valid on every supported Go
// version and does not depend on newer language features.
package clear

// Clear sets every element of s to its zero value. It only supports slices;
// the legacy call sites clear slices that are then resliced to length zero.
func Clear[S ~[]E, E any](s S) {
	var zero E
	for i := range s {
		s[i] = zero
	}
}
