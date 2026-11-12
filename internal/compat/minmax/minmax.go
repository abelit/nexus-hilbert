// Package minmax provides generic Min and Max helpers for ordered values.
//
// It exists so the Edge source can build with Go 1.20, which predates the
// min and max builtins introduced in Go 1.21. Call sites use
// minmax.Min / minmax.Max instead of the builtins.
package minmax

import "math"

// Ordered is the set of types accepted by Min and Max.
type Ordered interface {
	~int | ~int8 | ~int16 | ~int32 | ~int64 |
		~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr |
		~float32 | ~float64 |
		~string
}

// Min returns the smaller of a and b. It matches the Go 1.21 min builtin:
// NaN operands propagate, and -0 is considered less than +0.
func Min[T Ordered](a, b T) T {
	if isNaN(a) {
		return a
	}
	if isNaN(b) {
		return b
	}
	if a < b {
		return a
	}
	if b < a {
		return b
	}
	// Equal: the builtin orders -0 before +0.
	if !isNegativeZero(a) && isNegativeZero(b) {
		return b
	}
	return a
}

// Max returns the larger of a and b. It matches the Go 1.21 max builtin:
// NaN operands propagate, and +0 is considered greater than -0.
func Max[T Ordered](a, b T) T {
	if isNaN(a) {
		return a
	}
	if isNaN(b) {
		return b
	}
	if a > b {
		return a
	}
	if b > a {
		return b
	}
	// Equal: the builtin orders +0 after -0.
	if isNegativeZero(a) && !isNegativeZero(b) {
		return b
	}
	return a
}

func isNaN[T Ordered](v T) bool {
	return v != v
}

func isNegativeZero[T Ordered](v T) bool {
	switch x := any(v).(type) {
	case float32:
		return x == 0 && math.Signbit(float64(x))
	case float64:
		return x == 0 && math.Signbit(x)
	default:
		return false
	}
}
