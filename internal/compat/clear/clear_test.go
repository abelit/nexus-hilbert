package clear

import "testing"

func TestClearSlices(t *testing.T) {
	ints := []int{1, 2, 3}
	Clear(ints)
	for i, got := range ints {
		if got != 0 {
			t.Fatalf("ints[%d] = %d, want 0", i, got)
		}
	}

	type sample struct {
		Name  string
		Value float64
	}
	samples := []sample{{Name: "a", Value: 1}, {Name: "b", Value: 2}}
	Clear(samples)
	for i, got := range samples {
		if got != (sample{}) {
			t.Fatalf("samples[%d] = %+v, want zero value", i, got)
		}
	}

	// Clearing an empty or nil slice must not panic.
	Clear([]int{})
	var nilSlice []sample
	Clear(nilSlice)
}
