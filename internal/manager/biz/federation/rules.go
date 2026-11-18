package federation

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	model "github.com/ongridio/ongrid/internal/manager/model/federation"
)

// Aliases keep the package's public vocabulary stable while the persistence
// shapes live in model/federation.
type Rule = model.Rule
type FieldMapping = model.FieldMapping
type DisplayColumn = model.DisplayColumn

const (
	KindExternalAlert = model.KindExternalAlert
	KindITSMTicket    = model.KindITSMTicket

	UsageFilter = model.UsageFilter
	UsageBadge  = model.UsageBadge
	UsageBoth   = model.UsageBoth

	RenderText  = model.RenderText
	RenderTime  = model.RenderTime
	RenderBadge = model.RenderBadge
	RenderLink  = model.RenderLink

	ColumnKindBuiltin = model.ColumnKindBuiltin
	ColumnKindCustom  = model.ColumnKindCustom

	MapTypeField = model.MapTypeField
	MapTypeFixed = model.MapTypeFixed

	ValueTypeIdentity = model.ValueTypeIdentity
	ValueTypeFixed    = model.ValueTypeFixed
)

const (
	OpEq     = "eq"
	OpNe     = "ne"
	OpIn     = "in"
	OpNotIn  = "not_in"
	OpRegex  = "regex"
	OpGt     = "gt"
	OpGte    = "gte"
	OpLt     = "lt"
	OpLte    = "lte"
	OpExists = "exists"
)

var validOps = map[string]bool{
	OpEq: true, OpNe: true, OpIn: true, OpNotIn: true, OpRegex: true,
	OpGt: true, OpGte: true, OpLt: true, OpLte: true, OpExists: true,
}

var identityOps = map[string]bool{
	OpEq: true, OpNe: true, OpIn: true, OpNotIn: true, OpRegex: true,
}

var identitySources = map[string]bool{
	"email": true, "phone": true, "dingtalk_userid": true, "username": true,
}

const (
	maxFilters          = 8
	maxRulesPerFilter   = 32
	maxInValues         = 100
	maxFilterKeyLength  = 32
	maxFieldPathLength  = 256
	maxDisplayColumns   = 64
	reservedFieldToken  = "__proto__"
	reservedFieldToken2 = "constructor"
	reservedFieldToken3 = "prototype"
)

var (
	keyRE       = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)
	fieldPathRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$`)
)

// FilterInput is the write-side shape. Enabled is a pointer so an absent
// field means enabled while an explicit false disables the filter — the same
// distinction the HTTP body needs.
type FilterInput struct {
	Key      string `json:"key"`
	Name     string `json:"name"`
	Usage    string `json:"usage"`
	Enabled  *bool  `json:"enabled"`
	And      []Rule `json:"and"`
	Or       []Rule `json:"or"`
	Position int    `json:"position"`
}

// Filter is the domain shape of one configured center filter. The stored form
// keeps the two rule groups as JSON columns.
type Filter struct {
	Key      string `json:"key"`
	Name     string `json:"name"`
	Usage    string `json:"usage"`
	Enabled  bool   `json:"enabled"`
	And      []Rule `json:"and"`
	Or       []Rule `json:"or"`
	Position int    `json:"position"`
}

// Expr builds one upstream filter expression: field:op[:value]. `exists` is
// the one operator that omits its value; a trailing colon would be a third,
// empty segment the upstream rejects.
func Expr(field, op, value string) string {
	if value == "" {
		return field + ":" + op
	}
	return field + ":" + op + ":" + value
}

// ValidFieldPath validates the dotted field path used in rules, mappings and
// display columns. The path becomes a query document key, so a '$' or a
// prototype-pollution segment is rejected.
func ValidFieldPath(path string) error {
	path = strings.TrimSpace(path)
	if path == "" || len(path) > maxFieldPathLength || !fieldPathRE.MatchString(path) {
		return fmt.Errorf("field path %q is invalid", path)
	}
	for _, seg := range strings.Split(path, ".") {
		switch seg {
		case reservedFieldToken, reservedFieldToken2, reservedFieldToken3:
			return fmt.Errorf("field path %q uses reserved segment %q", path, seg)
		}
	}
	return nil
}

// ValidateRule normalizes and validates one rule.
func ValidateRule(in Rule) (Rule, error) {
	field := strings.TrimSpace(in.Field)
	if err := ValidFieldPath(field); err != nil {
		return Rule{}, err
	}

	op := strings.ToLower(strings.TrimSpace(in.Op))
	if op == "" {
		op = OpEq
	}
	if !validOps[op] {
		return Rule{}, fmt.Errorf("op %q is invalid", op)
	}

	if op == OpExists {
		return Rule{Field: field, Op: op, ValueType: ValueTypeFixed}, nil
	}

	valueType := strings.ToLower(strings.TrimSpace(in.ValueType))
	if valueType == "" {
		valueType = ValueTypeIdentity
	}
	switch valueType {
	case ValueTypeIdentity:
		if !identityOps[op] {
			return Rule{}, fmt.Errorf("identity rules do not support op %q", op)
		}
		source := strings.ToLower(strings.TrimSpace(in.Identity))
		if !identitySources[source] {
			return Rule{}, fmt.Errorf("identity source %q is invalid", source)
		}
		return Rule{Field: field, Op: op, ValueType: ValueTypeIdentity, Identity: source}, nil
	case ValueTypeFixed:
		values := make([]string, 0, len(in.Values))
		for _, value := range in.Values {
			if cleaned := strings.TrimSpace(value); cleaned != "" {
				values = append(values, cleaned)
			}
		}
		if len(values) == 0 {
			return Rule{}, fmt.Errorf("value is required for %s rule on %s", op, field)
		}
		if op == OpIn || op == OpNotIn {
			if len(values) > maxInValues {
				return Rule{}, fmt.Errorf("%s rule on %s has %d values (max %d)", op, field, len(values), maxInValues)
			}
			for _, value := range values {
				if strings.Contains(value, ",") {
					return Rule{}, fmt.Errorf("%s rule on %s has a value containing a comma: %q", op, field, value)
				}
			}
		} else if len(values) != 1 {
			return Rule{}, fmt.Errorf("%s rule on %s requires a single value", op, field)
		}
		if op == OpRegex {
			if _, err := regexp.Compile(values[0]); err != nil {
				return Rule{}, fmt.Errorf("regex on %s is invalid: %w", field, err)
			}
		}
		return Rule{Field: field, Op: op, ValueType: ValueTypeFixed, Values: values}, nil
	default:
		return Rule{}, fmt.Errorf("value_type %q is invalid", valueType)
	}
}

// ValidateFilter normalizes and validates one filter. keyFromPath, when set,
// wins over the body's key (the URL already fixed it).
func ValidateFilter(in FilterInput, keyFromPath string) (Filter, error) {
	key := strings.TrimSpace(keyFromPath)
	if key == "" {
		key = strings.TrimSpace(in.Key)
	}
	if len(key) > maxFilterKeyLength || !keyRE.MatchString(key) {
		return Filter{}, fmt.Errorf("filter key %q is invalid", key)
	}
	if key == "all" || key == "default" {
		return Filter{}, fmt.Errorf("filter key %q is reserved", key)
	}

	name := strings.TrimSpace(in.Name)
	if name == "" {
		return Filter{}, fmt.Errorf("filter name is required")
	}

	usage := strings.ToLower(strings.TrimSpace(in.Usage))
	if usage == "" {
		usage = UsageFilter
	}
	if !model.ValidUsage(usage) {
		return Filter{}, fmt.Errorf("filter usage %q is invalid", usage)
	}

	and, err := validateRules(in.And, "and")
	if err != nil {
		return Filter{}, err
	}
	or, err := validateRules(in.Or, "or")
	if err != nil {
		return Filter{}, err
	}
	if len(and) == 0 && len(or) == 0 {
		return Filter{}, fmt.Errorf("filter %q requires at least one rule", key)
	}

	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	return Filter{
		Key:      key,
		Name:     name,
		Usage:    usage,
		Enabled:  enabled,
		And:      and,
		Or:       or,
		Position: in.Position,
	}, nil
}

func validateRules(in []Rule, group string) ([]Rule, error) {
	if len(in) > maxRulesPerFilter {
		return nil, fmt.Errorf("%s group has %d rules (max %d)", group, len(in), maxRulesPerFilter)
	}
	out := make([]Rule, 0, len(in))
	for _, rule := range in {
		normalized, err := ValidateRule(rule)
		if err != nil {
			return nil, err
		}
		out = append(out, normalized)
	}
	return out, nil
}

// BuildPredicate substitutes the caller's identities into one filter.
//
// The two groups are deliberately asymmetric. A rule that emits nothing VOIDS
// the predicate in the AND group, because dropping a conjunct widens the query
// — a filter written as [my email, status=firing] must not silently become
// "every firing alert". In the OR group the rule is simply skipped.
func BuildPredicate(filter Filter, identities map[string][]string) (and, or []string, bound bool) {
	for _, rule := range filter.And {
		exprs := ruleExpressions(rule, identities)
		if len(exprs) == 0 {
			return nil, nil, false
		}
		and = append(and, exprs...)
	}
	for _, rule := range filter.Or {
		or = append(or, ruleExpressions(rule, identities)...)
	}
	if len(and) == 0 && len(or) == 0 {
		return nil, nil, false
	}
	return and, or, true
}

func ruleExpressions(rule Rule, identities map[string][]string) []string {
	field := strings.TrimSpace(rule.Field)
	if field == "" {
		return nil
	}
	op := strings.ToLower(strings.TrimSpace(rule.Op))
	if op == "" {
		op = OpEq
	}
	if op == OpExists {
		return []string{Expr(field, op, "")}
	}

	if rule.ValueType == ValueTypeFixed {
		values := make([]string, 0, len(rule.Values))
		for _, value := range rule.Values {
			if cleaned := strings.TrimSpace(value); cleaned != "" {
				values = append(values, cleaned)
			}
		}
		if len(values) == 0 {
			return nil
		}
		if op == OpIn || op == OpNotIn {
			return []string{Expr(field, op, strings.Join(values, ","))}
		}
		return []string{Expr(field, op, values[0])}
	}

	values := identities[strings.ToLower(strings.TrimSpace(rule.Identity))]
	if len(values) == 0 {
		return nil
	}
	if op == OpIn || op == OpNotIn {
		usable := make([]string, 0, len(values))
		for _, value := range values {
			if value != "" && !strings.Contains(value, ",") {
				usable = append(usable, value)
			}
		}
		if len(usable) == 0 {
			return nil
		}
		return []string{Expr(field, op, strings.Join(usable, ","))}
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value != "" {
			out = append(out, Expr(field, op, value))
		}
	}
	return out
}

// ValidateMapping normalizes and validates a mapping's rows.
func ValidateMapping(rows []FieldMapping) ([]FieldMapping, error) {
	out := make([]FieldMapping, 0, len(rows))
	for _, row := range rows {
		source := strings.TrimSpace(row.SourceField)
		if err := ValidFieldPath(source); err != nil {
			return nil, err
		}
		op := strings.ToLower(strings.TrimSpace(row.Op))
		if op == "" {
			op = OpEq
		}
		if !validOps[op] {
			return nil, fmt.Errorf("mapping op %q is invalid", op)
		}
		mapType := strings.ToLower(strings.TrimSpace(row.MapType))
		switch mapType {
		case MapTypeField, MapTypeFixed:
		default:
			return nil, fmt.Errorf("mapping map_type %q is invalid", mapType)
		}
		value := strings.TrimSpace(row.Value)
		if value == "" {
			return nil, fmt.Errorf("mapping value for %s is required", source)
		}
		if mapType == MapTypeFixed && op == OpExists {
			return nil, fmt.Errorf("mapping %s: exists takes no fixed value", source)
		}
		out = append(out, FieldMapping{SourceField: source, Op: op, MapType: mapType, Value: value})
	}
	return out, nil
}

// BuildMapping translates a mapping's rows into upstream expressions.
//
// A field row compares an upstream field against a CMDB attribute and is
// OR-ed. A fixed row compares against a constant and is AND-ed. A field row
// whose CI attribute is absent or blank is dropped; if no OR expression
// remains the caller must NOT query, because that would hand one CI the whole
// table.
func BuildMapping(rows []FieldMapping, ci map[string]any) (and, or []string) {
	for _, row := range rows {
		source := strings.TrimSpace(row.SourceField)
		if source == "" {
			continue
		}
		op := strings.ToLower(strings.TrimSpace(row.Op))
		if op == "" {
			op = OpEq
		}
		if row.MapType == MapTypeFixed {
			and = append(and, Expr(source, op, row.Value))
			continue
		}
		raw, ok := ci[row.Value]
		if !ok || raw == nil {
			continue
		}
		value, ok := flattenValue(raw)
		if !ok || value == "" {
			continue
		}
		or = append(or, Expr(source, op, value))
	}
	return and, or
}

func flattenValue(raw any) (string, bool) {
	switch value := raw.(type) {
	case string:
		value = strings.TrimSpace(value)
		return value, value != ""
	case []string:
		cleaned := make([]string, 0, len(value))
		for _, item := range value {
			if item = strings.TrimSpace(item); item != "" {
				cleaned = append(cleaned, item)
			}
		}
		return strings.Join(cleaned, ","), len(cleaned) > 0
	case []any:
		cleaned := make([]string, 0, len(value))
		for _, item := range value {
			if item == nil {
				continue
			}
			text := strings.TrimSpace(fmt.Sprint(item))
			if text != "" {
				cleaned = append(cleaned, text)
			}
		}
		return strings.Join(cleaned, ","), len(cleaned) > 0
	case nil:
		return "", false
	default:
		text := strings.TrimSpace(fmt.Sprint(value))
		return text, text != ""
	}
}

// ValidateColumns validates the ordered display-column list. At least one
// column must be visible; keys must be unique; custom columns carry a safe
// path and an allowlisted renderer.
func ValidateColumns(in []DisplayColumn) ([]DisplayColumn, error) {
	if len(in) == 0 {
		return nil, errors.New("at least one display column is required")
	}
	if len(in) > maxDisplayColumns {
		return nil, fmt.Errorf("%d display columns (max %d)", len(in), maxDisplayColumns)
	}
	seen := make(map[string]bool, len(in))
	visible := false
	out := make([]DisplayColumn, 0, len(in))
	for position, col := range in {
		key := strings.TrimSpace(col.ColumnKey)
		if !keyRE.MatchString(key) || len(key) > 64 {
			return nil, fmt.Errorf("display column key %q is invalid", key)
		}
		if seen[key] {
			return nil, fmt.Errorf("duplicate display column key %q", key)
		}
		seen[key] = true

		kind := strings.ToLower(strings.TrimSpace(col.ColumnKind))
		if kind == "" {
			kind = ColumnKindBuiltin
		}
		if kind != ColumnKindBuiltin && kind != ColumnKindCustom {
			return nil, fmt.Errorf("display column %q kind %q is invalid", key, kind)
		}

		render := strings.ToLower(strings.TrimSpace(col.Render))
		if kind == ColumnKindCustom {
			if err := ValidFieldPath(col.Path); err != nil {
				return nil, fmt.Errorf("display column %q: %w", key, err)
			}
			if render == "" {
				render = RenderText
			}
			if !model.ValidRender(render) {
				return nil, fmt.Errorf("display column %q render %q is invalid", key, render)
			}
			if strings.TrimSpace(col.LabelZH) == "" && strings.TrimSpace(col.LabelEN) == "" {
				return nil, fmt.Errorf("display column %q needs a label", key)
			}
		} else if render != "" && !model.ValidRender(render) {
			return nil, fmt.Errorf("display column %q render %q is invalid", key, render)
		}

		if col.Visible {
			visible = true
		}
		out = append(out, DisplayColumn{
			ColumnKey:  key,
			ColumnKind: kind,
			Path:       strings.TrimSpace(col.Path),
			Render:     render,
			LabelZH:    strings.TrimSpace(col.LabelZH),
			LabelEN:    strings.TrimSpace(col.LabelEN),
			Visible:    col.Visible,
			Position:   position,
		})
	}
	if !visible {
		return nil, errors.New("at least one display column must be visible")
	}
	return out, nil
}

// ReadPath reads a dotted path from a decoded JSON document. Missing paths and
// reserved segments report false; callers render "-" rather than crashing.
func ReadPath(doc any, path string) (any, bool) {
	path = strings.TrimSpace(path)
	if path == "" || !fieldPathRE.MatchString(path) {
		return nil, false
	}
	current := doc
	for _, segment := range strings.Split(path, ".") {
		switch segment {
		case reservedFieldToken, reservedFieldToken2, reservedFieldToken3:
			return nil, false
		}
		switch node := current.(type) {
		case map[string]any:
			next, ok := node[segment]
			if !ok {
				return nil, false
			}
			current = next
		case map[string]string:
			next, ok := node[segment]
			if !ok {
				return nil, false
			}
			current = next
		default:
			return nil, false
		}
	}
	return current, true
}
