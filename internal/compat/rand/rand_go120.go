//go:build !go1.22

// Package rand re-exports the math/rand/v2 helpers used by the Edge source.
//
// math/rand/v2 was added in Go 1.22. On older toolchains this package forwards
// the equivalent calls to math/rand, whose top-level functions are safe for
// concurrent use, so legacy call sites keep the same behavior. Only the API
// used by the legacy Edge build is exposed.
package rand

import stdrand "math/rand"

// Int64N returns a non-negative pseudo-random number in the half-open interval
// [0,n). It panics if n <= 0, matching math/rand/v2.
func Int64N(n int64) int64 {
	return stdrand.Int63n(n)
}
