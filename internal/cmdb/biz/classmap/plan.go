// Package classmap builds the read-only plan that projects CMDB CI types and
// their attributes into nexus-topocortex classes. It writes nothing; the apply
// step consumes the plan through biz/connector.
package classmap

import (
	"fmt"
	"regexp"
)

var identifierRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)

// Attribute is one CMDB attribute definition, in the subset the projection
// needs. ValueType is the CMDB storage code ("0" int ... "7" bool).
type Attribute struct {
	Name        string
	ValueType   string
	IsList      bool
	IsRequired  bool
	IsUnique    bool
	IsIndex     bool
	IsPassword  bool
	IsFile      bool
	IsLink      bool
	IsReference bool
	IsChoice    bool
	IsComputed  bool
}

// Type is one CMDB CI type and its OWN attributes. Inherited attributes are
// represented by Parents and must not be repeated on the child.
type Type struct {
	Name       string
	Alias      string
	UniqueAttr string
	ShowAttr   string
	Parents    []string
	Attributes []Attribute
	Enabled    bool
}

// Profile is explicit enrichment a deployment supplies for one CMDB model.
// Nothing here is inferred from the class name.
type Profile struct {
	DisplayName      string            `json:"display_name,omitempty"`
	Description      string            `json:"description,omitempty"`
	Domain           string            `json:"domain,omitempty"`
	Layer            string            `json:"layer,omitempty"`
	ParentOverride   string            `json:"parent_override,omitempty"`
	Abstract         bool              `json:"abstract,omitempty"`
	Roles            []string          `json:"roles,omitempty"`
	SemanticBindings map[string]string `json:"semantic_bindings,omitempty"`
	// AttributeNames maps a CMDB attribute name to its topocortex attribute
	// name. Missing entries keep the CMDB name, which must already be a valid
	// topocortex identifier.
	AttributeNames map[string]string `json:"attribute_names,omitempty"`
}

// PropertyConstraints is the subset of topocortex constraints the projection
// writes. Enum is left empty because CMDB choice values are not loaded here.
type PropertyConstraints struct {
	Required    bool     `json:"required,omitempty"`
	Enum        []string `json:"enum,omitempty"`
	Sensitivity string   `json:"sensitivity,omitempty"`
}

// Class is one proposed topocortex class.
type Class struct {
	ClassName        string                         `json:"class_name"`
	DisplayName      string                         `json:"display_name,omitempty"`
	Description      string                         `json:"description,omitempty"`
	Domain           string                         `json:"domain,omitempty"`
	Layer            string                         `json:"layer,omitempty"`
	ParentClass      string                         `json:"parent_class,omitempty"`
	Abstract         bool                           `json:"abstract,omitempty"`
	Attributes       map[string]string              `json:"attributes,omitempty"`
	Constraints      map[string]PropertyConstraints `json:"constraints,omitempty"`
	IndexedKeys      []string                       `json:"indexed_keys,omitempty"`
	DisplayKeys      []string                       `json:"display_keys,omitempty"`
	IdentityKeys     []string                       `json:"identity_keys,omitempty"`
	Roles            []string                       `json:"roles,omitempty"`
	SemanticBindings map[string]string              `json:"semantic_bindings,omitempty"`
}

// Mapping is one CMDB model's proposed class, or the reason it cannot be
// projected.
type Mapping struct {
	SourceModel string   `json:"source_model"`
	TargetClass string   `json:"target_class"`
	Class       Class    `json:"class"`
	Review      bool     `json:"review,omitempty"`
	Notes       []string `json:"notes,omitempty"`
	Unresolved  string   `json:"unresolved,omitempty"`
}

// Report is the class-projection dry run. Blocked is true when any model is
// unresolved or needs review; apply must refuse while it is true.
type Report struct {
	Types      int       `json:"types"`
	Resolved   int       `json:"resolved"`
	Unresolved int       `json:"unresolved"`
	Review     int       `json:"review"`
	Blocked    bool      `json:"blocked"`
	Mappings   []Mapping `json:"mappings"`
}

// Plan maps every CMDB type to a topocortex class. ClassMapping nil means
// identity; a non-nil map is strict and must name every referenced model.
func Plan(types []Type, classMapping map[string]string, profiles map[string]Profile) Report {
	report := Report{Mappings: make([]Mapping, 0, len(types)), Types: len(types)}
	byName := make(map[string]Type, len(types))
	for _, typ := range types {
		byName[typ.Name] = typ
	}

	for _, typ := range types {
		mapping := planType(typ, byName, classMapping, profiles)
		report.Mappings = append(report.Mappings, mapping)
		switch {
		case mapping.Unresolved != "":
			report.Unresolved++
		default:
			report.Resolved++
		}
		if mapping.Review {
			report.Review++
		}
	}
	report.Blocked = report.Unresolved > 0 || report.Review > 0
	return report
}

func planType(typ Type, byName map[string]Type, classMapping map[string]string, profiles map[string]Profile) Mapping {
	profile := profiles[typ.Name]
	mapping := Mapping{SourceModel: typ.Name, Class: Class{
		Attributes:       map[string]string{},
		Constraints:      map[string]PropertyConstraints{},
		IndexedKeys:      []string{},
		DisplayKeys:      []string{},
		IdentityKeys:     []string{},
		Roles:            append([]string(nil), profile.Roles...),
		SemanticBindings: copyStringMap(profile.SemanticBindings),
	}}

	className, err := resolveName(typ.Name, classMapping)
	if err != nil {
		mapping.Unresolved = err.Error()
		return mapping
	}
	mapping.TargetClass = className
	mapping.Class.ClassName = className
	mapping.Class.DisplayName = firstNonEmpty(profile.DisplayName, typ.Alias, typ.Name)
	mapping.Class.Description = profile.Description
	mapping.Class.Domain = profile.Domain
	mapping.Class.Layer = profile.Layer
	mapping.Class.Abstract = profile.Abstract

	parent, err := resolveParent(typ, classMapping, profile)
	if err != nil {
		mapping.Unresolved = err.Error()
		return mapping
	}
	if parent == className {
		mapping.Unresolved = fmt.Sprintf("class %q cannot be its own parent", className)
		return mapping
	}
	mapping.Class.ParentClass = parent

	inherited := map[string]struct{}{}
	if profile.ParentOverride == "" {
		inherited, err = inheritedNames(byName, typ.Name, profiles)
		if err != nil {
			mapping.Unresolved = err.Error()
			return mapping
		}
	}
	available := make(map[string]struct{}, len(inherited)+len(typ.Attributes))
	for name := range inherited {
		available[name] = struct{}{}
	}

	seenAttributes := make(map[string]struct{}, len(typ.Attributes))
	for _, attribute := range typ.Attributes {
		name, err := resolveAttributeName(typ.Name, attribute.Name, profile)
		if err != nil {
			mapping.Unresolved = err.Error()
			return mapping
		}
		if _, duplicate := seenAttributes[name]; duplicate {
			mapping.Unresolved = fmt.Sprintf("model %q maps two attributes to %q", typ.Name, name)
			return mapping
		}
		seenAttributes[name] = struct{}{}
		if _, duplicate := inherited[name]; duplicate {
			mapping.Unresolved = fmt.Sprintf("attribute %q duplicates an inherited attribute on %q", name, typ.Name)
			return mapping
		}
		propertyType, sensitivity, note, ok := propertyType(attribute)
		if !ok {
			mapping.Unresolved = fmt.Sprintf("attribute %q has unsupported value type %q", attribute.Name, attribute.ValueType)
			return mapping
		}
		if note != "" {
			mapping.Notes = append(mapping.Notes, fmt.Sprintf("%s: %s", attribute.Name, note))
		}
		mapping.Class.Attributes[name] = propertyType
		available[name] = struct{}{}
		if attribute.IsRequired || sensitivity != "" {
			mapping.Class.Constraints[name] = PropertyConstraints{
				Required: attribute.IsRequired, Sensitivity: sensitivity,
			}
		}
		if attribute.IsIndex {
			mapping.Class.IndexedKeys = append(mapping.Class.IndexedKeys, name)
		}
	}

	if typ.ShowAttr != "" {
		name, err := resolveAttributeName(typ.Name, typ.ShowAttr, profile)
		if err != nil {
			mapping.Unresolved = err.Error()
			return mapping
		}
		if _, ok := available[name]; !ok {
			mapping.Unresolved = fmt.Sprintf("show attribute %q is not a declared or inherited attribute", typ.ShowAttr)
			return mapping
		}
		mapping.Class.DisplayKeys = append(mapping.Class.DisplayKeys, name)
	}

	uniqueAttr := typ.UniqueAttr
	if uniqueAttr == "" {
		for _, attribute := range typ.Attributes {
			if attribute.IsUnique {
				uniqueAttr = attribute.Name
				break
			}
		}
	}
	if uniqueAttr != "" {
		name, err := resolveAttributeName(typ.Name, uniqueAttr, profile)
		if err != nil {
			mapping.Unresolved = err.Error()
			return mapping
		}
		if _, ok := available[name]; !ok {
			mapping.Unresolved = fmt.Sprintf("unique attribute %q is not a declared or inherited attribute", uniqueAttr)
			return mapping
		}
		mapping.Class.IdentityKeys = append(mapping.Class.IdentityKeys, name)
	}

	if !typ.Enabled {
		mapping.Review = true
		mapping.Notes = append(mapping.Notes, "model is disabled; confirm before projecting it")
	}
	return mapping
}

func resolveName(model string, mapping map[string]string) (string, error) {
	name := model
	if mapping != nil {
		mapped, ok := mapping[model]
		if !ok || mapped == "" {
			return "", fmt.Errorf("class mapping is missing for model %q", model)
		}
		name = mapped
	}
	if !identifierRE.MatchString(name) {
		return "", fmt.Errorf("class name %q is not a valid topocortex identifier", name)
	}
	return name, nil
}

func resolveParent(typ Type, classMapping map[string]string, profile Profile) (string, error) {
	if profile.ParentOverride != "" {
		if !identifierRE.MatchString(profile.ParentOverride) {
			return "", fmt.Errorf("parent override %q is not a valid topocortex identifier", profile.ParentOverride)
		}
		return profile.ParentOverride, nil
	}
	switch len(typ.Parents) {
	case 0:
		return "", nil
	case 1:
		return resolveName(typ.Parents[0], classMapping)
	default:
		return "", fmt.Errorf("model %q has multiple inheritance; set parent_override to one primary parent", typ.Name)
	}
}

func resolveAttributeName(model, attribute string, profile Profile) (string, error) {
	name := attribute
	if mapped, ok := profile.AttributeNames[attribute]; ok && mapped != "" {
		name = mapped
	}
	if !identifierRE.MatchString(name) {
		return "", fmt.Errorf("attribute %q on model %q is not a valid topocortex identifier; add attribute_names mapping", attribute, model)
	}
	return name, nil
}

func inheritedNames(byName map[string]Type, name string, profiles map[string]Profile) (map[string]struct{}, error) {
	out := make(map[string]struct{})
	typ, ok := byName[name]
	if !ok {
		return nil, fmt.Errorf("model %q is not declared", name)
	}
	seen := make(map[string]struct{})
	var walk func(current Type) error
	walk = func(current Type) error {
		if _, cycle := seen[current.Name]; cycle {
			return fmt.Errorf("inheritance cycle at model %q", current.Name)
		}
		seen[current.Name] = struct{}{}
		defer delete(seen, current.Name)
		for _, parentName := range current.Parents {
			parent, ok := byName[parentName]
			if !ok {
				return fmt.Errorf("parent model %q is not declared", parentName)
			}
			for _, attribute := range parent.Attributes {
				mapped, err := resolveAttributeName(parent.Name, attribute.Name, profiles[parent.Name])
				if err != nil {
					return err
				}
				out[mapped] = struct{}{}
			}
			if err := walk(parent); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(typ); err != nil {
		return nil, err
	}
	return out, nil
}

func propertyType(attribute Attribute) (typ, sensitivity, note string, ok bool) {
	switch attribute.ValueType {
	case "0":
		typ = "int"
	case "1":
		typ = "float"
	case "2":
		typ = "string"
	case "3":
		typ = "datetime"
	case "4":
		typ, note = "string", "date value type has no topocortex equivalent; projected as string"
	case "5":
		typ, note = "string", "time value type has no topocortex equivalent; projected as string"
	case "6":
		typ, note = "string", "json value type has no topocortex property type; projected as string"
	case "7":
		typ = "bool"
	default:
		return "", "", "", false
	}

	if attribute.IsPassword {
		typ, sensitivity = "string", "secret"
		note = joinNote(note, "password is projected as string; value sync must be denied")
	}
	if attribute.IsFile || attribute.IsLink {
		typ, sensitivity = "string", "confidential"
		note = joinNote(note, "file/link value is projected as string; value sync must be denied")
	}
	if attribute.IsReference {
		typ = "int"
		note = joinNote(note, "reference is projected as a scalar int; the referenced relation is not created")
	}
	if attribute.IsList {
		typ = listType(typ)
	}
	if attribute.IsChoice {
		note = joinNote(note, "choice values are not projected; enum is left empty")
	}
	if attribute.IsComputed {
		note = joinNote(note, "computed value is not projected")
	}
	return typ, sensitivity, note, true
}

func listType(base string) string {
	switch base {
	case "int":
		return "int_list"
	case "float":
		return "float_list"
	case "bool":
		return "bool_list"
	case "datetime":
		return "datetime_list"
	default:
		return "string_list"
	}
}

func joinNote(left, right string) string {
	if left == "" {
		return right
	}
	if right == "" {
		return left
	}
	return left + "; " + right
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func copyStringMap(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}
