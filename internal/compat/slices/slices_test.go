package slices

import "testing"

func TestHelpers(t *testing.T) {
	if !Contains([]int{1, 2, 3}, 2) {
		t.Fatal("Contains should find 2")
	}
	if Contains([]int{1, 2, 3}, 4) {
		t.Fatal("Contains should not find 4")
	}
	if !ContainsFunc([]int{1, 2, 3}, func(v int) bool { return v > 2 }) {
		t.Fatal("ContainsFunc should match")
	}
	if got := IndexFunc([]int{1, 2, 3}, func(v int) bool { return v == 3 }); got != 2 {
		t.Fatalf("IndexFunc = %d, want 2", got)
	}
	if !Equal([]string{"a", "b"}, []string{"a", "b"}) {
		t.Fatal("Equal should be true")
	}
	if Equal([]string{"a"}, []string{"b"}) {
		t.Fatal("Equal should be false")
	}
}

func TestSortCompactClone(t *testing.T) {
	in := []int{3, 1, 3, 2}
	clone := Clone(in)
	Sort(clone)
	want := []int{1, 2, 3, 3}
	for i := range want {
		if clone[i] != want[i] {
			t.Fatalf("Sort = %v, want %v", clone, want)
		}
	}
	if got := Compact([]string{"a", "a", "b", "b", "a"}); len(got) != 3 {
		t.Fatalf("Compact = %v, want 3 elements", got)
	}
}
