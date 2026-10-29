package store

import (
	"context"
	"sort"
	"testing"

	citypebiz "github.com/ongridio/ongrid/internal/cmdb/biz/citype"
	model "github.com/ongridio/ongrid/internal/cmdb/model"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
)

func itemsOfGroup(t *testing.T, repo *Repo, groupID model.ID) []citypemodel.CITypeGroupItem {
	t.Helper()
	items, err := repo.TypeGroupItems(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	out := make([]citypemodel.CITypeGroupItem, 0)
	for _, item := range items {
		if item.GroupID == groupID {
			out = append(out, item)
		}
	}
	// TypeGroupItems is ordered by id for a stable read; the arrangement is
	// the Order column, which is what these assertions care about.
	sort.Slice(out, func(i, j int) bool { return out[i].Order < out[j].Order })
	return out
}

// The list is the arrangement: existing members take their position from the
// request, and a member named here leaves whichever group held it before.
func TestSetTypeGroupMembersStoresTheOrder(t *testing.T) {
	repo, db := newTestRepo(t)
	ctx := context.Background()
	attr := seedAttr(t, db, "hostname")
	first := seedType(t, db, "host", "主机", attr.ID, nil)
	second := seedType(t, db, "switch", "交换机", attr.ID, nil)
	third := seedType(t, db, "router", "路由器", attr.ID, nil)

	group, err := repo.CreateTypeGroup(ctx, citypebiz.TypeGroupCreateSpec{Name: "网络"})
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.SetTypeGroupMembers(ctx, citypebiz.TypeGroupMembersSpec{
		ID: group.ID, TypeIDs: []model.ID{third.ID, first.ID, second.ID},
	}); err != nil {
		t.Fatalf("SetTypeGroupMembers() error = %v", err)
	}

	items := itemsOfGroup(t, repo, group.ID)
	if len(items) != 3 {
		t.Fatalf("items = %+v, want the three named members", items)
	}
	want := []model.ID{third.ID, first.ID, second.ID}
	for index, item := range items {
		if item.TypeID != want[index] || item.Order != model.SmallInt(index) {
			t.Fatalf("item %d = %+v, want %d at position %d", index, item, want[index], index)
		}
	}

	// Reordering the same set rewrites the positions rather than appending.
	if err := repo.SetTypeGroupMembers(ctx, citypebiz.TypeGroupMembersSpec{
		ID: group.ID, TypeIDs: []model.ID{second.ID, third.ID, first.ID},
	}); err != nil {
		t.Fatal(err)
	}
	items = itemsOfGroup(t, repo, group.ID)
	want = []model.ID{second.ID, third.ID, first.ID}
	for index, item := range items {
		if item.TypeID != want[index] || item.Order != model.SmallInt(index) {
			t.Fatalf("reordered item %d = %+v, want %d", index, item, want[index])
		}
	}

	// Naming a member of another group moves it, and the source group keeps
	// only the models it still owns.
	other, err := repo.CreateTypeGroup(ctx, citypebiz.TypeGroupCreateSpec{Name: "设备"})
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.SetTypeGroupMembers(ctx, citypebiz.TypeGroupMembersSpec{
		ID: other.ID, TypeIDs: []model.ID{first.ID},
	}); err != nil {
		t.Fatal(err)
	}
	if moved := itemsOfGroup(t, repo, other.ID); len(moved) != 1 || moved[0].TypeID != first.ID {
		t.Fatalf("target group = %+v, want the moved model", moved)
	}
	if remaining := itemsOfGroup(t, repo, group.ID); len(remaining) != 2 {
		t.Fatalf("source group = %+v, want the other two members", remaining)
	}
}
