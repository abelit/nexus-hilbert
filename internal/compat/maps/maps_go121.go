//go:build go1.21

// Package maps re-exports the maps helpers used by the Edge source.
//
// On Go 1.21+ it forwards to the standard library; older toolchains forward to
// golang.org/x/exp/maps.
package maps

import (
	stdmaps "maps"
)

func Clone[M ~map[K]V, K comparable, V any](m M) M { return stdmaps.Clone(m) }

func Copy[M1 ~map[K]V, M2 ~map[K]V, K comparable, V any](dst M1, src M2) {
	stdmaps.Copy(dst, src)
}
