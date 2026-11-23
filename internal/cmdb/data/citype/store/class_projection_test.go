package store

import (
	"context"
	"testing"

	"github.com/ongridio/ongrid/internal/cmdb/biz/classmap"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
)

func TestPlanClassProjection(t *testing.T) {
	repo, db := newAttrRepo(t)

	roomName := seedTypedAttr(t, db, citypemodel.Attribute{
		Name: "room_name", ValueType: "2", IsUnique: true,
	})
	rackName := seedTypedAttr(t, db, citypemodel.Attribute{
		Name: "rack_name", ValueType: "2", IsUnique: true, IsIndex: true,
	})
	uCount := seedTypedAttr(t, db, citypemodel.Attribute{
		Name: "u_count", ValueType: "0", IsIndex: true,
	})

	room := mustType(t, repo, "dcim_server_room", roomName.ID)
	rack := mustType(t, repo, "dcim_rack", rackName.ID, room.ID)
	if err := db.Model(&citypemodel.CIType{}).Where("id = ?", rack.ID).
		Update("show_id", rackName.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&citypemodel.CITypeAttribute{
		TypeID: rack.ID, AttrID: uCount.ID, DefaultShow: true,
	}).Error; err != nil {
		t.Fatal(err)
	}

	report, err := PlanClassProjection(context.Background(), db, nil, nil)
	if err != nil {
		t.Fatalf("PlanClassProjection() error = %v", err)
	}
	if report.Types != 2 || report.Unresolved != 0 || report.Review != 0 || report.Blocked {
		t.Fatalf("report = %+v", report)
	}

	var rackMapping *classmap.Mapping
	for i := range report.Mappings {
		if report.Mappings[i].SourceModel == "dcim_rack" {
			rackMapping = &report.Mappings[i]
			break
		}
	}
	if rackMapping == nil {
		t.Fatalf("dcim_rack missing from mappings: %+v", report.Mappings)
	}
	class := rackMapping.Class
	if class.ClassName != "dcim_rack" || class.ParentClass != "dcim_server_room" {
		t.Fatalf("class = %+v", class)
	}
	if class.Attributes["rack_name"] != "string" || class.Attributes["u_count"] != "int" {
		t.Fatalf("attributes = %+v", class.Attributes)
	}
	if len(class.IdentityKeys) != 1 || class.IdentityKeys[0] != "rack_name" {
		t.Fatalf("identity_keys = %v", class.IdentityKeys)
	}
	if len(class.DisplayKeys) != 1 || class.DisplayKeys[0] != "rack_name" {
		t.Fatalf("display_keys = %v", class.DisplayKeys)
	}
	if len(class.IndexedKeys) != 2 {
		t.Fatalf("indexed_keys = %v", class.IndexedKeys)
	}
}
