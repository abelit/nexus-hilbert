package rand

import "testing"

func TestInt64NRange(t *testing.T) {
	for _, n := range []int64{1, 2, 7, 1000} {
		for i := 0; i < 200; i++ {
			got := Int64N(n)
			if got < 0 || got >= n {
				t.Fatalf("Int64N(%d) = %d, want in [0,%d)", n, got, n)
			}
		}
	}
}

func TestInt64NPanicsOnNonPositive(t *testing.T) {
	for _, n := range []int64{0, -1} {
		func() {
			defer func() {
				if recover() == nil {
					t.Fatalf("Int64N(%d) did not panic", n)
				}
			}()
			_ = Int64N(n)
		}()
	}
}
