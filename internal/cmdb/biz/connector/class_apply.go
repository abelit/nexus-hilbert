package connector

import (
	"context"
	"fmt"
	"sort"

	"github.com/ongridio/ongrid/internal/cmdb/biz/classmap"
)

// ClassTarget is the class write port. EnsureClass is idempotent: it creates
// the class when absent and updates metadata/attributes when present.
type ClassTarget interface {
	EnsureClass(ctx context.Context, class classmap.Class) (created bool, err error)
}

// ClassApplyReport is the class apply result. The API is not transactional
// across classes; a non-nil report with a non-nil error names what was written
// before the failure.
type ClassApplyReport struct {
	Classes int `json:"classes"`
	Created int `json:"created"`
	Updated int `json:"updated"`
}

// ApplyClasses preflights the whole plan, then writes classes in inheritance
// order so a child never precedes its parent.
func ApplyClasses(ctx context.Context, plan classmap.Report, target ClassTarget) (*ClassApplyReport, error) {
	if target == nil {
		return nil, fmt.Errorf("%w: class target is nil", ErrInvalidMapping)
	}
	if plan.Blocked {
		return nil, fmt.Errorf("%w: unresolved=%d review=%d",
			ErrPlanBlocked, plan.Unresolved, plan.Review)
	}

	for _, mapping := range plan.Mappings {
		if mapping.Unresolved != "" {
			return nil, fmt.Errorf("%w: %s: %s",
				ErrPlanBlocked, mapping.SourceModel, mapping.Unresolved)
		}
		if mapping.Review {
			return nil, fmt.Errorf("%w: %s needs review", ErrPlanBlocked, mapping.SourceModel)
		}
		if mapping.Class.ClassName == "" {
			return nil, fmt.Errorf("%w: %s has no target class name",
				ErrInvalidMapping, mapping.SourceModel)
		}
	}

	ordered, err := classesInInheritanceOrder(plan.Mappings)
	if err != nil {
		return nil, err
	}

	report := &ClassApplyReport{Classes: len(ordered)}
	for _, mapping := range ordered {
		created, err := target.EnsureClass(ctx, mapping.Class)
		if err != nil {
			return report, fmt.Errorf("apply class %s: %w", mapping.Class.ClassName, err)
		}
		if created {
			report.Created++
		} else {
			report.Updated++
		}
	}
	return report, nil
}

func classesInInheritanceOrder(mappings []classmap.Mapping) ([]classmap.Mapping, error) {
	byName := make(map[string]classmap.Mapping, len(mappings))
	for _, mapping := range mappings {
		if _, duplicate := byName[mapping.Class.ClassName]; duplicate {
			return nil, fmt.Errorf("%w: duplicate class %q", ErrInvalidMapping, mapping.Class.ClassName)
		}
		byName[mapping.Class.ClassName] = mapping
	}

	depths := make(map[string]int, len(mappings))
	var depth func(name string, visiting map[string]struct{}) (int, error)
	depth = func(name string, visiting map[string]struct{}) (int, error) {
		if value, ok := depths[name]; ok {
			return value, nil
		}
		if _, cycle := visiting[name]; cycle {
			return 0, fmt.Errorf("%w: class inheritance cycle at %q", ErrInvalidMapping, name)
		}
		mapping, ok := byName[name]
		if !ok {
			return 0, fmt.Errorf("%w: class %q is not in the plan", ErrInvalidMapping, name)
		}
		visiting[name] = struct{}{}
		defer delete(visiting, name)
		parent := mapping.Class.ParentClass
		if parent == "" {
			depths[name] = 0
			return 0, nil
		}
		if _, external := byName[parent]; !external {
			// An external parent must already exist in topocortex; it does not
			// constrain this plan's ordering.
			depths[name] = 0
			return 0, nil
		}
		parentDepth, err := depth(parent, visiting)
		if err != nil {
			return 0, err
		}
		depths[name] = parentDepth + 1
		return parentDepth + 1, nil
	}

	out := make([]classmap.Mapping, len(mappings))
	copy(out, mappings)
	sort.SliceStable(out, func(i, j int) bool {
		left, _ := depth(out[i].Class.ClassName, map[string]struct{}{})
		right, _ := depth(out[j].Class.ClassName, map[string]struct{}{})
		if left != right {
			return left < right
		}
		return out[i].Class.ClassName < out[j].Class.ClassName
	})
	// Surface a cycle even when the first pass happened not to reach it.
	for _, mapping := range out {
		if _, err := depth(mapping.Class.ClassName, map[string]struct{}{}); err != nil {
			return nil, err
		}
	}
	return out, nil
}
