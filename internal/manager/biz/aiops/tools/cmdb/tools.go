package cmdb

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ongridio/ongrid/internal/manager/biz/aiops/tools/basetool"
)

const (
	ToolNameSearchCI          = "cmdb_search_ci"
	ToolNameGetCI             = "cmdb_get_ci"
	ToolNameListCITypes       = "cmdb_list_ci_types"
	ToolNameGetCIType         = "cmdb_get_ci_type"
	ToolNameListRelationTypes = "cmdb_list_relation_types"
	ToolNameGetCIRelations    = "cmdb_get_ci_relations"
	ToolNameQueryRelationPath = "cmdb_query_relation_path"
	ToolNameFindCITypePath    = "cmdb_find_ci_type_path"
	ToolNameGetCIHistory      = "cmdb_get_ci_history"
	ToolNameRelationGraph     = "cmdb_relation_graph"
)

const (
	maxItems = 20
	maxAttrs = 5
	// maxExplicitAttrs is the budget when the caller names fields/fl
	// explicitly. Anything the caller asked for is honoured up to this cap;
	// beyond it the result carries a note instead of silently dropping them.
	maxExplicitAttrs = 20
	// maxRelationTypes is the vocabulary's cap. It is larger than a page of
	// CIs because a full ontology can carry tens of words and the model needs
	// the whole dictionary to interpret an edge.
	maxRelationTypes = 100
)

// tool is a read-only CMDB capability with a declarative JSON Schema. The
// ten P0 tools differ only in their schema and run function, so one type
// keeps them auditable in one file instead of ten near-identical structs.
type tool struct {
	name        string
	description string
	whenToUse   string
	schema      json.RawMessage
	run         func(context.Context, json.RawMessage) (any, error)
}

func (t *tool) Info(context.Context) (*basetool.ToolInfo, error) {
	return &basetool.ToolInfo{
		Name:        t.name,
		Description: t.description,
		WhenToUse:   t.whenToUse,
		Parameters:  t.schema,
		Class:       "read",
	}, nil
}

func (t *tool) InvokableRun(ctx context.Context, argsJSON string, _ ...basetool.InvokeOption) (string, error) {
	if strings.TrimSpace(argsJSON) == "" {
		argsJSON = "{}"
	}
	out, err := t.run(ctx, json.RawMessage(argsJSON))
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(out)
	if err != nil {
		return "", fmt.Errorf("%s: encode result: %w", t.name, err)
	}
	return string(data), nil
}

// Tools returns the P0 read-only CMDB tools. A nil client means the
// deployment has no CMDB configured, so no tool is registered.
func Tools(c *Client) []basetool.BaseTool {
	if c == nil {
		return nil
	}
	return []basetool.BaseTool{
		newSearchCITool(c),
		newGetCITool(c),
		newListCITypesTool(c),
		newGetCITypeTool(c),
		newListRelationTypesTool(c),
		newGetCIRelationsTool(c),
		newQueryRelationPathTool(c),
		newFindCITypePathTool(c),
		newGetCIHistoryTool(c),
		newRelationGraphTool(c),
	}
}

var searchCISchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "q": {"type": "string", "description": "CMDB search expression. Use _type:<model> and attribute filters, e.g. \"_type:host private_ip:10.0.0.1\". The backend returns an error explaining the syntax for a malformed expression."},
    "page": {"type": "integer", "minimum": 1, "default": 1},
    "count": {"type": "integer", "minimum": 1, "maximum": 20, "default": 20},
    "sort": {"type": "string", "description": "Sort expression, e.g. -_updated_at for recent changes."},
    "fl": {"type": "string", "description": "Comma-separated attribute list to return (up to 20; all named fields are honoured within that cap)."}
  },
  "required": ["q"]
}`)

type searchCIArgs struct {
	Q     string `json:"q"`
	Page  int    `json:"page"`
	Count int    `json:"count"`
	Sort  string `json:"sort"`
	FL    string `json:"fl"`
}

func newSearchCITool(c *Client) basetool.BaseTool {
	return &tool{
		name:        ToolNameSearchCI,
		description: "Search CMDB configuration items (CIs) by query expression.",
		whenToUse:   "Use this first when you know a hostname, IP, model, or attribute value and need the CI id, type, or current attributes.",
		schema:      searchCISchema,
		run: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var args searchCIArgs
			if err := json.Unmarshal(raw, &args); err != nil {
				return nil, fmt.Errorf("cmdb_search_ci: bad args: %w", err)
			}
			if strings.TrimSpace(args.Q) == "" {
				return nil, errors.New("cmdb_search_ci: q is required")
			}
			page := args.Page
			if page <= 0 {
				page = 1
			}
			count := args.Count
			if count <= 0 || count > maxItems {
				count = maxItems
			}
			query := url.Values{"q": {args.Q}, "page": {strconv.Itoa(page)}, "count": {strconv.Itoa(count)}}
			if args.Sort != "" {
				query.Set("sort", args.Sort)
			}
			if args.FL != "" {
				query.Set("fl", args.FL)
			}
			data, err := c.Get(ctx, "/ci/s", query)
			if err != nil {
				return nil, err
			}
			var pageData struct {
				NumFound int              `json:"numfound"`
				Page     int              `json:"page"`
				Result   []map[string]any `json:"result"`
			}
			if err := json.Unmarshal(data, &pageData); err != nil {
				return nil, fmt.Errorf("cmdb_search_ci: decode response: %w", err)
			}
			budget := maxAttrs
			fieldsNote := ""
			if requested := splitCSV(args.FL); len(requested) > 0 {
				budget = len(requested)
				if budget > maxExplicitAttrs {
					budget = maxExplicitAttrs
					fieldsNote = fmt.Sprintf("Requested fields truncated to %d; request fewer fields per call.", maxExplicitAttrs)
				}
			}
			items := make([]any, 0, len(pageData.Result))
			for _, row := range pageData.Result {
				items = append(items, CompactCI(row, budget))
			}
			out := Truncate(items, maxItems, pageData.NumFound)
			out["page"] = pageData.Page
			if fieldsNote != "" {
				out["note"] = joinNotes(out["note"], fieldsNote)
			}
			return out, nil
		},
	}
}

var getCISchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "ci_id": {"type": "integer", "minimum": 1, "description": "Numeric CI id returned by cmdb_search_ci."},
    "fields": {"type": "string", "description": "Comma-separated attributes to return (up to 20); omitted means a 5-attribute summary."}
  },
  "required": ["ci_id"]
}`)

type getCIArgs struct {
	CIID   int    `json:"ci_id"`
	Fields string `json:"fields"`
}

func newGetCITool(c *Client) basetool.BaseTool {
	return &tool{
		name:        ToolNameGetCI,
		description: "Fetch one CMDB configuration item by numeric id.",
		whenToUse:   "Use after cmdb_search_ci when you need the attributes you name (up to 20) or a summary of one CI.",
		schema:      getCISchema,
		run: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var args getCIArgs
			if err := json.Unmarshal(raw, &args); err != nil {
				return nil, fmt.Errorf("cmdb_get_ci: bad args: %w", err)
			}
			if args.CIID <= 0 {
				return nil, errors.New("cmdb_get_ci: ci_id is required")
			}
			query := url.Values{}
			if args.Fields != "" {
				query.Set("fields", args.Fields)
			}
			data, err := c.Get(ctx, fmt.Sprintf("/instances/%d", args.CIID), query)
			if err != nil {
				return nil, err
			}
			var dto map[string]any
			if err := json.Unmarshal(data, &dto); err != nil {
				return nil, fmt.Errorf("cmdb_get_ci: decode response: %w", err)
			}
			budget := maxAttrs
			note := ""
			if requested := splitCSV(args.Fields); len(requested) > 0 {
				budget = len(requested)
				if budget > maxExplicitAttrs {
					budget = maxExplicitAttrs
					note = fmt.Sprintf("Requested fields truncated to %d; request fewer fields per call.", maxExplicitAttrs)
				}
			}
			out := map[string]any{"ci": normalizeInstance(dto, budget)}
			if note != "" {
				out["note"] = note
			}
			return out, nil
		},
	}
}

// normalizeInstance flattens the instance DTO's nested values so a CI looks
// the same whether it came from search or from a single-instance read.
func normalizeInstance(dto map[string]any, maxAttrs int) map[string]any {
	if values, ok := dto["values"].(map[string]any); ok {
		delete(dto, "values")
		for k, v := range values {
			dto[k] = v
		}
	}
	rename := map[string]string{
		"type_id": "_type", "created_at": "_created_at", "updated_at": "_updated_at",
		"created_by": "_created_by", "updated_by": "_updated_by",
	}
	for from, to := range rename {
		if v, ok := dto[from]; ok {
			dto[to] = v
			delete(dto, from)
		}
	}
	return CompactCI(dto, maxAttrs)
}

var listCITypesSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "name": {"type": "string", "description": "Filter by model name."},
    "ids": {"type": "string", "description": "Comma-separated numeric model ids."}
  }
}`)

type listCITypesArgs struct {
	Name string `json:"name"`
	IDs  string `json:"ids"`
}

func newListCITypesTool(c *Client) basetool.BaseTool {
	return &tool{
		name:        ToolNameListCITypes,
		description: "List CMDB models (CI types).",
		whenToUse:   "Use to discover which models exist before building a search expression or an attribute query.",
		schema:      listCITypesSchema,
		run: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var args listCITypesArgs
			if err := json.Unmarshal(raw, &args); err != nil {
				return nil, fmt.Errorf("cmdb_list_ci_types: bad args: %w", err)
			}
			query := url.Values{}
			if args.Name != "" {
				query.Set("name", args.Name)
			}
			if args.IDs != "" {
				query.Set("ids", args.IDs)
			}
			data, err := c.Get(ctx, "/ci-types", query)
			if err != nil {
				return nil, err
			}
			var page struct {
				Items []map[string]any `json:"items"`
				Total int              `json:"total"`
			}
			if err := json.Unmarshal(data, &page); err != nil {
				return nil, fmt.Errorf("cmdb_list_ci_types: decode response: %w", err)
			}
			items := make([]any, 0, len(page.Items))
			for _, item := range page.Items {
				items = append(items, CompactCIType(item))
			}
			return Truncate(items, maxItems, page.Total), nil
		},
	}
}

var listRelationTypesSchema = json.RawMessage(`{
  "type": "object",
  "properties": {}
}`)

type relationTypeDTO struct {
	ID                int      `json:"id"`
	Name              string   `json:"name"`
	Color             string   `json:"color"`
	Category          string   `json:"category"`
	Direction         string   `json:"direction"`
	PropagatesDefault bool     `json:"propagates_default"`
	WeightDefault     float64  `json:"weight_default"`
	InverseOf         string   `json:"inverse_of"`
	Transitive        bool     `json:"transitive"`
	SubPropertyOf     []string `json:"sub_property_of"`
	DisplayNameZH     string   `json:"display_name_zh"`
	DisplayNameEN     string   `json:"display_name_en"`
	Description       string   `json:"description"`
	Deprecated        bool     `json:"deprecated"`
	Replacement       string   `json:"replacement"`
	Revision          int      `json:"revision"`
}

func newListRelationTypesTool(c *Client) basetool.BaseTool {
	return &tool{
		name:        ToolNameListRelationTypes,
		description: "List the CMDB relation-type vocabulary and its AIOps semantics.",
		whenToUse:   "Use before interpreting a relation_type_id, or when deciding whether an edge propagates and in which direction.",
		schema:      listRelationTypesSchema,
		run: func(ctx context.Context, raw json.RawMessage) (any, error) {
			if len(raw) > 0 {
				var args map[string]any
				if err := json.Unmarshal(raw, &args); err != nil {
					return nil, fmt.Errorf("cmdb_list_relation_types: bad args: %w", err)
				}
			}
			data, err := c.Get(ctx, "/relation-types", nil)
			if err != nil {
				return nil, err
			}
			var page struct {
				Items []relationTypeDTO `json:"items"`
				Total int               `json:"total"`
			}
			if err := json.Unmarshal(data, &page); err != nil {
				return nil, fmt.Errorf("cmdb_list_relation_types: decode response: %w", err)
			}
			items := make([]any, 0, len(page.Items))
			for _, rt := range page.Items {
				items = append(items, map[string]any{
					"id": rt.ID, "name": rt.Name, "color": rt.Color,
					"category": rt.Category, "direction": rt.Direction,
					"propagates": rt.PropagatesDefault, "weight": rt.WeightDefault,
					"inverse_of": rt.InverseOf, "transitive": rt.Transitive,
					"sub_property_of": rt.SubPropertyOf,
					"display_name_zh": rt.DisplayNameZH, "display_name_en": rt.DisplayNameEN,
					"description": rt.Description,
					"deprecated":  rt.Deprecated, "replacement": rt.Replacement,
					"revision": rt.Revision,
				})
			}
			return Truncate(items, maxRelationTypes, page.Total), nil
		},
	}
}

var getCITypeSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "ref": {"type": "string", "description": "Model id or model name."}
  },
  "required": ["ref"]
}`)

type getCITypeArgs struct {
	Ref string `json:"ref"`
}

func newGetCITypeTool(c *Client) basetool.BaseTool {
	return &tool{
		name:        ToolNameGetCIType,
		description: "Return a CMDB model's definition and attribute schema.",
		whenToUse:   "Use before interpreting attribute values or writing a search expression for a model you have not seen.",
		schema:      getCITypeSchema,
		run: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var args getCITypeArgs
			if err := json.Unmarshal(raw, &args); err != nil {
				return nil, fmt.Errorf("cmdb_get_ci_type: bad args: %w", err)
			}
			ref := strings.TrimSpace(args.Ref)
			if ref == "" {
				return nil, errors.New("cmdb_get_ci_type: ref is required")
			}
			escaped := url.PathEscape(ref)
			typ, err := c.Get(ctx, "/ci-types/"+escaped, nil)
			if err != nil {
				return nil, err
			}
			attrs, err := c.Get(ctx, "/ci-types/"+escaped+"/attributes", nil)
			if err != nil {
				return nil, err
			}
			var typeValue any
			var attrValue any
			if err := json.Unmarshal(typ, &typeValue); err != nil {
				return nil, fmt.Errorf("cmdb_get_ci_type: decode type: %w", err)
			}
			if err := json.Unmarshal(attrs, &attrValue); err != nil {
				return nil, fmt.Errorf("cmdb_get_ci_type: decode attributes: %w", err)
			}
			return map[string]any{"type": typeValue, "attributes": attrValue}, nil
		},
	}
}

var getCIRelationsSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "ci_id": {"type": "integer", "minimum": 1},
    "direction": {"type": "string", "enum": ["down", "up"], "default": "down", "description": "down = children, up = parents."},
    "page": {"type": "integer", "minimum": 1, "default": 1},
    "count": {"type": "integer", "minimum": 1, "maximum": 20, "default": 20},
    "relation_type_id": {"type": "integer", "minimum": 1, "description": "Restrict to one relation type."}
  },
  "required": ["ci_id"]
}`)

type getCIRelationsArgs struct {
	CIID           int    `json:"ci_id"`
	Direction      string `json:"direction"`
	Page           int    `json:"page"`
	Count          int    `json:"count"`
	RelationTypeID int    `json:"relation_type_id"`
}

type neighbour struct {
	RelationID     int `json:"relation_id"`
	CIID           int `json:"ci_id"`
	TypeID         int `json:"type_id"`
	RelationTypeID int `json:"relation_type_id"`

	// The CMDB resolves the edge's vocabulary once per page; carrying it here
	// lets the model decide whether the edge propagates without a second tool
	// call.
	RelationTypeName       string  `json:"relation_type_name"`
	RelationTypeCategory   string  `json:"relation_type_category"`
	RelationTypeDirection  string  `json:"relation_type_direction"`
	RelationTypePropagates bool    `json:"relation_type_propagates"`
	RelationTypeWeight     float64 `json:"relation_type_weight"`

	// Provenance of the edge, so the model can tell a collector's observation
	// from a manual entry or an inference.
	EvidenceSource string     `json:"evidence_source"`
	Confidence     *float64   `json:"confidence"`
	ObservedAt     *time.Time `json:"observed_at"`

	// Props is the edge-attribute object (protocol, endpoint, ...).
	Props json.RawMessage `json:"props"`
}

func newGetCIRelationsTool(c *Client) basetool.BaseTool {
	return &tool{
		name:        ToolNameGetCIRelations,
		description: "List one CI's direct neighbours in the CMDB relation graph.",
		whenToUse:   "Use to find a host's parent business system, children, or upstream/downstream dependencies before assessing blast radius.",
		schema:      getCIRelationsSchema,
		run: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var args getCIRelationsArgs
			if err := json.Unmarshal(raw, &args); err != nil {
				return nil, fmt.Errorf("cmdb_get_ci_relations: bad args: %w", err)
			}
			if args.CIID <= 0 {
				return nil, errors.New("cmdb_get_ci_relations: ci_id is required")
			}
			side := "children"
			direction := strings.ToLower(strings.TrimSpace(args.Direction))
			if direction == "up" {
				side = "parents"
			} else if direction == "" {
				// The schema defaults to "down"; report the side actually
				// queried instead of an empty string.
				direction = "down"
			}
			page := args.Page
			if page <= 0 {
				page = 1
			}
			count := args.Count
			if count <= 0 || count > maxItems {
				count = maxItems
			}
			query := url.Values{"page": {strconv.Itoa(page)}, "count": {strconv.Itoa(count)}}
			if args.RelationTypeID > 0 {
				query.Set("relation_type_id", strconv.Itoa(args.RelationTypeID))
			}
			data, err := c.Get(ctx, fmt.Sprintf("/ci-relations/%d/%s", args.CIID, side), query)
			if err != nil {
				return nil, err
			}
			var pageData struct {
				Items    []neighbour `json:"items"`
				NumFound int         `json:"numfound"`
				Page     int         `json:"page"`
			}
			if err := json.Unmarshal(data, &pageData); err != nil {
				return nil, fmt.Errorf("cmdb_get_ci_relations: decode response: %w", err)
			}
			items := make([]any, 0, len(pageData.Items))
			for _, n := range pageData.Items {
				item := map[string]any{
					"relation_id": n.RelationID, "ci_id": n.CIID,
					"type_id": n.TypeID, "relation_type_id": n.RelationTypeID,
					"relation_type_name":       n.RelationTypeName,
					"relation_type_category":   n.RelationTypeCategory,
					"relation_type_direction":  n.RelationTypeDirection,
					"relation_type_propagates": n.RelationTypePropagates,
					"relation_type_weight":     n.RelationTypeWeight,
				}
				if n.EvidenceSource != "" {
					item["evidence_source"] = n.EvidenceSource
				}
				if n.Confidence != nil {
					item["confidence"] = *n.Confidence
				}
				if n.ObservedAt != nil {
					item["observed_at"] = n.ObservedAt
				}
				if len(n.Props) > 0 {
					item["props"] = n.Props
				}
				items = append(items, item)
			}
			out := Truncate(items, maxItems, pageData.NumFound)
			out["page"] = pageData.Page
			out["direction"] = direction
			return out, nil
		},
	}
}

var queryRelationPathSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "source": {
      "type": "object",
      "properties": {
        "type_id": {"type": "integer", "minimum": 1, "description": "Model id the paths start from."},
        "q": {"type": "string", "description": "Search expression narrowing source instances; empty means all."}
      },
      "required": ["type_id"]
    },
    "target": {
      "type": "object",
      "properties": {
        "q": {"type": "string", "description": "Search expression narrowing target instances; empty means all. The target models are the declared chains' tails."}
      }
    },
    "path": {
      "type": "array",
      "description": "One or more model-id chains from source to target. Chain order is the relation direction and is not interchangeable.",
      "items": {"type": "array", "items": {"type": "integer", "minimum": 1}}
    },
    "page": {"type": "integer", "minimum": 1, "default": 1},
    "count": {"type": "integer", "minimum": 1, "maximum": 20, "default": 20}
  },
  "required": ["source", "path"]
}`)

type queryRelationPathArgs struct {
	Source struct {
		TypeID int    `json:"type_id"`
		Q      string `json:"q"`
	} `json:"source"`
	Target struct {
		Q string `json:"q"`
	} `json:"target"`
	Path  [][]int `json:"path"`
	Page  int     `json:"page"`
	Count int     `json:"count"`
}

func newQueryRelationPathTool(c *Client) basetool.BaseTool {
	return &tool{
		name:        ToolNameQueryRelationPath,
		description: "Find instance paths between source and target CIs along declared model chains.",
		whenToUse:   "Use when you need to know how two sets of CIs are connected (service -> cluster -> host) rather than just direct neighbours.",
		schema:      queryRelationPathSchema,
		run: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var args queryRelationPathArgs
			if err := json.Unmarshal(raw, &args); err != nil {
				return nil, fmt.Errorf("cmdb_query_relation_path: bad args: %w", err)
			}
			if args.Source.TypeID <= 0 {
				return nil, errors.New("cmdb_query_relation_path: source.type_id is required")
			}
			if len(args.Path) == 0 {
				return nil, errors.New("cmdb_query_relation_path: path is required")
			}
			page := args.Page
			if page <= 0 {
				page = 1
			}
			count := args.Count
			if count <= 0 || count > maxItems {
				count = maxItems
			}
			body := map[string]any{
				"source": map[string]any{"type_id": args.Source.TypeID, "q": args.Source.Q},
				"target": map[string]any{"q": args.Target.Q},
				"path":   args.Path,
				"page":   page,
				"count":  count,
			}
			data, err := c.Post(ctx, "/ci-relations/path/s", body)
			if err != nil {
				return nil, err
			}
			var out map[string]any
			if err := json.Unmarshal(data, &out); err != nil {
				return nil, fmt.Errorf("cmdb_query_relation_path: decode response: %w", err)
			}
			if numfound, ok := number(out["numfound"]); ok {
				if total, ok := number(out["total"]); ok && numfound > total {
					out["note"] = fmt.Sprintf(
						"Results truncated: showing %d of %d paths. Increase count or narrow source/target q.",
						int(total), int(numfound),
					)
				}
			}
			return out, nil
		},
	}
}

var findCITypePathSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "source_type_id": {"type": "integer", "minimum": 1},
    "target_type_ids": {"type": "string", "description": "Comma-separated target model ids, e.g. \"4,5\"."}
  },
  "required": ["source_type_id", "target_type_ids"]
}`)

type findCITypePathArgs struct {
	SourceTypeID  int    `json:"source_type_id"`
	TargetTypeIDs string `json:"target_type_ids"`
}

func newFindCITypePathTool(c *Client) basetool.BaseTool {
	return &tool{
		name:        ToolNameFindCITypePath,
		description: "Find declared relation paths between CMDB models.",
		whenToUse:   "Use before cmdb_query_relation_path when you know the source and target models but not the chain of models between them.",
		schema:      findCITypePathSchema,
		run: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var args findCITypePathArgs
			if err := json.Unmarshal(raw, &args); err != nil {
				return nil, fmt.Errorf("cmdb_find_ci_type_path: bad args: %w", err)
			}
			if args.SourceTypeID <= 0 {
				return nil, errors.New("cmdb_find_ci_type_path: source_type_id is required")
			}
			targets := strings.TrimSpace(args.TargetTypeIDs)
			if targets == "" {
				return nil, errors.New("cmdb_find_ci_type_path: target_type_ids is required")
			}
			query := url.Values{
				"source_type_id":  {strconv.Itoa(args.SourceTypeID)},
				"target_type_ids": {targets},
			}
			data, err := c.Get(ctx, "/ci-type-relations/path", query)
			if err != nil {
				return nil, err
			}
			var out map[string]any
			if err := json.Unmarshal(data, &out); err != nil {
				return nil, fmt.Errorf("cmdb_find_ci_type_path: decode response: %w", err)
			}
			return out, nil
		},
	}
}

var getCIHistorySchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "ci_id": {"type": "integer", "minimum": 1},
    "page": {"type": "integer", "minimum": 1, "default": 1},
    "page_size": {"type": "integer", "minimum": 1, "maximum": 20, "default": 20}
  },
  "required": ["ci_id"]
}`)

type getCIHistoryArgs struct {
	CIID     int `json:"ci_id"`
	Page     int `json:"page"`
	PageSize int `json:"page_size"`
}

func newGetCIHistoryTool(c *Client) basetool.BaseTool {
	return &tool{
		name:        ToolNameGetCIHistory,
		description: "Return one CI's attribute change history.",
		whenToUse:   "Use for \"what changed near T\" questions: who changed which attribute, old value, new value, and when.",
		schema:      getCIHistorySchema,
		run: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var args getCIHistoryArgs
			if err := json.Unmarshal(raw, &args); err != nil {
				return nil, fmt.Errorf("cmdb_get_ci_history: bad args: %w", err)
			}
			if args.CIID <= 0 {
				return nil, errors.New("cmdb_get_ci_history: ci_id is required")
			}
			page := args.Page
			if page <= 0 {
				page = 1
			}
			size := args.PageSize
			if size <= 0 || size > maxItems {
				size = maxItems
			}
			query := url.Values{"page": {strconv.Itoa(page)}, "page_size": {strconv.Itoa(size)}}
			data, err := c.Get(ctx, fmt.Sprintf("/history/ci/%d", args.CIID), query)
			if err != nil {
				return nil, err
			}
			var out map[string]any
			if err := json.Unmarshal(data, &out); err != nil {
				return nil, fmt.Errorf("cmdb_get_ci_history: decode response: %w", err)
			}
			return out, nil
		},
	}
}

var relationGraphSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "ci_id": {"type": "integer", "minimum": 1, "description": "Root CI id; preferred when known."},
    "q": {"type": "string", "description": "Root search expression used when ci_id is absent, e.g. hostname:web-01."},
    "direction": {
      "type": "string",
      "enum": ["down", "up", "both"],
      "default": "both",
      "description": "STRUCTURAL direction: down follows stored First->Second edges (children), up follows Second->First (parents). It is not the failure-propagation direction; read each edge's relation_type_direction and propagates to interpret impact."
    },
    "depth": {"type": "integer", "minimum": 1, "maximum": 3, "default": 1, "description": "Hops to walk; capped at 3."},
    "max_nodes": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20, "description": "Cap on returned nodes; capped at 50."},
    "only_propagating": {"type": "boolean", "default": false, "description": "When true, keep only edges whose relation type propagates failure. Structural/ownership edges are skipped; the counts field still reports the raw direct-neighbour totals."}
  }
}`)

type relationGraphArgs struct {
	CIID            int    `json:"ci_id"`
	Q               string `json:"q"`
	Direction       string `json:"direction"`
	Depth           int    `json:"depth"`
	MaxNodes        int    `json:"max_nodes"`
	OnlyPropagating bool   `json:"only_propagating"`
}

type graphSide struct {
	path     string
	incoming bool
}

func newRelationGraphTool(c *Client) basetool.BaseTool {
	return &tool{
		name:        ToolNameRelationGraph,
		description: "Walk the CMDB relation graph around one CI and return nodes and edges.",
		whenToUse:   "Use when direct neighbours are not enough and you need a bounded impact fan-out (depth <= 3, nodes <= 50).",
		schema:      relationGraphSchema,
		run: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var args relationGraphArgs
			if err := json.Unmarshal(raw, &args); err != nil {
				return nil, fmt.Errorf("cmdb_relation_graph: bad args: %w", err)
			}
			ciID := args.CIID
			if ciID <= 0 {
				q := strings.TrimSpace(args.Q)
				if q == "" {
					return nil, errors.New("cmdb_relation_graph: ci_id or q is required")
				}
				data, err := c.Get(ctx, "/ci/s", url.Values{"q": {q}, "count": {"1"}})
				if err != nil {
					return nil, err
				}
				var page struct {
					Result []map[string]any `json:"result"`
				}
				if err := json.Unmarshal(data, &page); err != nil {
					return nil, fmt.Errorf("cmdb_relation_graph: decode search: %w", err)
				}
				if len(page.Result) == 0 {
					return nil, fmt.Errorf("cmdb_relation_graph: no CI matches %q", q)
				}
				id, ok := number(page.Result[0]["_id"])
				if !ok {
					return nil, errors.New("cmdb_relation_graph: search result has no _id")
				}
				ciID = int(id)
			}

			direction := strings.ToLower(strings.TrimSpace(args.Direction))
			if direction == "" {
				direction = "both"
			}
			var sides []graphSide
			switch direction {
			case "up":
				sides = []graphSide{{path: "parents", incoming: true}}
			case "down":
				sides = []graphSide{{path: "children", incoming: false}}
			default:
				direction = "both"
				sides = []graphSide{
					{path: "children", incoming: false},
					{path: "parents", incoming: true},
				}
			}

			depth := args.Depth
			if depth <= 0 {
				depth = 1
			}
			if depth > 3 {
				depth = 3
			}
			maxNodes := args.MaxNodes
			if maxNodes <= 0 {
				maxNodes = 20
			}
			if maxNodes > 50 {
				maxNodes = 50
			}

			order, rawEdges, counts, truncated, truncatedLevels, err := walkRelationGraph(
				ctx, c, ciID, sides, depth, maxNodes, args.OnlyPropagating)
			if err != nil {
				return nil, err
			}

			typeNames := fetchCITypeNames(ctx, c)
			relationLabels := fetchRelationTypeLabels(ctx, c)
			edges := make([]map[string]any, 0, len(rawEdges))
			for _, e := range rawEdges {
				label := e.RelationTypeName
				if label == "" {
					label = relationLabels[e.RelationTypeID]
				}
				edge := map[string]any{
					"source": e.From, "target": e.To,
					"relation_type_id": e.RelationTypeID,
					"label":            label,
					"direction":        e.Direction,
					"propagates":       e.Propagates,
					"weight":           e.Weight,
				}
				if e.EvidenceSource != "" {
					edge["evidence_source"] = e.EvidenceSource
				}
				if e.Confidence != nil {
					edge["confidence"] = *e.Confidence
				}
				if e.ObservedAt != nil {
					edge["observed_at"] = e.ObservedAt
				}
				if len(e.Props) > 0 {
					edge["props"] = e.Props
				}
				edges = append(edges, edge)
			}

			nodes := make([]map[string]any, 0, len(order))
			for _, id := range order {
				node := map[string]any{"id": id}
				data, err := c.Get(ctx, fmt.Sprintf("/instances/%d", id), nil)
				if err != nil {
					var apiErr *APIError
					if !errors.As(err, &apiErr) || apiErr.Status != http.StatusNotFound {
						return nil, err
					}
				} else {
					var dto map[string]any
					if err := json.Unmarshal(data, &dto); err == nil {
						if typeID, ok := number(dto["type_id"]); ok {
							node["type_id"] = int(typeID)
							if name := typeNames[int(typeID)]; name != "" {
								node["type_name"] = name
							}
						}
						if name := displayName(dto); name != "" {
							node["name"] = name
						}
					}
				}
				nodes = append(nodes, node)
			}

			out := map[string]any{
				"root":             nodes[0],
				"nodes":            nodes,
				"edges":            edges,
				"counts":           map[string]any{"upstream": counts.Upstream, "downstream": counts.Downstream},
				"direction":        direction,
				"only_propagating": args.OnlyPropagating,
				"truncated":        truncated,
			}
			if len(truncatedLevels) > 0 {
				out["truncated_levels"] = truncatedLevels
			}
			if truncated {
				out["note"] = "Results truncated: a hop had more neighbours than the page/node budget; open a node or narrow the query."
			}
			return out, nil
		},
	}
}

// splitCSV reads the comma-separated field lists the CMDB API takes.
func splitCSV(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func joinNotes(existing any, extra string) string {
	if s, ok := existing.(string); ok && s != "" {
		return s + " " + extra
	}
	return extra
}

// number normalises a JSON number decoded into any (encoding/json uses
// float64 by default).
func number(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}

// displayName picks the most useful human label from an instance DTO.
func displayName(dto map[string]any) string {
	values, _ := dto["values"].(map[string]any)
	for _, key := range []string{"hostname", "name", "unique", "alias"} {
		if v, ok := values[key].(string); ok && strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

type rawGraphEdge struct {
	From           int
	To             int
	RelationID     int
	RelationTypeID int

	// Semantics and provenance carried from the neighbour payload. They make
	// the graph interpretable without a second call per edge: direction says
	// which way failure flows, propagates says whether it flows at all, and
	// the evidence fields say where the edge came from.
	RelationTypeName string
	Direction        string
	Propagates       bool
	Weight           float64
	EvidenceSource   string
	Confidence       *float64
	ObservedAt       *time.Time
	Props            json.RawMessage
}

type graphCounts struct {
	Upstream   int
	Downstream int
}

// walkRelationGraph expands up to depth levels around ciID. It bounds BOTH
// nodes and edges: an unbounded edge list is how a 3-hop fan-out turns into
// hundreds of thousands of tokens. Edges are deduplicated by
// (from,to,relation_id) and only kept when both endpoints are in the returned
// node set, so direction=both cannot produce duplicate or dangling edges.
//
// counts are the FIRST hop's numfound numbers — the true direct neighbour
// counts, not the rows this walk happened to keep. truncated is set whenever a
// page reports more rows than it returned, including deeper hops, and
// truncatedLevels lists the hop numbers where that happened.
func walkRelationGraph(ctx context.Context, c *Client, ciID int, sides []graphSide, depth, maxNodes int, onlyPropagating bool) ([]int, []rawGraphEdge, graphCounts, bool, []int, error) {
	maxEdges := maxNodes * 2
	visited := map[int]bool{ciID: true}
	order := []int{ciID}
	edges := make([]rawGraphEdge, 0, maxEdges)
	edgeSeen := make(map[string]struct{}, maxEdges)
	var counts graphCounts
	truncated := false
	truncatedLevels := map[int]bool{}
	frontier := []int{ciID}

	for level := 0; level < depth && len(frontier) > 0; level++ {
		next := make([]int, 0)
		stop := false
		for _, id := range frontier {
			for _, side := range sides {
				query := url.Values{"page": {"1"}, "count": {strconv.Itoa(maxNodes)}}
				data, err := c.Get(ctx, fmt.Sprintf("/ci-relations/%d/%s", id, side.path), query)
				if err != nil {
					return nil, nil, counts, false, nil, err
				}
				var page struct {
					Items    []neighbour `json:"items"`
					NumFound int         `json:"numfound"`
				}
				if err := json.Unmarshal(data, &page); err != nil {
					return nil, nil, counts, false, nil, fmt.Errorf("cmdb_relation_graph: decode neighbours: %w", err)
				}
				if page.NumFound > len(page.Items) {
					truncated = true
					truncatedLevels[level+1] = true
				}
				if level == 0 {
					if side.path == "children" {
						counts.Downstream = page.NumFound
					} else {
						counts.Upstream = page.NumFound
					}
				}
				for _, n := range page.Items {
					if n.CIID <= 0 {
						continue
					}
					if onlyPropagating && !n.RelationTypePropagates {
						continue
					}
					if !visited[n.CIID] {
						if len(visited) >= maxNodes {
							truncated = true
							truncatedLevels[level+1] = true
							// The node will not be returned, so its edge
							// would dangle; drop both.
							continue
						}
						visited[n.CIID] = true
						order = append(order, n.CIID)
						next = append(next, n.CIID)
					}
					from, to := id, n.CIID
					if side.incoming {
						from, to = n.CIID, id
					}
					key := fmt.Sprintf("%d->%d#%d", from, to, n.RelationID)
					if _, seen := edgeSeen[key]; seen {
						continue
					}
					if len(edges) >= maxEdges {
						truncated = true
						truncatedLevels[level+1] = true
						stop = true
						break
					}
					edgeSeen[key] = struct{}{}
					edges = append(edges, rawGraphEdge{
						From: from, To: to,
						RelationID: n.RelationID, RelationTypeID: n.RelationTypeID,
						RelationTypeName: n.RelationTypeName,
						Direction:        n.RelationTypeDirection,
						Propagates:       n.RelationTypePropagates,
						Weight:           n.RelationTypeWeight,
						EvidenceSource:   n.EvidenceSource,
						Confidence:       n.Confidence,
						ObservedAt:       n.ObservedAt,
						Props:            n.Props,
					})
				}
				if stop {
					break
				}
			}
			if stop {
				break
			}
		}
		if stop || len(next) == 0 {
			break
		}
		frontier = next
	}
	levels := make([]int, 0, len(truncatedLevels))
	for level := range truncatedLevels {
		levels = append(levels, level)
	}
	sort.Ints(levels)
	return order, edges, counts, truncated, levels, nil
}

// fetchCITypeNames maps model id -> display name. Best-effort: the graph is
// still useful without labels, so a failed metadata read does not fail the
// tool.
func fetchCITypeNames(ctx context.Context, c *Client) map[int]string {
	out := map[int]string{}
	data, err := c.Get(ctx, "/ci-types", nil)
	if err != nil {
		return out
	}
	var page struct {
		Items []map[string]any `json:"items"`
	}
	if json.Unmarshal(data, &page) != nil {
		return out
	}
	for _, item := range page.Items {
		id, ok := number(item["id"])
		if !ok {
			continue
		}
		name, _ := item["alias"].(string)
		if name == "" {
			name, _ = item["name"].(string)
		}
		if name != "" {
			out[int(id)] = name
		}
	}
	return out
}

// fetchRelationTypeLabels maps relation type id -> name for edge labels.
// Best-effort for the same reason as fetchCITypeNames.
// fetchRelationTypeLabels reads the DICTIONARY, not the model-rule projection.
// The projection only knows types used by a declared model pair, so an
// instance-only type (or one whose rule was removed) rendered an empty label.
func fetchRelationTypeLabels(ctx context.Context, c *Client) map[int]string {
	out := map[int]string{}
	data, err := c.Get(ctx, "/relation-types", nil)
	if err != nil {
		return out
	}
	var page struct {
		Items []struct {
			ID   int    `json:"id"`
			Name string `json:"name"`
		} `json:"items"`
	}
	if json.Unmarshal(data, &page) != nil {
		return out
	}
	for _, item := range page.Items {
		if item.ID > 0 && item.Name != "" {
			out[item.ID] = item.Name
		}
	}
	return out
}
