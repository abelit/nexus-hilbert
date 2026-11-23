// Package relationmap builds the read-only plan that projects CMDB model rules
// into nexus-topocortex relation declarations. It writes nothing and does not
// call the ontology API; it turns (rule, relation-type semantics) into a
// deterministic mapping an operator or connector can review first.
package relationmap

import "fmt"

// TypeSemantics is the subset of a CMDB relation type the projection needs.
type TypeSemantics struct {
	Name               string   `json:"name"`
	OntologyReady      bool     `json:"ontology_ready"`
	TopocortexCategory string   `json:"topocortex_category"`
	Traits             []string `json:"traits,omitempty"`
	InverseOf          string   `json:"inverse_of,omitempty"`
	Transitive         bool     `json:"transitive,omitempty"`
	SubPropertyOf      []string `json:"sub_property_of,omitempty"`
	PropagatesDefault  bool     `json:"propagates_default"`
	WeightDefault      float64  `json:"weight_default"`
	Deprecated         bool     `json:"deprecated,omitempty"`
	Replacement        string   `json:"replacement,omitempty"`
}

// Rule is one live CMDB model relation with the number of live instance edges
// recorded under it.
type Rule struct {
	RelationType string `json:"relation_type"`
	ParentModel  string `json:"parent_model"`
	ChildModel   string `json:"child_model"`
	// Constraint is the CMDB cardinality code: "0" one2many, "1" one2one,
	// "2" many2many, empty means the default one2many.
	Constraint string `json:"constraint"`
	EdgeCount  int64  `json:"edge_count"`
}

// Override is the per-pair escape hatch. The key is
// (SourceType, ParentModel, ChildModel); empty fields fall back to the
// type-level projection. Review marks a pair a human must confirm before the
// connector may apply it.
type Override struct {
	SourceType  string
	ParentModel string
	ChildModel  string

	TargetType  string
	Invert      *bool
	Cardinality string
	Propagates  *bool
	Weight      *float64

	Review bool
	Note   string
}

// Mapping is one proposed topocortex declaration for one CMDB rule.
type Mapping struct {
	SourceType    string   `json:"source_type"`
	ParentModel   string   `json:"parent_model"`
	ChildModel    string   `json:"child_model"`
	TargetType    string   `json:"target_type"`
	Invert        bool     `json:"invert"`
	Cardinality   string   `json:"cardinality"`
	Propagates    bool     `json:"propagates"`
	Weight        float64  `json:"weight"`
	Category      string   `json:"category,omitempty"`
	Traits        []string `json:"traits,omitempty"`
	Transitive    bool     `json:"transitive,omitempty"`
	SubPropertyOf []string `json:"sub_property_of,omitempty"`
	Review        bool     `json:"review,omitempty"`
	Note          string   `json:"note,omitempty"`
	Unresolved    string   `json:"unresolved,omitempty"`
	Sample        string   `json:"sample,omitempty"`
}

// Report is the dry-run result. Blocked is true when any rule is unresolved or
// needs human review; an apply step must refuse to run while it is true.
type Report struct {
	Rules            int       `json:"rules"`
	Edges            int64     `json:"edges"`
	ResolvedRules    int       `json:"resolved_rules"`
	ResolvedEdges    int64     `json:"resolved_edges"`
	UnresolvedRules  int       `json:"unresolved_rules"`
	UnresolvedEdges  int64     `json:"unresolved_edges"`
	ReviewRules      int       `json:"review_rules"`
	ReviewEdges      int64     `json:"review_edges"`
	InvertedRules    int       `json:"inverted_rules"`
	InvertedEdges    int64     `json:"inverted_edges"`
	Blocked          bool      `json:"blocked"`
	Samples          []string  `json:"samples,omitempty"`
	SamplesTruncated bool      `json:"samples_truncated,omitempty"`
	Mappings         []Mapping `json:"mappings"`
}

const sampleLimit = 50

// Plan builds the projection plan. Rules are kept in caller order so a stable
// SQL ORDER BY produces a stable report.
func Plan(rules []Rule, types map[string]TypeSemantics, overrides []Override) Report {
	overrideByKey := make(map[string]Override, len(overrides))
	for _, override := range overrides {
		overrideByKey[overrideKey(override.SourceType, override.ParentModel, override.ChildModel)] = override
	}

	report := Report{Mappings: make([]Mapping, 0, len(rules))}
	for _, rule := range rules {
		mapping := planRule(rule, types, overrideByKey)
		report.Mappings = append(report.Mappings, mapping)
		report.Rules++
		report.Edges += rule.EdgeCount

		if mapping.Unresolved != "" {
			report.UnresolvedRules++
			report.UnresolvedEdges += rule.EdgeCount
		} else {
			report.ResolvedRules++
			report.ResolvedEdges += rule.EdgeCount
			if mapping.Invert {
				report.InvertedRules++
				report.InvertedEdges += rule.EdgeCount
			}
			if len(report.Samples) < sampleLimit {
				report.Samples = append(report.Samples, mapping.Sample)
			} else {
				report.SamplesTruncated = true
			}
		}
		if mapping.Review {
			report.ReviewRules++
			report.ReviewEdges += rule.EdgeCount
		}
	}
	report.Blocked = report.UnresolvedRules > 0 || report.ReviewRules > 0
	return report
}

func planRule(rule Rule, types map[string]TypeSemantics, overrides map[string]Override) Mapping {
	mapping := Mapping{
		SourceType: rule.RelationType, ParentModel: rule.ParentModel,
		ChildModel: rule.ChildModel,
	}

	override, hasOverride := overrides[overrideKey(rule.RelationType, rule.ParentModel, rule.ChildModel)]
	typ, hasType := types[rule.RelationType]
	switch {
	case !hasType:
		mapping.Unresolved = fmt.Sprintf("relation type %q is not declared in CMDB", rule.RelationType)
		return mapping
	case !typ.OntologyReady:
		mapping.Unresolved = fmt.Sprintf("relation type %q is local-only (no topocortex category/traits)", rule.RelationType)
		return mapping
	case typ.Deprecated:
		if typ.Replacement != "" {
			mapping.Unresolved = fmt.Sprintf("relation type %q is deprecated; use %s", rule.RelationType, typ.Replacement)
		} else {
			mapping.Unresolved = fmt.Sprintf("relation type %q is deprecated and has no replacement", rule.RelationType)
		}
		return mapping
	}

	mapping.TargetType = typ.Name
	mapping.Invert = false
	if typ.InverseOf != "" {
		mapping.TargetType = typ.InverseOf
		mapping.Invert = true
	}
	if !knownConstraint(rule.Constraint) {
		mapping.Review = true
		mapping.Note = "unknown CMDB cardinality code; defaulted to one2many"
	}
	mapping.Cardinality = invertCardinality(cardinalityForConstraint(rule.Constraint), mapping.Invert)
	mapping.Propagates = typ.PropagatesDefault
	mapping.Weight = typ.WeightDefault
	mapping.Category = typ.TopocortexCategory
	mapping.Traits = typ.Traits
	mapping.Transitive = typ.Transitive
	mapping.SubPropertyOf = typ.SubPropertyOf

	if typ.PropagatesDefault && typ.WeightDefault <= 0 {
		mapping.Review = true
		mapping.Weight = 1.0
		mapping.Note = joinNote(mapping.Note, "propagating type has no positive weight; using 1.0")
	}
	if hasOverride {
		if override.TargetType != "" {
			mapping.TargetType = override.TargetType
		}
		if override.Invert != nil {
			mapping.Invert = *override.Invert
			mapping.Cardinality = invertCardinality(cardinalityForConstraint(rule.Constraint), mapping.Invert)
		}
		if override.Cardinality != "" {
			mapping.Cardinality = override.Cardinality
		}
		if override.Propagates != nil {
			mapping.Propagates = *override.Propagates
		}
		if override.Weight != nil {
			mapping.Weight = *override.Weight
		}
		if override.Review {
			mapping.Review = true
		}
		if override.Note != "" {
			mapping.Note = joinNote(mapping.Note, override.Note)
		}
	}

	if mapping.Invert {
		mapping.Sample = fmt.Sprintf("%s -%s-> %s", rule.ChildModel, mapping.TargetType, rule.ParentModel)
	} else {
		mapping.Sample = fmt.Sprintf("%s -%s-> %s", rule.ParentModel, mapping.TargetType, rule.ChildModel)
	}
	return mapping
}

func overrideKey(sourceType, parentModel, childModel string) string {
	return sourceType + "\x1f" + parentModel + "\x1f" + childModel
}

func knownConstraint(constraint string) bool {
	switch constraint {
	case "", "0", "1", "2":
		return true
	default:
		return false
	}
}

func cardinalityForConstraint(constraint string) string {
	switch constraint {
	case "", "0":
		return "1:N"
	case "1":
		return "1:1"
	case "2":
		return "N:M"
	default:
		return "1:N"
	}
}

func invertCardinality(cardinality string, invert bool) string {
	if !invert {
		return cardinality
	}
	switch cardinality {
	case "1:N":
		return "N:1"
	case "N:1":
		return "1:N"
	default:
		return cardinality
	}
}

func joinNote(existing, note string) string {
	if existing == "" {
		return note
	}
	if note == "" {
		return existing
	}
	return existing + "; " + note
}
