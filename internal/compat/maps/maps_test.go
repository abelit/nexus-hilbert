package maps

import "testing"

func TestClone(t *testing.T) {
	src := map[string]int{"a": 1, "b": 2}
	clone := Clone(src)
	if len(clone) != 2 || clone["a"] != 1 || clone["b"] != 2 {
		t.Fatalf("Clone = %v", clone)
	}
	clone["c"] = 3
	if _, ok := src["c"]; ok {
		t.Fatal("Clone should not alias the source map")
	}
}

func TestCopy(t *testing.T) {
	dst := map[string]int{"a": 1}
	Copy(dst, map[string]int{"b": 2})
	if dst["a"] != 1 || dst["b"] != 2 {
		t.Fatalf("Copy = %v", dst)
	}
}
