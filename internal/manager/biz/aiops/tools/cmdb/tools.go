package cmdb

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/ongridio/ongrid/internal/manager/biz/aiops/tools/basetool"
)

const (
	ToolNameSearchCI          = "cmdb_search_ci"
	ToolNameGetCI             = "cmdb_get_ci"
	ToolNameListCITypes       = "cmdb_list_ci_types"
	ToolNameGetCIType         = "cmdb_get_ci_type"
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
)

// tool is a read-only CMDB capability with a declarative JSON Schema. The
// nine P0 tools differ only in their schema and run function, so one type
// keeps them auditable in one file instead of nine near-identical structs.
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
				items = append(items, map[string]any{
					"relation_id": n.RelationID, "ci_id": n.CIID,
					"type_id": n.TypeID, "relation_type_id": n.RelationTypeID,
				})
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
        "type_ids": {"type": "array", "items": {"type": "integer", "minimum": 1}},
        "q": {"type": "string", "description": "Search expression narrowing target instances; empty means all."}
      },
      "required": ["type_ids"]
    },
    "path": {
      "type": "array",
      "description": "One or more model-id chains from source to target. Chain order is the relation direction and is not interchangeable.",
      "items": {"type": "array", "items": {"type": "integer", "minimum": 1}}
    },
    "page": {"type": "integer", "minimum": 1, "default": 1},
    "count": {"type": "integer", "minimum": 1, "maximum": 20, "default": 20}
  },
  "required": ["source", "target", "path"]
}`)

type queryRelationPathArgs struct {
	Source struct {
		TypeID int    `json:"type_id"`
		Q      string `json:"q"`
	} `json:"source"`
	Target struct {
		TypeIDs []int  `json:"type_ids"`
		Q       string `json:"q"`
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
			if len(args.Target.TypeIDs) == 0 {
				return nil, errors.New("cmdb_query_relation_path: target.type_ids is required")
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
				"target": map[string]any{"type_ids": args.Target.TypeIDs, "q": args.Target.Q},
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
    "ci_id": {"type": "integer", "minimum": 1},
    "direction": {"type": "string", "enum": ["down", "up", "both"], "default": "down"},
    "depth": {"type": "integer", "minimum": 1, "maximum": 3, "default": 1, "description": "Hops to walk; capped at 3."},
    "max_nodes": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20, "description": "Cap on returned nodes; capped at 50."}
  },
  "required": ["ci_id"]
}`)

type relationGraphArgs struct {
	CIID      int    `json:"ci_id"`
	Direction string `json:"direction"`
	Depth     int    `json:"depth"`
	MaxNodes  int    `json:"max_nodes"`
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
			if args.CIID <= 0 {
				return nil, errors.New("cmdb_relation_graph: ci_id is required")
			}
			direction := strings.ToLower(strings.TrimSpace(args.Direction))
			if direction == "" {
				direction = "down"
			}
			var sides []graphSide
			switch direction {
			case "up":
				sides = []graphSide{{path: "parents", incoming: true}}
			case "both":
				sides = []graphSide{
					{path: "children", incoming: false},
					{path: "parents", incoming: true},
				}
			default:
				direction = "down"
				sides = []graphSide{{path: "children", incoming: false}}
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

			order, edges, truncated, err := walkRelationGraph(ctx, c, args.CIID, sides, depth, maxNodes)
			if err != nil {
				return nil, err
			}

			nodes := make([]map[string]any, 0, len(order))
			for _, id := range order {
				node := map[string]any{"ci_id": id}
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
							node["ci_type"] = int(typeID)
						}
						if name := displayName(dto); name != "" {
							node["name"] = name
						}
					}
				}
				nodes = append(nodes, node)
			}

			return map[string]any{
				"nodes": nodes, "edges": edges,
				"direction": direction, "truncated": truncated,
			}, nil
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

// walkRelationGraph expands up to depth levels around ciID. It bounds BOTH
// nodes and edges: an unbounded edge list is how a 3-hop fan-out turns into
// hundreds of thousands of tokens. Edges are deduplicated by
// (from,to,relation_id) and only kept when both endpoints are in the returned
// node set, so direction=both cannot produce duplicate or dangling edges.
func walkRelationGraph(ctx context.Context, c *Client, ciID int, sides []graphSide, depth, maxNodes int) ([]int, []map[string]any, bool, error) {
	maxEdges := maxNodes * 2
	visited := map[int]bool{ciID: true}
	order := []int{ciID}
	edges := make([]map[string]any, 0, maxEdges)
	edgeSeen := make(map[string]struct{}, maxEdges)
	truncated := false
	frontier := []int{ciID}

	for level := 0; level < depth && len(frontier) > 0; level++ {
		next := make([]int, 0)
		stop := false
		for _, id := range frontier {
			for _, side := range sides {
				query := url.Values{"page": {"1"}, "count": {strconv.Itoa(maxNodes)}}
				data, err := c.Get(ctx, fmt.Sprintf("/ci-relations/%d/%s", id, side.path), query)
				if err != nil {
					return nil, nil, false, err
				}
				var page struct {
					Items []neighbour `json:"items"`
				}
				if err := json.Unmarshal(data, &page); err != nil {
					return nil, nil, false, fmt.Errorf("cmdb_relation_graph: decode neighbours: %w", err)
				}
				for _, n := range page.Items {
					if n.CIID <= 0 {
						continue
					}
					if !visited[n.CIID] {
						if len(visited) >= maxNodes {
							truncated = true
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
						stop = true
						break
					}
					edgeSeen[key] = struct{}{}
					edges = append(edges, map[string]any{
						"from": from, "to": to,
						"relation_id": n.RelationID, "relation_type_id": n.RelationTypeID,
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
	return order, edges, truncated, nil
}
