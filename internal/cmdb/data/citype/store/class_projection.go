package store

import (
	"context"
	"fmt"

	"gorm.io/gorm"

	"github.com/ongridio/ongrid/internal/cmdb/biz/classmap"
	model "github.com/ongridio/ongrid/internal/cmdb/model"
)

type classTypeRow struct {
	ID       model.ID  `gorm:"column:id"`
	Name     string    `gorm:"column:name"`
	Alias    string    `gorm:"column:alias"`
	UniqueID model.ID  `gorm:"column:unique_id"`
	ShowID   *model.ID `gorm:"column:show_id"`
	Enabled  bool      `gorm:"column:enabled"`
}

type classAttrRow struct {
	TypeID      model.ID `gorm:"column:type_id"`
	AttrID      model.ID `gorm:"column:attr_id"`
	Name        string   `gorm:"column:name"`
	ValueType   string   `gorm:"column:value_type"`
	IsList      bool     `gorm:"column:is_list"`
	IsRequired  bool     `gorm:"column:is_required"`
	IsUnique    bool     `gorm:"column:is_unique"`
	IsIndex     bool     `gorm:"column:is_index"`
	IsPassword  bool     `gorm:"column:is_password"`
	IsFile      bool     `gorm:"column:is_file"`
	IsLink      bool     `gorm:"column:is_link"`
	IsReference bool     `gorm:"column:is_reference"`
	IsChoice    bool     `gorm:"column:is_choice"`
	IsComputed  bool     `gorm:"column:is_computed"`
}

type classInheritanceRow struct {
	ParentID model.ID `gorm:"column:parent_id"`
	ChildID  model.ID `gorm:"column:child_id"`
}

// PlanClassProjection is the read-only dry run for projecting CMDB CI types and
// their own attributes into topocortex classes. It writes nothing.
func PlanClassProjection(
	ctx context.Context,
	db *gorm.DB,
	classMapping map[string]string,
	profiles map[string]classmap.Profile,
) (*classmap.Report, error) {
	if db == nil {
		return nil, errNilDB
	}

	var typeRows []classTypeRow
	if err := db.WithContext(ctx).
		Table("c_ci_types").
		Select("id, name, alias, unique_id, show_id, enabled").
		Where("delete_marker = 0 AND deleted_at IS NULL").
		Order("id").
		Scan(&typeRows).Error; err != nil {
		return nil, fmt.Errorf("cmdb citype: plan class projection: types: %w", err)
	}

	var attrRows []classAttrRow
	if err := db.WithContext(ctx).
		Table("c_ci_type_attributes AS b").
		Select(
			"b.type_id, a.id AS attr_id, a.name, a.value_type, a.is_list, " +
				"b.is_required, a.is_unique, a.is_index, a.is_password, a.is_file, " +
				"a.is_link, a.is_reference, a.is_choice, a.is_computed",
		).
		Joins("JOIN c_attributes a ON a.id = b.attr_id AND a.delete_marker = 0 AND a.deleted_at IS NULL").
		Where("b.delete_marker = 0 AND b.deleted_at IS NULL").
		Order("b.type_id, b.`order`, a.id").
		Scan(&attrRows).Error; err != nil {
		return nil, fmt.Errorf("cmdb citype: plan class projection: attributes: %w", err)
	}

	var inheritance []classInheritanceRow
	if err := db.WithContext(ctx).
		Table("c_ci_type_inheritance").
		Select("parent_id, child_id").
		Where("delete_marker = 0 AND deleted_at IS NULL").
		Scan(&inheritance).Error; err != nil {
		return nil, fmt.Errorf("cmdb citype: plan class projection: inheritance: %w", err)
	}

	typesByID := make(map[model.ID]classmap.Type, len(typeRows))
	attrNamesByID := make(map[model.ID]string)
	for _, row := range typeRows {
		typesByID[row.ID] = classmap.Type{
			Name: row.Name, Alias: row.Alias, Enabled: row.Enabled,
		}
	}
	attrsByType := make(map[model.ID][]classmap.Attribute)
	for _, row := range attrRows {
		attrNamesByID[row.AttrID] = row.Name
		attrsByType[row.TypeID] = append(attrsByType[row.TypeID], classmap.Attribute{
			Name: row.Name, ValueType: row.ValueType, IsList: row.IsList,
			IsRequired: row.IsRequired, IsUnique: row.IsUnique, IsIndex: row.IsIndex,
			IsPassword: row.IsPassword, IsFile: row.IsFile, IsLink: row.IsLink,
			IsReference: row.IsReference, IsChoice: row.IsChoice, IsComputed: row.IsComputed,
		})
	}
	parentsByType := make(map[model.ID][]string)
	for _, row := range inheritance {
		parent, ok := typesByID[row.ParentID]
		if !ok {
			continue
		}
		parentsByType[row.ChildID] = append(parentsByType[row.ChildID], parent.Name)
	}

	types := make([]classmap.Type, 0, len(typeRows))
	for _, row := range typeRows {
		typ := typesByID[row.ID]
		typ.Attributes = attrsByType[row.ID]
		typ.Parents = parentsByType[row.ID]
		typ.UniqueAttr = attrNamesByID[row.UniqueID]
		if row.ShowID != nil {
			typ.ShowAttr = attrNamesByID[*row.ShowID]
		}
		types = append(types, typ)
	}

	report := classmap.Plan(types, classMapping, profiles)
	return &report, nil
}
