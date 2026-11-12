//go:build go1.22

// Package rand re-exports the math/rand/v2 helpers used by the Edge source.
//
// math/rand/v2 was added in Go 1.22. On Go 1.22+ this package forwards to it
// directly; older toolchains use the math/rand fallback in rand_go120.go.
package rand

import stdrand "math/rand/v2"

// Int64N returns a non-negative pseudo-random number in the half-open interval
// [0,n). It panics if n <= 0, matching math/rand/v2.
func Int64N(n int64) int64 {
	return stdrand.Int64N(n)
}
