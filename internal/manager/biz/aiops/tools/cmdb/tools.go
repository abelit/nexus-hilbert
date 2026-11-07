package cmdb

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/ongridio/ongrid/internal/manager/biz/aiops/tools/basetool"
)

const (
	ToolNameSearchCI    = "cmdb_search_ci"
	ToolNameGetCI       = "cmdb_get_ci"
	ToolNameListCITypes = "cmdb_list_ci_types"
	ToolNameGetCIType   = "cmdb_get_ci_type"
)

const (
	maxItems = 20
	maxAttrs = 5
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
	}
}

var searchCISchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "q": {"type": "string", "description": "CMDB search expression. Use _type:<model> and attribute filters, e.g. \"_type:host private_ip:10.0.0.1\". The backend returns an error explaining the syntax for a malformed expression."},
    "page": {"type": "integer", "minimum": 1, "default": 1},
    "count": {"type": "integer", "minimum": 1, "maximum": 20, "default": 20},
    "sort": {"type": "string", "description": "Sort expression, e.g. -_updated_at for recent changes."},
    "fl": {"type": "string", "description": "Comma-separated attribute list to return."}
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
			items := make([]any, 0, len(pageData.Result))
			for _, row := range pageData.Result {
				items = append(items, CompactCI(row, maxAttrs))
			}
			out := Truncate(items, maxItems, pageData.NumFound)
			out["page"] = pageData.Page
			return out, nil
		},
	}
}

var getCISchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "ci_id": {"type": "integer", "minimum": 1, "description": "Numeric CI id returned by cmdb_search_ci."},
    "fields": {"type": "string", "description": "Comma-separated attributes to return; omitted means a summary."}
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
		whenToUse:   "Use after cmdb_search_ci when you need the full attribute set or a specific field of one CI.",
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
			return map[string]any{"ci": normalizeInstance(dto)}, nil
		},
	}
}

// normalizeInstance flattens the instance DTO's nested values so a CI looks
// the same whether it came from search or from a single-instance read.
func normalizeInstance(dto map[string]any) map[string]any {
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
