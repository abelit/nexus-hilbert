//go:build !go1.21

// Package slices re-exports the slices helpers used by the Edge source.
//
// On Go 1.21+ it forwards to the standard library; older toolchains forward to
// golang.org/x/exp/slices. Only the API shared by both is exposed so the
// package compiles identically under both toolchains.
//
// The iterator-based stdlib additions (for example slices.Chunk, which returns
// an iter.Seq) are intentionally absent: Go 1.20 has no iter package, so the
// packages that use them (autoapm) are not part of the legacy Edge build.
package slices

import (
	expslices "golang.org/x/exp/slices"

	"github.com/ongridio/ongrid/internal/compat/minmax"
)

func Contains[S ~[]E, E comparable](s S, v E) bool { return expslices.Contains(s, v) }

func Sort[S ~[]E, E minmax.Ordered](x S) { expslices.Sort(x) }

func Compact[S ~[]E, E comparable](s S) S { return expslices.Compact(s) }

func ContainsFunc[S ~[]E, E any](s S, f func(E) bool) bool { return expslices.ContainsFunc(s, f) }

func Clone[S ~[]E, E any](s S) S { return expslices.Clone(s) }

func IndexFunc[S ~[]E, E any](s S, f func(E) bool) int { return expslices.IndexFunc(s, f) }

func Equal[S ~[]E, E comparable](s1, s2 S) bool { return expslices.Equal(s1, s2) }
