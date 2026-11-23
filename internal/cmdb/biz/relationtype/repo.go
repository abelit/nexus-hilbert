// Package relationtype implements the CMDB relation-type dictionary: the
// "runs on / belongs to / connects to" vocabulary shared by model-level
// relations and CI instance relations.
//
// It is the smallest entity in the CMDB (a name and a colour), which makes it
// the module that proves the server -> biz -> data -> model path end to end
// before the larger modules are built on it.
package relationtype

import (
	"context"

	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
)

// Usage is the reference count that guards deletion. ModelRules and
// InstanceEdges are live references and block deletion; HistoryRows is reported
// for audit visibility but does not block, because history is evidence rather
// than a live use.
type Usage struct {
	ModelRules    int64 `json:"model_rules"`
	InstanceEdges int64 `json:"instance_edges"`
	HistoryRows   int64 `json:"history_rows"`
}

// LiveReferences is the number of rows that make deleting the type unsafe.
func (u Usage) LiveReferences() int64 {
	return u.ModelRules + u.InstanceEdges
}

// Repo is the consumer-side persistence port for relation types.
type Repo interface {
	// List returns every live relation type ordered by id.
	List(ctx context.Context) ([]citypemodel.RelationType, error)

	// Get returns one by id, or nil when it does not exist.
	Get(ctx context.Context, id int32) (*citypemodel.RelationType, error)

	// FindByName returns the live relation type with this exact name, or nil.
	// Names are matched exactly, matching cantor's `get_by(name=...)`.
	FindByName(ctx context.Context, name string) (*citypemodel.RelationType, error)

	// Create inserts a relation type.
	Create(ctx context.Context, rt *citypemodel.RelationType) error

	// Update writes name and colour of an existing row.
	Update(ctx context.Context, rt *citypemodel.RelationType) error

	// Usage counts the live model rules, live instance edges and history rows
	// that reference a relation type.
	Usage(ctx context.Context, id int32) (Usage, error)

	// SoftDelete marks a relation type deleted.
	SoftDelete(ctx context.Context, id int32) error
}
