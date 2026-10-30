package ci

import (
	"context"
	"testing"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
)

// upwardRepoFake answers only the parent walk. The other relation methods stay
// as the embedded stub's refusals, so this test cannot pass by accident.
type upwardRepoFake struct {
	searchRepoFake
	parents map[model.ID][]WalkKey
}

func (f *upwardRepoFake) WalkParents(_ context.Context, ids []model.ID) ([]WalkKey, []model.ID, error) {
	var out []WalkKey
	for _, id := range ids {
		out = append(out, f.parents[id]...)
	}
	return out, nil, nil
}

// A reverse walk must return the parents it collected. The collect callback
// appends to the caller's list, so returning walkUpwards' own (empty) slice
// discarded every upstream instance and made the detail page and topology show
// no parents at all.
func TestWalkHierarchyReverseReturnsParents(t *testing.T) {
	repo := &upwardRepoFake{
		searchRepoFake: searchRepoFake{},
		parents: map[model.ID][]WalkKey{
			42: {{Node: 10, TypeID: 1}, {Node: 11, TypeID: 2}},
		},
	}
	uc := &Usecase{repo: repo}
	root := &cimodel.CI{TypeID: 1}
	root.ID = 42

	got, err := uc.walkHierarchy(context.Background(), []*cimodel.CI{root}, []int{1}, 1, false, true, "")
	if err != nil {
		t.Fatalf("walkHierarchy: %v", err)
	}
	if len(got) != 2 || got[0] != 10 || got[1] != 11 {
		t.Fatalf("reverse walk = %v, want [10 11]", got)
	}
}
