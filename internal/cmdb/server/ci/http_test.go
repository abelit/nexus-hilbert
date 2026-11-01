package ci

import (
	"testing"

	cibiz "github.com/ongridio/ongrid/internal/cmdb/biz/ci"
	model "github.com/ongridio/ongrid/internal/cmdb/model"
)

func TestWriteResponseKeepsTheCreateShapeAndReportsUpdateChanges(t *testing.T) {
	create := writeResponse(&cibiz.WriteResult{
		CIID: 1, Created: true,
		Changes: []cibiz.Change{{AttrID: 10, New: "web-01"}},
	})
	if _, ok := create["changes"]; ok {
		t.Fatalf("create response = %+v, want no changes key", create)
	}
	update := writeResponse(&cibiz.WriteResult{
		CIID:    1,
		Changes: []cibiz.Change{{AttrID: 10, Old: "web-00", New: "web-01"}},
	})
	changes, ok := update["changes"].([]map[string]any)
	if !ok || len(changes) != 1 || changes[0]["attr_id"] != model.ID(10) {
		t.Fatalf("update response = %+v", update)
	}
}
