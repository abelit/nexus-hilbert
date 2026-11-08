package citype

import (
	"context"
	"fmt"

	cibiz "github.com/ongridio/ongrid/internal/cmdb/biz/ci"
	model "github.com/ongridio/ongrid/internal/cmdb/model"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// Creating the models a feature addresses by name.
//
// NOTHING IN THE PRODUCT DOES THIS. cantor's deployment either had `dcim_rack`
// or its DCIM pages answered 404, and the model names were tribal knowledge —
// four names, a dozen attributes and which of them are numeric, none of it
// written down anywhere a fresh install could find. The port keeps resolving
// them by name, so this exists to make the names reachable.
//
// IT IS AN EXPLICIT ACTION, NOT A STARTUP SIDE EFFECT. ADMINS.md's rule is that
// a migration is something an operator runs and can roll back; creating models
// during startup would put rows in a database from a code path nobody chose and
// nobody can see. This is the opposite: one call, one report, and it never
// MODIFIES anything — an existing model is left exactly as it is, however it is
// configured.

// BuiltinModelResult is what a bootstrap created and what it left alone.
type BuiltinModelResult struct {
	// Created are the models and attributes this call added.
	Created []string

	// Existing are the models and attributes that were already there. They are
	// reported rather than counted because a model that exists with the wrong
	// attributes is the case an operator has to look at, and "12 skipped" says
	// nothing about which.
	Existing []string
}

// EnsureBuiltinModels creates the named models and attributes if they are
// absent, and changes nothing that exists.
//
// THE ATTRIBUTE DICTIONARY IS SHARED, so an attribute is created once and
// bound to each model that needs it — the same `u_count` serves a rack and a
// device. A deployment that already has one of these attributes bound to its
// own models keeps it: the bootstrap reads the dictionary before writing.
//
// AN UNBOUND ATTRIBUTE IS STILL CREATED. A device model needs `u_start` and
// `u_count`, and which models are devices is the deployment's decision — so the
// dictionary entries are made and left for the model configuration page, rather
// than being bound to models a bootstrap invented.
func (u *Usecase) EnsureBuiltinModels(ctx context.Context, in BuiltinEnsureInput) (*BuiltinModelResult, error) {
	if u.repo == nil {
		return nil, errs.ErrNotWiredYet
	}
	out := &BuiltinModelResult{Created: []string{}, Existing: []string{}}

	// The unbound device-side attributes first, so a later model's binding can
	// find them.
	for _, spec := range cibiz.BuiltinDeviceAttributes() {
		if _, err := u.ensureAttribute(ctx, spec, in.Actor, out); err != nil {
			return nil, err
		}
	}

	for _, spec := range in.Models {
		// THE ATTRIBUTES COME FIRST, because a model's identifying attribute
		// has to exist before the model can name it — the create path resolves
		// the key against the dictionary and refuses one that is not there.
		attrIDs := make([]model.ID, 0, len(spec.Attributes))
		for _, attr := range spec.Attributes {
			id, err := u.ensureAttribute(ctx, attr, in.Actor, out)
			if err != nil {
				return nil, err
			}
			attrIDs = append(attrIDs, id)
		}

		view, err := u.GetByRef(ctx, spec.Name)
		if err != nil {
			return nil, err
		}
		if view != nil {
			out.Existing = append(out.Existing, "model "+spec.Name)
		} else {
			if _, err := u.Create(ctx, CreateInput{
				Name:      spec.Name,
				Alias:     spec.Alias,
				UniqueKey: spec.UniqueKey,
				Actor:     in.Actor,
			}); err != nil {
				return nil, fmt.Errorf("create the built-in model %s: %w", spec.Name, err)
			}
			out.Created = append(out.Created, "model "+spec.Name)
		}
		// Binding is idempotent, so this is a no-op for a model that already
		// carries them — and it is what makes a model that exists with only
		// SOME of them still usable, because the missing ones are added and the
		// model's own configuration is untouched.
		if _, err := u.BindAttributes(ctx, BindAttributesInput{
			TypeRef: spec.Name, AttrIDs: attrIDs, Actor: in.Actor,
		}); err != nil {
			return nil, fmt.Errorf("bind the built-in attributes of %s: %w", spec.Name, err)
		}
	}

	for _, spec := range in.Relations {
		if err := u.ensureBuiltinRelation(ctx, spec, in.Actor, out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// ensureBuiltinRelation creates one model relation if the pair has no live rule.
// It NEVER edits an existing rule: the operator's cardinality, relation type
// and attribute mapping are left exactly as they are.
func (u *Usecase) ensureBuiltinRelation(ctx context.Context, spec cibiz.BuiltinRelationSpec, actor model.ID, out *BuiltinModelResult) error {
	parent, err := u.GetByRef(ctx, spec.ParentModel)
	if err != nil {
		return err
	}
	if parent == nil {
		return fmt.Errorf("%w: parent model %q", errs.ErrNotFound, spec.ParentModel)
	}
	child, err := u.GetByRef(ctx, spec.ChildModel)
	if err != nil {
		return err
	}
	if child == nil {
		return fmt.Errorf("%w: child model %q", errs.ErrNotFound, spec.ChildModel)
	}
	vocab, ok := cibiz.TargetRelationType(spec.RelationTypeName)
	if !ok {
		return fmt.Errorf("built-in relation type %q is not in the target vocabulary", spec.RelationTypeName)
	}
	rt, err := u.repo.EnsureRelationType(ctx, vocab)
	if err != nil {
		return err
	}
	existing, err := u.repo.TypeRelationByPair(ctx, parent.Type.ID, child.Type.ID)
	if err != nil {
		return err
	}
	label := "relation " + spec.ParentModel + "->" + spec.ChildModel
	if existing != nil {
		out.Existing = append(out.Existing, label)
		return nil
	}
	if _, err := u.SaveTypeRelation(ctx, TypeRelationInput{
		ParentRef: spec.ParentModel, ChildRef: spec.ChildModel,
		RelationTypeID: rt.ID,
		Constraint:     string(spec.Constraint),
		AllowSelf:      spec.AllowSelf,
		Actor:          actor,
	}); err != nil {
		return fmt.Errorf("create the built-in relation %s: %w", label, err)
	}
	out.Created = append(out.Created, label)
	return nil
}

// BuiltinEnsureInput is one bootstrap request.
type BuiltinEnsureInput struct {
	// Models are the models to create. The caller supplies them rather than
	// this package knowing which feature wants which, so the vocabulary stays
	// with the feature that resolves it.
	Models []cibiz.BuiltinModelSpec

	// Relations are the model relations the feature needs. An existing rule is
	// reported and left untouched.
	Relations []cibiz.BuiltinRelationSpec

	Actor model.ID
}

// ensureAttribute creates one dictionary entry if it is absent and returns its
// id.
//
// ABSENCE IS ASKED OF THE REPOSITORY rather than of GetAttribute, which reports
// a missing attribute as an error because a caller asking for one by name has
// asked for something that is not there. Here the absence is the expected case.
func (u *Usecase) ensureAttribute(ctx context.Context, spec cibiz.BuiltinAttributeSpec, actor model.ID, out *BuiltinModelResult) (model.ID, error) {
	existing, err := u.resolveAttribute(ctx, spec.Name)
	if err != nil {
		return 0, err
	}
	if existing != nil {
		out.Existing = append(out.Existing, "attribute "+spec.Name)
		return existing.ID, nil
	}
	created, err := u.CreateAttribute(ctx, CreateAttributeInput{
		Name:      spec.Name,
		Alias:     spec.Name,
		ValueType: spec.ValueType,
		IsIndex:   spec.IsIndex,
		IsUnique:  spec.IsUnique,
		Actor:     actor,
	})
	if err != nil {
		return 0, fmt.Errorf("create the built-in attribute %s: %w", spec.Name, err)
	}
	out.Created = append(out.Created, "attribute "+spec.Name)
	return created.ID, nil
}
