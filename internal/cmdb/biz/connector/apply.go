// Package connector applies a read-only relation projection plan to a target
// ontology. It owns the ordering, preflight and idempotency contract; the
// transport (topocortex HTTP) is a Target implementation.
package connector

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"

	"github.com/ongridio/ongrid/internal/cmdb/biz/relationmap"
)

var (
	// ErrPlanBlocked refuses an apply while the dry-run still has unresolved or
	// review rows.
	ErrPlanBlocked = errors.New("cmdb connector: projection plan is blocked")
	// ErrClassMappingMissing refuses an apply whose CMDB model has no target
	// class. A partial mapping is not silently treated as identity.
	ErrClassMappingMissing = errors.New("cmdb connector: target class mapping is missing")
	// ErrConflictingTypeMetadata refuses one target type proposed with two
	// different category/traits/transitive/sub-property sets.
	ErrConflictingTypeMetadata = errors.New("cmdb connector: conflicting target relation type metadata")
	// ErrInvalidMapping refuses a mapping the target could never accept.
	ErrInvalidMapping = errors.New("cmdb connector: invalid relation mapping")
)

// Declaration is one topocortex relation declaration to ensure.
type Declaration struct {
	RelationType string  `json:"relation_type"`
	SourceClass  string  `json:"source_class"`
	TargetClass  string  `json:"target_class"`
	Cardinality  string  `json:"cardinality,omitempty"`
	Propagates   bool    `json:"propagates"`
	Weight       float64 `json:"weight"`
}

// RelationType is the type-level metadata to ensure after its declarations
// exist. Display text stays topocortex-owned; this carries the AIOps contract.
type RelationType struct {
	Name          string   `json:"name"`
	Category      string   `json:"category,omitempty"`
	Traits        []string `json:"traits,omitempty"`
	Transitive    bool     `json:"transitive,omitempty"`
	SubPropertyOf []string `json:"sub_property_of,omitempty"`
}

// Target is the ontology write port. Implementations must be idempotent:
// EnsureRelationDeclaration returns created=false when the triple already
// exists and the desired fields are already in place.
type Target interface {
	EnsureRelationDeclaration(ctx context.Context, decl Declaration) (created bool, err error)
	EnsureRelationType(ctx context.Context, typ RelationType) error
}

// Options configures one apply.
type Options struct {
	Target Target
	// ClassMapping maps a CMDB model name to the topocortex class name. Nil
	// means identity. When non-nil, every referenced model must be present.
	ClassMapping map[string]string
}

// Report is the apply result. A non-nil report with a non-nil error describes
// the writes that were committed before the failure; the API is not
// transactional across declarations.
type Report struct {
	Declarations        int `json:"declarations"`
	DeclarationsCreated int `json:"declarations_created"`
	DeclarationsUpdated int `json:"declarations_updated"`
	RelationTypes       int `json:"relation_types"`
}

type prepared struct {
	declaration  Declaration
	relationType RelationType
}

// Apply preflights the whole plan, then writes declarations and finally type
// metadata. Preflight covers class mapping, cardinality, propagation and
// type-metadata conflicts, so an obvious mistake cannot leave a half-applied
// projection.
func Apply(ctx context.Context, plan relationmap.Report, opts Options) (*Report, error) {
	if opts.Target == nil {
		return nil, fmt.Errorf("%w: target is nil", ErrInvalidMapping)
	}
	if plan.Blocked {
		return nil, fmt.Errorf("%w: unresolved=%d review=%d",
			ErrPlanBlocked, plan.UnresolvedRules, plan.ReviewRules)
	}

	preparedMappings, types, err := prepare(plan, opts.ClassMapping)
	if err != nil {
		return nil, err
	}

	report := &Report{Declarations: len(preparedMappings), RelationTypes: len(types)}
	for _, item := range preparedMappings {
		created, err := opts.Target.EnsureRelationDeclaration(ctx, item.declaration)
		if err != nil {
			return report, fmt.Errorf("apply %s %s->%s: %w",
				item.declaration.RelationType, item.declaration.SourceClass,
				item.declaration.TargetClass, err)
		}
		if created {
			report.DeclarationsCreated++
		} else {
			report.DeclarationsUpdated++
		}
	}

	names := make([]string, 0, len(types))
	for name := range types {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if err := opts.Target.EnsureRelationType(ctx, types[name]); err != nil {
			return report, fmt.Errorf("apply relation type %s: %w", name, err)
		}
	}
	return report, nil
}

func prepare(plan relationmap.Report, classMapping map[string]string) ([]prepared, map[string]RelationType, error) {
	out := make([]prepared, 0, len(plan.Mappings))
	types := make(map[string]RelationType)

	for _, mapping := range plan.Mappings {
		if mapping.Unresolved != "" {
			return nil, nil, fmt.Errorf("%w: %s %s->%s: %s",
				ErrPlanBlocked, mapping.SourceType, mapping.ParentModel,
				mapping.ChildModel, mapping.Unresolved)
		}
		if mapping.Review {
			return nil, nil, fmt.Errorf("%w: %s %s->%s needs review",
				ErrPlanBlocked, mapping.SourceType, mapping.ParentModel, mapping.ChildModel)
		}
		if mapping.TargetType == "" {
			return nil, nil, fmt.Errorf("%w: %s %s->%s has no target type",
				ErrInvalidMapping, mapping.SourceType, mapping.ParentModel, mapping.ChildModel)
		}
		if !knownCardinality(mapping.Cardinality) {
			return nil, nil, fmt.Errorf("%w: %s has cardinality %q",
				ErrInvalidMapping, mapping.SourceType, mapping.Cardinality)
		}
		if mapping.Propagates && mapping.Weight <= 0 {
			return nil, nil, fmt.Errorf("%w: %s propagates with weight %v",
				ErrInvalidMapping, mapping.SourceType, mapping.Weight)
		}

		parent, err := resolveClass(mapping.ParentModel, classMapping)
		if err != nil {
			return nil, nil, err
		}
		child, err := resolveClass(mapping.ChildModel, classMapping)
		if err != nil {
			return nil, nil, err
		}

		source, target := parent, child
		if mapping.Invert {
			source, target = child, parent
		}
		declaration := Declaration{
			RelationType: mapping.TargetType,
			SourceClass:  source,
			TargetClass:  target,
			Cardinality:  mapping.Cardinality,
			Propagates:   mapping.Propagates,
			Weight:       mapping.Weight,
		}
		relationType := RelationType{
			Name:          mapping.TargetType,
			Category:      mapping.Category,
			Traits:        append([]string(nil), mapping.Traits...),
			Transitive:    mapping.Transitive,
			SubPropertyOf: append([]string(nil), mapping.SubPropertyOf...),
		}
		if existing, ok := types[relationType.Name]; ok {
			if !sameRelationType(existing, relationType) {
				return nil, nil, fmt.Errorf("%w: %s",
					ErrConflictingTypeMetadata, relationType.Name)
			}
		} else {
			types[relationType.Name] = relationType
		}
		out = append(out, prepared{declaration: declaration, relationType: relationType})
	}
	return out, types, nil
}

func resolveClass(model string, mapping map[string]string) (string, error) {
	if mapping == nil {
		if model == "" {
			return "", fmt.Errorf("%w: empty model name", ErrInvalidMapping)
		}
		return model, nil
	}
	class, ok := mapping[model]
	if !ok || class == "" {
		return "", fmt.Errorf("%w: %s", ErrClassMappingMissing, model)
	}
	return class, nil
}

func knownCardinality(cardinality string) bool {
	switch cardinality {
	case "", "1:1", "1:N", "N:1", "N:M":
		return true
	default:
		return false
	}
}

func sameRelationType(left, right RelationType) bool {
	return left.Category == right.Category &&
		left.Transitive == right.Transitive &&
		slices.Equal(left.Traits, right.Traits) &&
		slices.Equal(left.SubPropertyOf, right.SubPropertyOf)
}
