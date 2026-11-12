//go:build go1.21

// Package slices re-exports the slices helpers used by the Edge source.
//
// On Go 1.21+ it forwards to the standard library; older toolchains forward to
// golang.org/x/exp/slices. Only the API shared by both is exposed so the
// package compiles identically under both toolchains.
package slices

import (
	stdslices "slices"

	"github.com/ongridio/ongrid/internal/compat/minmax"
)

func Contains[S ~[]E, E comparable](s S, v E) bool { return stdslices.Contains(s, v) }

func Sort[S ~[]E, E minmax.Ordered](x S) { stdslices.Sort(x) }

func Compact[S ~[]E, E comparable](s S) S { return stdslices.Compact(s) }

func ContainsFunc[S ~[]E, E any](s S, f func(E) bool) bool { return stdslices.ContainsFunc(s, f) }

func Clone[S ~[]E, E any](s S) S { return stdslices.Clone(s) }

func IndexFunc[S ~[]E, E any](s S, f func(E) bool) int { return stdslices.IndexFunc(s, f) }

func Equal[S ~[]E, E comparable](s1, s2 S) bool { return stdslices.Equal(s1, s2) }
