package store

import (
	"context"
	"errors"
	"testing"

	"gorm.io/gorm"

	cibiz "github.com/ongridio/ongrid/internal/cmdb/biz/ci"
	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
)

// The rollback deletes the M1 targets, their mapping rows and the inferred
// containment edges between them, but refuses when any other live relation
// touches a target.
func TestRollbackServiceLayersRefusesForeignRelations(t *testing.T) {
	db := newTestDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := db.AutoMigrate(&citypemodel.CIType{}); err != nil {
		t.Fatalf("migrate types: %v", err)
	}
	for id, name := range map[model.ID]string{
		30: "service", 31: "application", 40: "business_service", 41: "application_service",
	} {
		ct := citypemodel.CIType{Name: name, Alias: name, Enabled: true}
		ct.ID = id
		if err := db.Create(&ct).Error; err != nil {
			t.Fatalf("seed type %s: %v", name, err)
		}
	}
	rt := citypemodel.RelationType{Name: "CONTAINS", Category: "structure"}
	rt.ID = 51
	if err := db.Create(&rt).Error; err != nil {
		t.Fatalf("seed relation type: %v", err)
	}
	for _, ci := range []struct {
		id, typeID model.ID
	}{
		{4001, 40}, {4101, 41}, {9999, 31},
	} {
		row := cimodel.CI{TypeID: ci.typeID, PropsJSON: "{}"}
		row.ID = ci.id
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed ci %d: %v", ci.id, err)
		}
	}
	for _, mapping := range []struct {
		sourceModel string
		sourceCI    model.ID
		targetModel string
		targetCI    model.ID
	}{
		{"service", 1201, "business_service", 4001},
		{"application", 1101, "application_service", 4101},
	} {
		row := cimodel.LayerMapping{
			Batch: "service-layers", SourceModel: mapping.sourceModel, SourceCIID: mapping.sourceCI,
			TargetModel: mapping.targetModel, TargetCIID: mapping.targetCI,
		}
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed mapping %+v: %v", mapping, err)
		}
	}
	inferred := cimodel.Relation{FirstCIID: 4001, SecondCIID: 4101, RelationTypeID: 51, EvidenceSource: "inference"}
	if err := db.Create(&inferred).Error; err != nil {
		t.Fatalf("seed inferred edge: %v", err)
	}
	foreign := cimodel.Relation{FirstCIID: 4001, SecondCIID: 9999, RelationTypeID: 51, EvidenceSource: "manual"}
	if err := db.Create(&foreign).Error; err != nil {
		t.Fatalf("seed foreign edge: %v", err)
	}

	repo := NewRepo(db)
	uc := cibiz.NewUsecase(repo, nil, nil).WithServiceLayerRollback(repo)
	ctx := context.Background()

	blocked, err := uc.RollbackServiceLayers(ctx, cibiz.ServiceLayerRollbackInput{})
	if err != nil {
		t.Fatalf("blocked rollback: %v", err)
	}
	if len(blocked.Blocked) != 1 || blocked.DeletedTargets != 0 || blocked.DeletedMappings != 0 {
		t.Fatalf("blocked report = %+v", blocked)
	}
	if err := db.First(&cimodel.CI{}, 4001).Error; err != nil {
		t.Fatalf("the blocked rollback deleted a target: %v", err)
	}

	// The operator resolved the foreign relation; the rollback may proceed.
	if err := db.Delete(&foreign).Error; err != nil {
		t.Fatalf("remove foreign edge: %v", err)
	}
	dry, err := uc.RollbackServiceLayers(ctx, cibiz.ServiceLayerRollbackInput{DryRun: true})
	if err != nil {
		t.Fatalf("dry rollback: %v", err)
	}
	if len(dry.Blocked) != 0 || dry.Mappings != 2 || dry.Targets != 2 || dry.InferredEdges != 1 ||
		dry.DeletedTargets != 0 || dry.DeletedMappings != 0 {
		t.Fatalf("dry report = %+v", dry)
	}
	if err := db.First(&cimodel.CI{}, 4001).Error; err != nil {
		t.Fatalf("the dry rollback deleted a target: %v", err)
	}

	report, err := uc.RollbackServiceLayers(ctx, cibiz.ServiceLayerRollbackInput{})
	if err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if len(report.Blocked) != 0 || report.DeletedTargets != 2 || report.DeletedMappings != 2 {
		t.Fatalf("report = %+v", report)
	}
	for _, id := range []model.ID{4001, 4101} {
		if err := db.First(&cimodel.CI{}, id).Error; !errors.Is(err, gorm.ErrRecordNotFound) {
			t.Fatalf("target %d still live: %v", id, err)
		}
	}
	var liveMappings int64
	db.Model(&cimodel.LayerMapping{}).Where("batch = ?", "service-layers").Count(&liveMappings)
	if liveMappings != 0 {
		t.Fatalf("live mappings = %d", liveMappings)
	}
	var liveContains int64
	db.Model(&cimodel.Relation{}).Where("relation_type_id = ?", 51).Count(&liveContains)
	if liveContains != 0 {
		t.Fatalf("live CONTAINS edges = %d", liveContains)
	}

	again, err := uc.RollbackServiceLayers(ctx, cibiz.ServiceLayerRollbackInput{})
	if err != nil {
		t.Fatalf("second rollback: %v", err)
	}
	if again.Mappings != 0 || again.Targets != 0 || again.DeletedTargets != 0 || again.DeletedMappings != 0 {
		t.Fatalf("second report = %+v, want an idempotent no-op", again)
	}
}
