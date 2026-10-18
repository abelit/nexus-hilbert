package ci

import (
	"context"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
)

// WriteRepo is the port's transactional write half.
//
// IT EXISTS SEPARATELY FROM Repo BECAUSE IT IS A DIFFERENT KIND OF OPERATION.
// Everything else in Repo takes values the caller has already decided; WriteCI
// takes a DECISION PROCEDURE — "find the instance with this unique value and
// then create or update according to this policy" — and runs it as one
// transaction. The distinction is the whole reason the interface is shaped this
// way: a caller that could run the lookup itself would put a gap between the
// check and the write, and no later care could close it.
type WriteRepo interface {
	// WriteCI resolves the unique value against the model's instances and
	// creates or updates according to the policy, in ONE transaction that also
	// holds a per-model lock.
	//
	// The lock is what makes the lookup meaningful. c_cis has no unique index
	// over the EAV values — it cannot, the value that identifies an instance
	// lives in a typed table chosen by the attribute's definition — so nothing
	// in the schema can refuse a duplicate. cantor serialised the whole
	// operation with a Redis lock keyed on the model's name; the port takes the
	// equivalent row lock on the model, which MySQL honours as SELECT ... FOR
	// UPDATE and SQLite provides for free by serialising writers.
	WriteCI(ctx context.Context, in WriteSpec) (*WriteResult, error)
}

// WriteSpec is everything one instance write needs, including the policy.
type WriteSpec struct {
	// TypeRef is the model's NAME, carried for the error messages: a caller
	// that has just resolved the model has the name in hand, and looking it up
	// again inside the transaction only to phrase an error is waste.
	TypeRef string
	TypeID  model.ID

	UniqueAttrID model.ID

	// UniqueValue is the value that identifies the instance, already resolved
	// (including any default) by the caller — resolution needs the attribute
	// set, which the caller has and this layer does not.
	UniqueValue any

	Policy ExistPolicy

	Specs  map[model.ID]AttributeSpec
	Values map[model.ID]any
	Audit  AuditInfo

	// ValidatingID, when set, is the instance being UPDATED, so a rule that
	// has to compare a row against its peers can leave the row itself out.
	// cantor's subnet update passed its own id for exactly this.
	ValidatingID model.ID

	// Parent, when set, is the instance the new one is contained by: the edge
	// is written in the SAME transaction as the insert.
	//
	// IT APPLIES ONLY WHEN THE INSTANCE IS CREATED. A write that found an
	// existing instance by its unique value is an update, and re-parenting an
	// instance as a side effect of re-submitting its values would silently move
	// it — which is a deliberate operation with an endpoint of its own
	// (the data-centre module's device migration).
	//
	// A CONTAINED INSTANCE THAT IS NOT CONTAINED IS NOT A STATE ANYTHING CAN
	// USE. cantor created the instance and then related it, in two
	// transactions, so a refusal on the relation left a node with no parent:
	// invisible in the tree, unreachable from the room that was supposed to
	// hold it, and indistinguishable from a root.
	Parent *ParentLink
}

// Reader is the read half of the port: what the list, detail and export paths
// need, none of which mutates anything.
type Reader interface {
	// LoadCI returns a CI by id, or nil.
	LoadCI(ctx context.Context, ciID model.ID) (*cimodel.CI, error)

	// ListCIsByType returns a page of the model's instances, newest id first,
	// with the total count before paging.
	ListCIsByType(ctx context.Context, typeID model.ID, limit, offset int) ([]cimodel.CI, int64, error)

	// ValueRowsForCIs returns every value row for the given instances, keyed by
	// instance id. One query for the whole page rather than one per row: a page
	// of a hundred instances over two hundred attributes is the difference
	// between three queries and three hundred.
	ValueRowsForCIs(ctx context.Context, ciIDs []model.ID) (map[model.ID][]ValueRow, error)

	// ValuesForAttribute returns ONE attribute's stored values for a set of
	// instances, keyed by instance id and ordered by row id.
	//
	// IT EXISTS BESIDE ValueRowsForCIs BECAUSE OF WHAT A TREE READ ASKS FOR. A
	// tree labels every node with TWO attributes — its model's display name and
	// its identifier — while ValueRowsForCIs loads EVERY attribute of those
	// instances. On a fifty-attribute model that is twenty-five times the rows
	// needed, on the one read whose node count is largest.
	ValuesForAttribute(ctx context.Context, attrID model.ID, ciIDs []model.ID) (map[model.ID][]ValueRow, error)

	// CountCIsByType returns how many live instances a model has.
	CountCIsByType(ctx context.Context, typeID model.ID) (int64, error)
}
