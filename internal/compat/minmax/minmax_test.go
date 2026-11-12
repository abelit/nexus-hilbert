package minmax

import (
	"math"
	"testing"
)

func TestMinInts(t *testing.T) {
	tests := []struct {
		name string
		a, b int
		min  int
		max  int
	}{
		{name: "a less", a: 3, b: 5, min: 3, max: 5},
		{name: "b less", a: 7, b: -2, min: -2, max: 7},
		{name: "equal", a: 4, b: 4, min: 4, max: 4},
		{name: "zero", a: 0, b: 1, min: 0, max: 1},
		{name: "negative", a: -9, b: -3, min: -9, max: -3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Min(tt.a, tt.b); got != tt.min {
				t.Fatalf("Min(%d, %d) = %d, want %d", tt.a, tt.b, got, tt.min)
			}
			if got := Max(tt.a, tt.b); got != tt.max {
				t.Fatalf("Max(%d, %d) = %d, want %d", tt.a, tt.b, got, tt.max)
			}
		})
	}
}

func TestMinMaxInt64(t *testing.T) {
	if got := Min(int64(math.MinInt64), int64(0)); got != math.MinInt64 {
		t.Fatalf("Min = %d, want %d", got, int64(math.MinInt64))
	}
	if got := Max(int64(0), int64(math.MaxInt64)); got != math.MaxInt64 {
		t.Fatalf("Max = %d, want %d", got, int64(math.MaxInt64))
	}
}

func TestMinMaxUint(t *testing.T) {
	if got := Min(uint(0), uint(10)); got != 0 {
		t.Fatalf("Min = %d, want 0", got)
	}
	if got := Max(uint(0), uint(10)); got != 10 {
		t.Fatalf("Max = %d, want 10", got)
	}
}

func TestMinMaxFloats(t *testing.T) {
	if got := Min(1.5, 2.5); got != 1.5 {
		t.Fatalf("Min = %v, want 1.5", got)
	}
	if got := Max(1.5, 2.5); got != 2.5 {
		t.Fatalf("Max = %v, want 2.5", got)
	}
	if got := Min(float32(-1.5), float32(1.5)); got != -1.5 {
		t.Fatalf("Min float32 = %v, want -1.5", got)
	}
	if got := Max(float32(-1.5), float32(1.5)); got != 1.5 {
		t.Fatalf("Max float32 = %v, want 1.5", got)
	}
}

func TestMinMaxFloatNaN(t *testing.T) {
	nan := math.NaN()
	// The Go min/max builtins propagate NaN for any NaN argument.
	if got := Min(nan, 1.0); !math.IsNaN(got) {
		t.Fatalf("Min(NaN, 1) = %v, want NaN", got)
	}
	if got := Min(1.0, nan); !math.IsNaN(got) {
		t.Fatalf("Min(1, NaN) = %v, want NaN", got)
	}
	if got := Max(nan, 1.0); !math.IsNaN(got) {
		t.Fatalf("Max(NaN, 1) = %v, want NaN", got)
	}
	if got := Max(1.0, nan); !math.IsNaN(got) {
		t.Fatalf("Max(1, NaN) = %v, want NaN", got)
	}
}

func TestMinMaxNegativeZero(t *testing.T) {
	negZero := math.Copysign(0, -1)
	posZero := 0.0
	// The Go min/max builtins order -0 before +0.
	if got := Min(negZero, posZero); !math.Signbit(got) {
		t.Fatalf("Min(-0, +0) = %v, want -0", got)
	}
	if got := Min(posZero, negZero); !math.Signbit(got) {
		t.Fatalf("Min(+0, -0) = %v, want -0", got)
	}
	if got := Max(negZero, posZero); math.Signbit(got) {
		t.Fatalf("Max(-0, +0) = %v, want +0", got)
	}
	if got := Max(posZero, negZero); math.Signbit(got) {
		t.Fatalf("Max(+0, -0) = %v, want +0", got)
	}
}

func TestMinMaxStrings(t *testing.T) {
	if got := Min("banana", "apple"); got != "apple" {
		t.Fatalf("Min = %q, want apple", got)
	}
	if got := Max("banana", "apple"); got != "banana" {
		t.Fatalf("Max = %q, want banana", got)
	}
	if got := Min("same", "same"); got != "same" {
		t.Fatalf("Min = %q, want same", got)
	}
}

func TestMinMaxNested(t *testing.T) {
	// Multi-argument builtin calls are rewritten as left-nested binary calls.
	if got := Min(Min(9, 4), 7); got != 4 {
		t.Fatalf("nested Min = %d, want 4", got)
	}
	if got := Max(Max(9, 4), 7); got != 9 {
		t.Fatalf("nested Max = %d, want 9", got)
	}
	if got := Max(1, Max(5, 3)); got != 5 {
		t.Fatalf("nested Max = %d, want 5", got)
	}
}
