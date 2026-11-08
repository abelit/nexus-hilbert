// cmdb_form_assist.go — POST /v1/aiops/cmdb/form-assist.
//
// One read-only LLM call that proposes values for the CMDB forms:
//   - kind=instance: values for one model's writable attributes
//   - kind=model:    name/alias/unique key/parents for a new or edited model
//   - kind=attribute: one or more attribute definitions
//
// The model schema is always read from cmdb-api with the caller's own JWT; the
// client never supplies the schema. The endpoint never writes to CMDB and never
// approves anything: the operator accepts suggestions in the form and saves
// through the existing form submit path.
package aiops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ongridio/ongrid/internal/manager/biz/aiops/tools/cmdb"
	"github.com/ongridio/ongrid/internal/pkg/errs"
	"github.com/ongridio/ongrid/internal/pkg/llm"
	"github.com/ongridio/ongrid/internal/pkg/tenantctx"
)

const cmdbFormAssistTimeout = 120 * time.Second
const cmdbFormAssistMaxIntent = 2000
const cmdbFormAssistMaxValues = 20
const cmdbFormAssistMaxAttributes = 5
const cmdbFormAssistMaxPairs = 10

// cmdbFormRelationTypeNameMax mirrors CMDB's relation-type name limit. The
// manager cannot import internal/cmdb (ADR-037), so the two constants are kept
// in sync here and in internal/cmdb/biz/relationtype.
const cmdbFormRelationTypeNameMax = 64

var cmdbFormNameRE = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)
var cmdbFormColorRE = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

var cmdbFormValueTypes = map[string]bool{
	"0": true, "1": true, "2": true, "3": true,
	"4": true, "5": true, "6": true, "7": true,
}

type cmdbFormAssistRequest struct {
	Kind           string         `json:"kind"`
	CIType         string         `json:"ci_type,omitempty"`
	CIID           int            `json:"ci_id,omitempty"`
	ModelRef       string         `json:"model_ref,omitempty"`
	SourceModelRef string         `json:"source_model_ref,omitempty"`
	TargetModelRef string         `json:"target_model_ref,omitempty"`
	Intent         string         `json:"intent"`
	Locale         string         `json:"locale,omitempty"`
	Fields         []string       `json:"fields,omitempty"`
	Values         map[string]any `json:"values,omitempty"`
	ParentModelIDs []int          `json:"parent_model_ids,omitempty"`
}

type cmdbAttributeSchema struct {
	ID          int               `json:"id"`
	Name        string            `json:"name"`
	Alias       string            `json:"alias"`
	ValueType   string            `json:"value_type"`
	IsRequired  bool              `json:"is_required"`
	IsComputed  bool              `json:"is_computed"`
	IsPassword  bool              `json:"is_password"`
	IsFile      bool              `json:"is_file"`
	IsLink      bool              `json:"is_link"`
	IsReference bool              `json:"is_reference"`
	IsList      bool              `json:"is_list"`
	ChoiceValue []json.RawMessage `json:"choice_value"`
}

type cmdbFormAssistResponse struct {
	Kind             string            `json:"kind"`
	Values           map[string]any    `json:"values,omitempty"`
	Attributes       []map[string]any  `json:"attributes,omitempty"`
	Name             string            `json:"name,omitempty"`
	Alias            string            `json:"alias,omitempty"`
	Color            string            `json:"color,omitempty"`
	UniqueKey        string            `json:"unique_key,omitempty"`
	DefaultOrderAttr string            `json:"default_order_attr,omitempty"`
	ParentIDs        []int             `json:"parent_ids,omitempty"`
	SourceModelID    int               `json:"source_model_id,omitempty"`
	TargetModelID    int               `json:"target_model_id,omitempty"`
	RelationTypeID   int               `json:"relation_type_id,omitempty"`
	Constraint       string            `json:"constraint,omitempty"`
	ParentAttrIDs    []int             `json:"parent_attr_ids,omitempty"`
	ChildAttrIDs     []int             `json:"child_attr_ids,omitempty"`
	Explanations     map[string]string `json:"explanations,omitempty"`
	Skipped          []string          `json:"skipped,omitempty"`
	Warnings         []string          `json:"warnings,omitempty"`
	Truncated        bool              `json:"truncated,omitempty"`
}

type cmdbFormAttributeSuggestion struct {
	Name         string   `json:"name"`
	Alias        string   `json:"alias"`
	ValueType    string   `json:"value_type"`
	IsRequired   bool     `json:"is_required"`
	ChoiceValues []string `json:"choice_values,omitempty"`
}

type cmdbFormModelSuggestion struct {
	Name             string            `json:"name"`
	Alias            string            `json:"alias"`
	UniqueKey        string            `json:"unique_key"`
	DefaultOrderAttr string            `json:"default_order_attr"`
	ParentIDs        []int             `json:"parent_ids"`
	Explanations     map[string]string `json:"explanations"`
	Warnings         []string          `json:"warnings"`
}

type cmdbFormInstanceSuggestion struct {
	Values       map[string]any    `json:"values"`
	Explanations map[string]string `json:"explanations"`
	Skipped      []string          `json:"skipped"`
	Warnings     []string          `json:"warnings"`
}

type cmdbFormAttributeSuggestionEnvelope struct {
	Attributes []cmdbFormAttributeSuggestion `json:"attributes"`
	Warnings   []string                      `json:"warnings"`
}

type cmdbFormRelationTypeSuggestion struct {
	Name     string   `json:"name"`
	Color    string   `json:"color"`
	Warnings []string `json:"warnings"`
}

type cmdbFormModelRelationSuggestion struct {
	SourceModel      string            `json:"source_model"`
	TargetModel      string            `json:"target_model"`
	RelationType     string            `json:"relation_type"`
	Constraint       string            `json:"constraint"`
	ParentAttributes []string          `json:"parent_attributes"`
	ChildAttributes  []string          `json:"child_attributes"`
	Explanations     map[string]string `json:"explanations"`
	Warnings         []string          `json:"warnings"`
}

func (h *Handler) cmdbFormAssist(w http.ResponseWriter, r *http.Request) {
	if _, ok := tenantctx.From(r.Context()); !ok {
		writeErr(w, errs.ErrUnauthorized)
		return
	}
	if h.cmdb == nil || h.llmClient == nil {
		http.Error(w, "llm or cmdb client not configured", http.StatusServiceUnavailable)
		return
	}
	var req cmdbFormAssistRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := dec.Decode(&req); err != nil {
		writeErr(w, errors.Join(errs.ErrInvalid, err))
		return
	}
	kind := strings.ToLower(strings.TrimSpace(req.Kind))
	req.Intent = strings.TrimSpace(req.Intent)
	if req.Intent == "" {
		writeErr(w, fmt.Errorf("%w: intent required", errs.ErrInvalid))
		return
	}
	if len(req.Intent) > cmdbFormAssistMaxIntent {
		req.Intent = req.Intent[:cmdbFormAssistMaxIntent]
	}

	ctx, cancel := context.WithTimeout(r.Context(), cmdbFormAssistTimeout)
	defer cancel()

	var (
		out *cmdbFormAssistResponse
		err error
	)
	switch kind {
	case "instance":
		out, err = h.cmdbAssistInstance(ctx, req)
	case "model":
		out, err = h.cmdbAssistModel(ctx, req)
	case "attribute":
		out, err = h.cmdbAssistAttribute(ctx, req)
	case "relation_type":
		out, err = h.cmdbAssistRelationType(ctx, req)
	case "model_relation":
		out, err = h.cmdbAssistModelRelation(ctx, req)
	default:
		writeErr(w, fmt.Errorf("%w: kind must be instance|model|attribute|relation_type|model_relation", errs.ErrInvalid))
		return
	}
	if err != nil {
		var llmErr *cmdbFormAssistError
		if errors.As(err, &llmErr) {
			http.Error(w, llmErr.Error(), llmErr.Status)
			return
		}
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type cmdbFormAssistError struct {
	Status int
	Msg    string
}

func (e *cmdbFormAssistError) Error() string { return e.Msg }

func (h *Handler) cmdbAssistInstance(ctx context.Context, req cmdbFormAssistRequest) (*cmdbFormAssistResponse, error) {
	ref := strings.TrimSpace(req.CIType)
	if ref == "" {
		ref = strings.TrimSpace(req.ModelRef)
	}
	if ref == "" {
		return nil, fmt.Errorf("%w: ci_type required", errs.ErrInvalid)
	}
	attrs, err := h.fetchCMBAttributes(ctx, ref)
	if err != nil {
		return nil, err
	}
	allowed, warnings := writableAttributes(attrs, req.Fields)
	if len(allowed) == 0 {
		return nil, fmt.Errorf("%w: no writable attributes for model %q", errs.ErrInvalid, ref)
	}

	schema := make([]map[string]any, 0, len(allowed))
	for _, attr := range allowed {
		schema = append(schema, map[string]any{
			"name": attr.Name, "alias": attr.Alias, "value_type": attr.ValueType,
			"required": attr.IsRequired, "list": attr.IsList,
		})
	}
	// Only writable values reach the prompt: the caller may attach the whole
	// instance, and a password field must never be echoed into an LLM request.
	allowedByName := make(map[string]cmdbAttributeSchema, len(allowed))
	for _, attr := range allowed {
		allowedByName[attr.Name] = attr
	}
	current := make(map[string]any, len(req.Values))
	for name, value := range req.Values {
		if _, ok := allowedByName[name]; ok {
			current[name] = value
		}
	}
	prompt := fmt.Sprintf(`你是 CMDB 实例表单助手。根据模型属性、当前值和用户描述，为可写字段生成建议值。
模型：%s
属性（只允许这些字段）：%s
当前值：%s
用户描述：%s
只输出严格 JSON，不要 markdown 代码块：
{"values":{...},"explanations":{"字段":"理由"},"skipped":["字段"],"warnings":["..."]}
规则：不要生成密码/文件/计算/链接/引用字段；不要编造属性名；值必须符合 value_type（0 整数,1 小数,2 文本,3 日期时间,4 日期,5 时间,6 JSON,7 布尔）；列表字段返回数组；解释用 %s。`,
		ref, mustJSON(schema), mustJSON(current), req.Intent, promptLanguage(req.Locale))

	raw, err := h.cmdbFormChat(ctx, prompt)
	if err != nil {
		return nil, err
	}
	var suggestion cmdbFormInstanceSuggestion
	if err := parseCMDBFormJSON(raw, &suggestion); err != nil {
		return nil, &cmdbFormAssistError{Status: http.StatusBadGateway, Msg: "parse: " + err.Error()}
	}
	values := map[string]any{}
	truncated := false
	for name, value := range suggestion.Values {
		attr, ok := allowedByName[name]
		if !ok {
			warnings = append(warnings, "ignored unknown or non-writable field: "+name)
			continue
		}
		if len(values) >= cmdbFormAssistMaxValues {
			truncated = true
			break
		}
		coerced, ok := coerceCMDBValue(attr, value)
		if !ok {
			warnings = append(warnings, "ignored value with wrong type: "+name)
			continue
		}
		values[name] = coerced
	}
	return &cmdbFormAssistResponse{
		Kind: "instance", Values: values,
		Explanations: suggestion.Explanations,
		Skipped:      suggestion.Skipped,
		Warnings:     append(warnings, suggestion.Warnings...),
		Truncated:    truncated,
	}, nil
}

func (h *Handler) cmdbAssistModel(ctx context.Context, req cmdbFormAssistRequest) (*cmdbFormAssistResponse, error) {
	if !cmdbFormAdmin(ctx) {
		return nil, errs.ErrForbidden
	}
	models, err := h.fetchCMDBModels(ctx)
	if err != nil {
		return nil, err
	}
	prompt := fmt.Sprintf(`你是 CMDB 模型设计助手。根据用户描述生成一个新模型的字段建议。
现有模型（name/alias/id）：%s
用户描述：%s
只输出严格 JSON，不要 markdown 代码块：
{"name":"lower_snake","alias":"显示名","unique_key":"唯一属性名","default_order_attr":"排序属性名","parent_ids":[1],"explanations":{},"warnings":[]}
规则：name 必须是 lower_snake（1-40 字符，字母开头）；alias 非空；unique_key/default_order_attr 是合法属性名；parent_ids 只能从现有模型 id 中选，且不能选自己；解释用 %s。`,
		mustJSON(models), req.Intent, promptLanguage(req.Locale))

	raw, err := h.cmdbFormChat(ctx, prompt)
	if err != nil {
		return nil, err
	}
	var suggestion cmdbFormModelSuggestion
	if err := parseCMDBFormJSON(raw, &suggestion); err != nil {
		return nil, &cmdbFormAssistError{Status: http.StatusBadGateway, Msg: "parse: " + err.Error()}
	}
	warnings := append([]string(nil), suggestion.Warnings...)
	name := strings.TrimSpace(suggestion.Name)
	if !cmdbFormNameRE.MatchString(name) {
		return nil, fmt.Errorf("%w: suggested model name is invalid", errs.ErrInvalid)
	}
	for _, existing := range models {
		if strings.EqualFold(existing.Name, name) {
			warnings = append(warnings, "model name already exists: "+name)
			break
		}
	}
	alias := strings.TrimSpace(suggestion.Alias)
	if alias == "" {
		return nil, fmt.Errorf("%w: suggested model alias is empty", errs.ErrInvalid)
	}
	uniqueKey := strings.TrimSpace(suggestion.UniqueKey)
	if uniqueKey != "" && !cmdbFormNameRE.MatchString(uniqueKey) {
		warnings = append(warnings, "ignored invalid unique_key")
		uniqueKey = ""
	}
	orderAttr := strings.TrimSpace(suggestion.DefaultOrderAttr)
	if orderAttr != "" && !cmdbFormNameRE.MatchString(orderAttr) {
		warnings = append(warnings, "ignored invalid default_order_attr")
		orderAttr = ""
	}
	existingIDs := make(map[int]bool, len(models))
	parentsByID := make(map[int][]int, len(models))
	for _, existing := range models {
		existingIDs[existing.ID] = true
		parentsByID[existing.ID] = existing.ParentIDs
	}
	parentIDs := make([]int, 0, len(suggestion.ParentIDs))
	seenParents := make(map[int]bool, len(suggestion.ParentIDs))
	for _, id := range suggestion.ParentIDs {
		if id == req.CIID || !existingIDs[id] || seenParents[id] {
			warnings = append(warnings, fmt.Sprintf("ignored invalid parent id: %d", id))
			continue
		}
		// Inheritance runs child → parent, so a proposed parent whose own
		// ancestor chain already reaches this model would close a cycle.
		if req.CIID != 0 && reachesModel(parentsByID, id, req.CIID) {
			warnings = append(warnings, fmt.Sprintf("ignored cyclic parent id: %d", id))
			continue
		}
		seenParents[id] = true
		parentIDs = append(parentIDs, id)
	}
	return &cmdbFormAssistResponse{
		Kind: "model", Name: name, Alias: alias, UniqueKey: uniqueKey,
		DefaultOrderAttr: orderAttr, ParentIDs: parentIDs,
		Explanations: suggestion.Explanations, Warnings: warnings,
	}, nil
}

func (h *Handler) cmdbAssistAttribute(ctx context.Context, req cmdbFormAssistRequest) (*cmdbFormAssistResponse, error) {
	if !cmdbFormAdmin(ctx) {
		return nil, errs.ErrForbidden
	}
	ref := strings.TrimSpace(req.ModelRef)
	// The attribute dictionary is global, so an empty model_ref is legitimate:
	// the suggestion is then checked against the dictionary's own create-time
	// uniqueness instead of one model's bound attributes.
	existing := []cmdbAttributeSchema{}
	if ref != "" {
		var err error
		existing, err = h.fetchCMBAttributes(ctx, ref)
		if err != nil {
			return nil, err
		}
	}
	existingNames := make(map[string]bool, len(existing))
	for _, attr := range existing {
		existingNames[attr.Name] = true
	}
	modelLabel := ref
	if modelLabel == "" {
		modelLabel = "（全局属性字典）"
	}
	prompt := fmt.Sprintf(`你是 CMDB 模型属性设计助手。根据用户描述为一个模型生成属性定义。
模型：%s
已有属性（name/alias/type）：%s
用户描述：%s
只输出严格 JSON，不要 markdown 代码块：
{"attributes":[{"name":"lower_snake","alias":"显示名","value_type":"2","is_required":true,"choice_values":["生产","测试"]}],"warnings":[]}
规则：name lower_snake 且不能与已有属性重复；alias 非空；value_type 只能是 0 整数 / 1 小数 / 2 文本 / 3 日期时间 / 4 日期 / 5 时间 / 6 JSON / 7 布尔；不要生成密码、文件、引用类型；最多 %d 个；解释用 %s。`,
		modelLabel, mustJSON(existingAttributeNames(existing)), req.Intent,
		cmdbFormAssistMaxAttributes, promptLanguage(req.Locale))

	raw, err := h.cmdbFormChat(ctx, prompt)
	if err != nil {
		return nil, err
	}
	var suggestion cmdbFormAttributeSuggestionEnvelope
	if err := parseCMDBFormJSON(raw, &suggestion); err != nil {
		return nil, &cmdbFormAssistError{Status: http.StatusBadGateway, Msg: "parse: " + err.Error()}
	}
	out := make([]map[string]any, 0, cmdbFormAssistMaxAttributes)
	warnings := append([]string(nil), suggestion.Warnings...)
	for _, attr := range suggestion.Attributes {
		if len(out) >= cmdbFormAssistMaxAttributes {
			warnings = append(warnings, "attribute list truncated")
			break
		}
		name := strings.TrimSpace(attr.Name)
		alias := strings.TrimSpace(attr.Alias)
		if !cmdbFormNameRE.MatchString(name) || existingNames[name] {
			warnings = append(warnings, "ignored invalid or duplicate attribute: "+name)
			continue
		}
		if alias == "" {
			warnings = append(warnings, "ignored attribute without alias: "+name)
			continue
		}
		if !cmdbFormValueTypes[attr.ValueType] {
			warnings = append(warnings, "ignored attribute with invalid type: "+name)
			continue
		}
		entry := map[string]any{
			"name": name, "alias": alias, "value_type": attr.ValueType,
			"is_required": attr.IsRequired,
		}
		if len(attr.ChoiceValues) > 0 && (attr.ValueType == "2" || attr.ValueType == "0" || attr.ValueType == "1") {
			entry["choice_values"] = attr.ChoiceValues
		}
		out = append(out, entry)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%w: no valid attribute suggestions", errs.ErrInvalid)
	}
	return &cmdbFormAssistResponse{Kind: "attribute", Attributes: out, Warnings: warnings}, nil
}

func (h *Handler) cmdbAssistRelationType(ctx context.Context, req cmdbFormAssistRequest) (*cmdbFormAssistResponse, error) {
	if !cmdbFormAdmin(ctx) {
		return nil, errs.ErrForbidden
	}
	existing, err := h.fetchCMDBRelationTypes(ctx)
	if err != nil {
		return nil, err
	}
	prompt := fmt.Sprintf(`你是 CMDB 关系类型设计助手。关系类型是模型关系共用的一套词表，关系图按 color 给边着色。
已有关系类型（id/name）：%s
用户描述：%s
只输出严格 JSON，不要 markdown 代码块：
{"name":"关系类型名","color":"#6366f1","warnings":[]}
规则：name 简洁明确（2-%d 个字符，中文或 lower_snake 均可），不能与已有名称重复；color 必须是 #rrggbb 或空字符串；解释用 %s。`,
		mustJSON(relationTypeNames(existing)), req.Intent, cmdbFormRelationTypeNameMax, promptLanguage(req.Locale))

	raw, err := h.cmdbFormChat(ctx, prompt)
	if err != nil {
		return nil, err
	}
	var suggestion cmdbFormRelationTypeSuggestion
	if err := parseCMDBFormJSON(raw, &suggestion); err != nil {
		return nil, &cmdbFormAssistError{Status: http.StatusBadGateway, Msg: "parse: " + err.Error()}
	}
	warnings := append([]string(nil), suggestion.Warnings...)
	name := strings.TrimSpace(suggestion.Name)
	if name == "" || len([]rune(name)) > cmdbFormRelationTypeNameMax {
		return nil, fmt.Errorf("%w: suggested relation type name is empty or too long", errs.ErrInvalid)
	}
	for _, item := range existing {
		if strings.EqualFold(strings.TrimSpace(item.Name), name) {
			warnings = append(warnings, "relation type name already exists: "+name)
			break
		}
	}
	color := strings.TrimSpace(suggestion.Color)
	if color != "" && !cmdbFormColorRE.MatchString(color) {
		warnings = append(warnings, "ignored invalid colour: "+color)
		color = ""
	}
	return &cmdbFormAssistResponse{
		Kind: "relation_type", Name: name, Color: color, Warnings: warnings,
	}, nil
}

func (h *Handler) cmdbAssistModelRelation(ctx context.Context, req cmdbFormAssistRequest) (*cmdbFormAssistResponse, error) {
	if !cmdbFormAdmin(ctx) {
		return nil, errs.ErrForbidden
	}
	models, err := h.fetchCMDBModels(ctx)
	if err != nil {
		return nil, err
	}
	relationTypes, err := h.fetchCMDBRelationTypes(ctx)
	if err != nil {
		return nil, err
	}
	if len(relationTypes) == 0 {
		return nil, fmt.Errorf("%w: create a relation type before asking AI for a model relation", errs.ErrInvalid)
	}

	var source, target *cmdbModelRef
	if ref := strings.TrimSpace(req.SourceModelRef); ref != "" {
		found, ok := findCMDBModel(models, ref)
		if !ok {
			return nil, fmt.Errorf("%w: source model %q not found", errs.ErrInvalid, ref)
		}
		source = &found
	}
	if ref := strings.TrimSpace(req.TargetModelRef); ref != "" {
		found, ok := findCMDBModel(models, ref)
		if !ok {
			return nil, fmt.Errorf("%w: target model %q not found", errs.ErrInvalid, ref)
		}
		target = &found
	}
	if source != nil && target != nil && source.ID == target.ID {
		return nil, fmt.Errorf("%w: source and target must differ", errs.ErrInvalid)
	}

	var sourceAttrs, targetAttrs []cmdbAttributeSchema
	if source != nil {
		sourceAttrs, err = h.fetchCMBAttributes(ctx, strconv.Itoa(source.ID))
		if err != nil {
			return nil, err
		}
	}
	if target != nil {
		targetAttrs, err = h.fetchCMBAttributes(ctx, strconv.Itoa(target.ID))
		if err != nil {
			return nil, err
		}
	}

	fixed := ""
	if source != nil {
		fixed += fmt.Sprintf("\n源模型已固定为 %s（%s，id=%d），不要更换。", source.Name, source.Alias, source.ID)
	}
	if target != nil {
		fixed += fmt.Sprintf("\n目标模型已固定为 %s（%s，id=%d），不要更换。", target.Name, target.Alias, target.ID)
	}
	prompt := fmt.Sprintf(`你是 CMDB 模型关系设计助手。模型关系表示“源 CI 类型 → 目标 CI 类型（父 → 子）”，资源层级树按它展开。
可用模型（id/name/alias）：%s
可用关系类型（id/name）：%s
源模型属性（name/alias/type）：%s
目标模型属性（name/alias/type）：%s%s
用户描述：%s
只输出严格 JSON，不要 markdown 代码块：
{"source_model":"模型 name 或 id","target_model":"模型 name 或 id","relation_type":"关系类型 name 或 id","constraint":"0|1|2","parent_attributes":["源属性名"],"child_attributes":["目标属性名"],"explanations":{},"warnings":[]}
规则：源和目标必须是上面列出的模型且不能相同；relation_type 必须来自上面列出的类型；constraint 只能是 0 一对多 / 1 一对一 / 2 多对多；属性关联按位置配对，只使用上面列出的属性名，没有合适属性时返回空数组；解释用 %s。`,
		mustJSON(models), mustJSON(relationTypeNames(relationTypes)),
		mustJSON(attributeDigest(sourceAttrs)), mustJSON(attributeDigest(targetAttrs)),
		fixed, req.Intent, promptLanguage(req.Locale))

	raw, err := h.cmdbFormChat(ctx, prompt)
	if err != nil {
		return nil, err
	}
	var suggestion cmdbFormModelRelationSuggestion
	if err := parseCMDBFormJSON(raw, &suggestion); err != nil {
		return nil, &cmdbFormAssistError{Status: http.StatusBadGateway, Msg: "parse: " + err.Error()}
	}
	warnings := append([]string(nil), suggestion.Warnings...)

	if source == nil {
		found, ok := findCMDBModel(models, suggestion.SourceModel)
		if !ok {
			return nil, fmt.Errorf("%w: suggested source model %q not found", errs.ErrInvalid, suggestion.SourceModel)
		}
		source = &found
	}
	if target == nil {
		found, ok := findCMDBModel(models, suggestion.TargetModel)
		if !ok {
			return nil, fmt.Errorf("%w: suggested target model %q not found", errs.ErrInvalid, suggestion.TargetModel)
		}
		target = &found
	}
	if source.ID == target.ID {
		return nil, fmt.Errorf("%w: source and target must differ", errs.ErrInvalid)
	}
	relationType, ok := findCMDBRelationType(relationTypes, suggestion.RelationType)
	if !ok {
		return nil, fmt.Errorf("%w: suggested relation type %q not found", errs.ErrInvalid, suggestion.RelationType)
	}

	if sourceAttrs == nil {
		sourceAttrs, err = h.fetchCMBAttributes(ctx, strconv.Itoa(source.ID))
		if err != nil {
			return nil, err
		}
	}
	if targetAttrs == nil {
		targetAttrs, err = h.fetchCMBAttributes(ctx, strconv.Itoa(target.ID))
		if err != nil {
			return nil, err
		}
	}

	constraint := strings.TrimSpace(suggestion.Constraint)
	if constraint != "0" && constraint != "1" && constraint != "2" {
		warnings = append(warnings, "ignored invalid constraint; defaulted to one-to-many")
		constraint = "0"
	}

	parentIDs, childIDs, pairWarnings := resolveAttributePairs(
		sourceAttrs, targetAttrs, suggestion.ParentAttributes, suggestion.ChildAttributes,
	)
	warnings = append(warnings, pairWarnings...)

	return &cmdbFormAssistResponse{
		Kind:           "model_relation",
		SourceModelID:  source.ID,
		TargetModelID:  target.ID,
		RelationTypeID: relationType.ID,
		Constraint:     constraint,
		ParentAttrIDs:  parentIDs,
		ChildAttrIDs:   childIDs,
		Explanations:   suggestion.Explanations,
		Warnings:       warnings,
	}, nil
}

func (h *Handler) cmdbFormChat(ctx context.Context, prompt string) (string, error) {
	resp, err := h.llmClient.Chat(ctx, llm.ChatReq{
		Messages: []llm.Message{
			{Role: "system", Content: "你是 CMDB 表单助手。只输出严格 JSON，不输出 markdown 代码块或解释性前后缀。"},
			{Role: "user", Content: prompt},
		},
		Temperature: 0.1,
	})
	if err != nil {
		return "", &cmdbFormAssistError{Status: http.StatusBadGateway, Msg: "llm: " + err.Error()}
	}
	return resp.Assistant.Content, nil
}

type cmdbModelRef struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	Alias     string `json:"alias"`
	ParentIDs []int  `json:"parent_ids"`
}

type cmdbRelationTypeRef struct {
	ID    int    `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

func (h *Handler) fetchCMDBModels(ctx context.Context) ([]cmdbModelRef, error) {
	raw, err := h.cmdb.Get(ctx, "/ci-types", nil)
	if err != nil {
		return nil, cmdbSchemaError(err)
	}
	var got struct {
		Items []cmdbModelRef `json:"items"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		return nil, fmt.Errorf("cmdb form assist: decode models: %w", err)
	}
	return got.Items, nil
}

func (h *Handler) fetchCMDBRelationTypes(ctx context.Context) ([]cmdbRelationTypeRef, error) {
	raw, err := h.cmdb.Get(ctx, "/relation-types", nil)
	if err != nil {
		return nil, cmdbSchemaError(err)
	}
	var got struct {
		Items []cmdbRelationTypeRef `json:"items"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		return nil, fmt.Errorf("cmdb form assist: decode relation types: %w", err)
	}
	return got.Items, nil
}

func relationTypeNames(items []cmdbRelationTypeRef) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		out = append(out, map[string]any{"id": item.ID, "name": item.Name})
	}
	return out
}

func attributeDigest(attrs []cmdbAttributeSchema) []map[string]any {
	out := make([]map[string]any, 0, len(attrs))
	for _, attr := range attrs {
		out = append(out, map[string]any{
			"name": attr.Name, "alias": attr.Alias, "value_type": attr.ValueType,
		})
	}
	return out
}

func findCMDBModel(models []cmdbModelRef, ref string) (cmdbModelRef, bool) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return cmdbModelRef{}, false
	}
	if id, err := strconv.Atoi(ref); err == nil {
		for _, model := range models {
			if model.ID == id {
				return model, true
			}
		}
	}
	for _, model := range models {
		if strings.EqualFold(model.Name, ref) || strings.EqualFold(model.Alias, ref) {
			return model, true
		}
	}
	return cmdbModelRef{}, false
}

func findCMDBRelationType(items []cmdbRelationTypeRef, ref string) (cmdbRelationTypeRef, bool) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return cmdbRelationTypeRef{}, false
	}
	if id, err := strconv.Atoi(ref); err == nil {
		for _, item := range items {
			if item.ID == id {
				return item, true
			}
		}
	}
	for _, item := range items {
		if strings.EqualFold(item.Name, ref) {
			return item, true
		}
	}
	return cmdbRelationTypeRef{}, false
}

func findCMDBAttribute(attrs []cmdbAttributeSchema, ref string) (cmdbAttributeSchema, bool) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return cmdbAttributeSchema{}, false
	}
	for _, attr := range attrs {
		if attr.Name == ref {
			return attr, true
		}
	}
	for _, attr := range attrs {
		if strings.EqualFold(attr.Name, ref) || strings.EqualFold(attr.Alias, ref) {
			return attr, true
		}
	}
	return cmdbAttributeSchema{}, false
}

// resolveAttributePairs maps suggested attribute names to binding ids. Pairs are
// positional, as in the form; an unresolvable side drops the whole pair so the
// form never receives half an association.
func resolveAttributePairs(
	sourceAttrs, targetAttrs []cmdbAttributeSchema,
	parentNames, childNames []string,
) ([]int, []int, []string) {
	warnings := make([]string, 0)
	if len(parentNames) != len(childNames) {
		warnings = append(warnings, "attribute association lists differ in length; using the shorter side")
	}
	limit := len(parentNames)
	if len(childNames) < limit {
		limit = len(childNames)
	}
	if limit > cmdbFormAssistMaxPairs {
		warnings = append(warnings, "attribute association list truncated")
		limit = cmdbFormAssistMaxPairs
	}
	parentIDs := make([]int, 0, limit)
	childIDs := make([]int, 0, limit)
	for index := 0; index < limit; index++ {
		source, sourceOK := findCMDBAttribute(sourceAttrs, parentNames[index])
		target, targetOK := findCMDBAttribute(targetAttrs, childNames[index])
		if !sourceOK || !targetOK {
			warnings = append(warnings, fmt.Sprintf(
				"ignored attribute pair: %s → %s", parentNames[index], childNames[index],
			))
			continue
		}
		parentIDs = append(parentIDs, source.ID)
		childIDs = append(childIDs, target.ID)
	}
	return parentIDs, childIDs, warnings
}

func (h *Handler) fetchCMBAttributes(ctx context.Context, ref string) ([]cmdbAttributeSchema, error) {
	raw, err := h.cmdb.Get(ctx, "/ci-types/"+url.PathEscape(ref)+"/attributes", nil)
	if err != nil {
		return nil, cmdbSchemaError(err)
	}
	var got struct {
		Attributes []cmdbAttributeSchema `json:"attributes"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		return nil, fmt.Errorf("cmdb form assist: decode attributes: %w", err)
	}
	return got.Attributes, nil
}

func writableAttributes(attrs []cmdbAttributeSchema, fields []string) ([]cmdbAttributeSchema, []string) {
	wanted := make(map[string]bool, len(fields))
	for _, field := range fields {
		if field = strings.TrimSpace(field); field != "" {
			wanted[field] = true
		}
	}
	out := make([]cmdbAttributeSchema, 0, len(attrs))
	warnings := make([]string, 0)
	for _, attr := range attrs {
		if attr.IsComputed || attr.IsPassword || attr.IsFile || attr.IsLink || attr.IsReference {
			continue
		}
		if len(wanted) > 0 && !wanted[attr.Name] {
			continue
		}
		out = append(out, attr)
	}
	if len(fields) > 0 {
		for field := range wanted {
			found := false
			for _, attr := range out {
				if attr.Name == field {
					found = true
					break
				}
			}
			if !found {
				warnings = append(warnings, "ignored unknown or non-writable field: "+field)
			}
		}
	}
	return out, warnings
}

func coerceCMDBValue(attr cmdbAttributeSchema, value any) (any, bool) {
	if value == nil {
		return nil, true
	}
	if attr.IsList {
		list, ok := value.([]any)
		if !ok {
			return nil, false
		}
		out := make([]any, 0, len(list))
		for _, item := range list {
			coerced, ok := coerceCMDBScalar(attr.ValueType, item)
			if !ok {
				return nil, false
			}
			out = append(out, coerced)
		}
		return out, true
	}
	return coerceCMDBScalar(attr.ValueType, value)
}

func coerceCMDBScalar(valueType string, value any) (any, bool) {
	switch valueType {
	case "0":
		switch n := value.(type) {
		case float64:
			return int64(n), true
		case json.Number:
			i, err := n.Int64()
			return i, err == nil
		case int:
			return int64(n), true
		case int64:
			return n, true
		}
	case "1":
		switch n := value.(type) {
		case float64:
			return n, true
		case json.Number:
			f, err := n.Float64()
			return f, err == nil
		case int:
			return float64(n), true
		case int64:
			return float64(n), true
		}
	case "7":
		if b, ok := value.(bool); ok {
			return b, true
		}
	case "2", "3", "4", "5":
		if s, ok := value.(string); ok {
			return s, true
		}
	case "6":
		return value, true
	default:
		return value, true
	}
	return nil, false
}

func parseCMDBFormJSON(raw string, out any) error {
	raw = strings.TrimSpace(raw)
	if m := fenceRe.FindStringSubmatch(raw); len(m) > 1 {
		raw = m[1]
	}
	if i := strings.IndexByte(raw, '{'); i > 0 {
		raw = raw[i:]
	}
	if j := strings.LastIndexByte(raw, '}'); j >= 0 && j+1 < len(raw) {
		raw = raw[:j+1]
	}
	return json.Unmarshal([]byte(raw), out)
}

func cmdbFormAdmin(ctx context.Context) bool {
	tenant, ok := tenantctx.From(ctx)
	return ok && (tenant.IsSuperuser || tenant.Role == "admin")
}

// cmdbSchemaError keeps a CMDB 4xx (unknown model, no permission) as the same
// client-facing status instead of flattening it into a 500.
func cmdbSchemaError(err error) error {
	var api *cmdb.APIError
	if errors.As(err, &api) {
		return &cmdbFormAssistError{Status: api.Status, Msg: api.Error()}
	}
	return err
}

// reachesModel reports whether target is start or one of start's ancestors in
// the parent graph. Iterative DFS with a visited set, so a pre-existing cyclic
// edge cannot spin forever.
func reachesModel(parentsByID map[int][]int, start, target int) bool {
	stack := []int{start}
	seen := make(map[int]bool, len(parentsByID))
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if id == target {
			return true
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		stack = append(stack, parentsByID[id]...)
	}
	return false
}

func promptLanguage(locale string) string {
	if strings.HasPrefix(strings.ToLower(locale), "en") {
		return "English"
	}
	return "中文"
}

func mustJSON(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(raw)
}

func existingAttributeNames(attrs []cmdbAttributeSchema) []map[string]string {
	out := make([]map[string]string, 0, len(attrs))
	for _, attr := range attrs {
		out = append(out, map[string]string{
			"name": attr.Name, "alias": attr.Alias, "value_type": attr.ValueType,
		})
	}
	return out
}
