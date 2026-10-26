// Package topology holds the saved topology views.
//
// A VIEW IS A SAVED WALK, not a saved graph: it names a model, a query that
// selects its roots, and the relation levels to follow below (+) and above (-)
// them. The graph is assembled from the current relations every time it is
// opened, so a view does not go stale when an instance or an edge changes.
package topology

import (
	cmdbmodel "github.com/ongridio/ongrid/internal/cmdb/model"
)

// ViewGroup is a sidebar folder (c_topology_view_groups).
type ViewGroup struct {
	cmdbmodel.Base

	Name  string `gorm:"column:name;size:64;index:idx_c_topology_view_groups_name"`
	Order int    `gorm:"column:order;not null;default:0"`
}

func (ViewGroup) TableName() string { return "c_topology_view_groups" }

// View is one saved topology view (c_topology_views).
type View struct {
	cmdbmodel.Base

	Name string `gorm:"column:name;size:64;index:idx_c_topology_views_name"`

	GroupID *cmdbmodel.ID `gorm:"column:group_id;index:idx_c_topology_views_group_id"`

	Category string `gorm:"column:category;size:32"`

	// CentralNodeType is the model the roots belong to.
	CentralNodeType *cmdbmodel.ID `gorm:"column:central_node_type"`

	// CentralNodeInstances is the root query. cantor stored a query-language
	// expression here, optionally prefixed with `q=`.
	CentralNodeInstances string `gorm:"column:central_node_instances;type:text"`

	// Path maps a level to the model ids allowed at it. Positive levels walk
	// down from the roots, negative levels walk up.
	Path map[string][]cmdbmodel.ID `gorm:"column:path;serializer:json"`

	Order int `gorm:"column:order;not null;default:0"`

	// Option is the console's layout data.
	Option map[string]any `gorm:"column:option;serializer:json"`
}

func (View) TableName() string { return "c_topology_views" }
