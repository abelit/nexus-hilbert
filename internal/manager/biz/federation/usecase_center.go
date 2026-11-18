package federation

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	model "github.com/ongridio/ongrid/internal/manager/model/federation"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// ViewerIdentityResolver maps the authenticated caller to the identity values
// a configured filter can substitute. cmd/ongrid implements it over IAM; a
// missing resolver is a normal state (no identity values, so identity rules
// void the predicate) and never widens the query.
type ViewerIdentityResolver interface {
	Resolve(ctx context.Context, userID uint64) (map[string][]string, error)
}

// SetIdentityResolver wires the IAM adapter after construction so the basic
// use case (and its tests) need not depend on IAM.
func (u *Usecase) SetIdentityResolver(resolver ViewerIdentityResolver) {
	u.identities = resolver
}

// FilterView is the JSON-safe shape of one configured center filter.
type FilterView struct {
	Key      string `json:"key"`
	Name     string `json:"name"`
	Usage    string `json:"usage"`
	Enabled  bool   `json:"enabled"`
	Position int    `json:"position"`
	And      []Rule `json:"and"`
	Or       []Rule `json:"or"`
}

// FilterSummary is what a non-admin sees in the scope dropdown: no rules.
type FilterSummary struct {
	Key              string `json:"key"`
	Name             string `json:"name"`
	Usage            string `json:"usage"`
	IdentityRequired bool   `json:"identity_required"`
}

// StatsResult reports counts for the current window. A nil count means the
// upstream did not answer within its budget; the UI renders "—", not 0.
type StatsResult struct {
	Kind       string          `json:"kind"`
	Configured bool            `json:"configured"`
	Reason     string          `json:"reason,omitempty"`
	Total      *int            `json:"total"`
	ByStatus   map[string]*int `json:"by_status,omitempty"`
	BySeverity map[string]*int `json:"by_severity,omitempty"`
	WindowDays int             `json:"window_days"`
}

// FieldPath is one discovered upstream field path. Values are never returned.
type FieldPath struct {
	Path  string `json:"path"`
	Count int    `json:"count"`
}

// PreviewResult is a dry-run of one filter candidate.
type PreviewResult struct {
	And     []string `json:"and"`
	Or      []string `json:"or"`
	Matched int      `json:"matched"`
	Reason  string   `json:"reason,omitempty"`
}

// ListFilters returns every configured filter for kind, rules included. Admin
// only at the HTTP layer.
func (u *Usecase) ListFilters(ctx context.Context, kind string) ([]FilterView, error) {
	if !ValidKind(kind) {
		return nil, fmt.Errorf("%w: kind %q", errs.ErrInvalid, kind)
	}
	rows, err := u.repo.ListFilters(ctx, kind)
	if err != nil {
		return nil, err
	}
	out := make([]FilterView, 0, len(rows))
	for i := range rows {
		view, err := filterViewFromModel(&rows[i])
		if err != nil {
			return nil, err
		}
		out = append(out, view)
	}
	return out, nil
}

// FilterSummaries returns enabled filters without their rules for any
// authenticated user's scope dropdown.
func (u *Usecase) FilterSummaries(ctx context.Context, kind string) ([]FilterSummary, error) {
	views, err := u.ListFilters(ctx, kind)
	if err != nil {
		return nil, err
	}
	out := make([]FilterSummary, 0, len(views))
	for _, view := range views {
		if !view.Enabled {
			continue
		}
		out = append(out, FilterSummary{
			Key:              view.Key,
			Name:             view.Name,
			Usage:            view.Usage,
			IdentityRequired: filterNeedsIdentity(view),
		})
	}
	return out, nil
}

// SaveFilter validates and upserts one filter. At most one enabled filter per
// kind may drive the badge.
func (u *Usecase) SaveFilter(ctx context.Context, kind string, in FilterInput, keyFromPath string) (*FilterView, error) {
	if !ValidKind(kind) {
		return nil, fmt.Errorf("%w: kind %q", errs.ErrInvalid, kind)
	}
	normalized, err := ValidateFilter(in, keyFromPath)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errs.ErrInvalid, err)
	}
	if normalized.Enabled && (normalized.Usage == UsageBadge || normalized.Usage == UsageBoth) {
		count, err := u.repo.CountBadgeFilters(ctx, kind, normalized.Key)
		if err != nil {
			return nil, err
		}
		if count > 0 {
			return nil, fmt.Errorf("%w: another enabled filter already drives the badge", errs.ErrConflict)
		}
	}
	andJSON, err := json.Marshal(normalized.And)
	if err != nil {
		return nil, fmt.Errorf("%w: encode filter rules: %v", errs.ErrInvalid, err)
	}
	orJSON, err := json.Marshal(normalized.Or)
	if err != nil {
		return nil, fmt.Errorf("%w: encode filter rules: %v", errs.ErrInvalid, err)
	}
	row := &model.CenterFilter{
		Kind:         kind,
		FilterKey:    normalized.Key,
		Name:         normalized.Name,
		Usage:        normalized.Usage,
		AndRulesJSON: string(andJSON),
		OrRulesJSON:  string(orJSON),
		Enabled:      normalized.Enabled,
		Position:     normalized.Position,
	}
	if err := u.repo.SaveFilter(ctx, row); err != nil {
		return nil, err
	}
	view, err := filterViewFromModel(row)
	if err != nil {
		return nil, err
	}
	return &view, nil
}

func (u *Usecase) DeleteFilter(ctx context.Context, kind, key string) error {
	if !ValidKind(kind) {
		return fmt.Errorf("%w: kind %q", errs.ErrInvalid, kind)
	}
	return u.repo.DeleteFilter(ctx, kind, key)
}

// GetColumns returns the configured display columns, falling back to the
// built-in catalog so a fresh install renders a useful table before an admin
// saves a preference.
func (u *Usecase) GetColumns(ctx context.Context, kind string) ([]model.DisplayColumn, error) {
	if !ValidKind(kind) {
		return nil, fmt.Errorf("%w: kind %q", errs.ErrInvalid, kind)
	}
	rows, err := u.repo.ListColumns(ctx, kind)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return defaultColumns(kind), nil
	}
	return rows, nil
}

// ReplaceColumns validates and replaces the ordered column list in one
// transaction.
func (u *Usecase) ReplaceColumns(ctx context.Context, kind string, in []DisplayColumn) ([]DisplayColumn, error) {
	if !ValidKind(kind) {
		return nil, fmt.Errorf("%w: kind %q", errs.ErrInvalid, kind)
	}
	normalized, err := ValidateColumns(in)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errs.ErrInvalid, err)
	}
	for i := range normalized {
		normalized[i].Kind = kind
	}
	if err := u.repo.ReplaceColumns(ctx, kind, normalized); err != nil {
		return nil, err
	}
	return normalized, nil
}

// ListMine runs one configured filter with the caller's identity substituted.
func (u *Usecase) ListMine(ctx context.Context, kind, scope string, req ListRequest, userID uint64) (*ListResult, error) {
	profile, ok := Profile(kind)
	if !ok {
		return nil, fmt.Errorf("%w: kind %q", errs.ErrInvalid, kind)
	}
	filter, err := u.scopeFilter(ctx, kind, scope)
	if err != nil {
		return nil, err
	}
	if filter == nil {
		return &ListResult{Kind: kind, Configured: true, Reason: "no_scope", Items: []json.RawMessage{}}, nil
	}
	identities, err := u.resolveIdentities(ctx, userID)
	if err != nil {
		return nil, err
	}
	and, or, bound := BuildPredicate(*filter, identities)
	if !bound {
		return &ListResult{
			Kind: kind, Configured: true, Reason: "unbound",
			Scope: filter.Key, Identity: "unbound", Items: []json.RawMessage{},
		}, nil
	}
	conn, err := u.pickConnection(ctx, kind, req.ConnectionID)
	if err != nil {
		return nil, err
	}
	if conn == nil {
		return &ListResult{Kind: kind, Configured: false, Reason: "not_configured", Items: []json.RawMessage{}}, nil
	}
	page, size := normalizeListPage(req.Page, req.PageSize, profile)
	days := req.Days
	if days < 1 {
		days = profile.DefaultDays
	}
	filters := append(buildListFilters(profile, req), and...)
	got, err := u.querier.Query(ctx, conn, QueryRequest{
		Table:     profile.DefaultTable,
		StartDate: req.StartDate,
		EndDate:   req.EndDate,
		Days:      days,
		Page:      page,
		PageSize:  size,
		Filters:   filters,
		OrFilters: or,
	})
	if err != nil {
		return nil, err
	}
	return &ListResult{
		Kind: kind, Configured: true, Table: got.Table, TimeRange: got.TimeRange,
		Total: got.Total, Page: got.Page, PageSize: got.PageSize, Pages: got.Pages,
		Items: got.Items, Filters: got.Filters, Scope: filter.Key, Identity: "bound",
	}, nil
}

// Stats issues bounded page_size=1 queries so one slow facet cannot fail the
// page. Status/severity/keyword filters deliberately do NOT narrow the stats:
// the numbers answer "how much is there", not "how many rows on screen".
func (u *Usecase) Stats(ctx context.Context, kind, scope string, req ListRequest, userID uint64) (*StatsResult, error) {
	profile, ok := Profile(kind)
	if !ok {
		return nil, fmt.Errorf("%w: kind %q", errs.ErrInvalid, kind)
	}
	out := &StatsResult{Kind: kind, WindowDays: req.Days, ByStatus: map[string]*int{}, BySeverity: map[string]*int{}}
	if out.WindowDays < 1 {
		out.WindowDays = profile.DefaultDays
	}
	req.Days = out.WindowDays
	conn, err := u.pickConnection(ctx, kind, req.ConnectionID)
	if err != nil {
		return nil, err
	}
	if conn == nil {
		out.Configured = false
		out.Reason = "not_configured"
		return out, nil
	}
	out.Configured = true

	// Fleet stats are shared; the per-viewer scope is not cached.
	cacheKey := ""
	if scope == "" {
		cacheKey = fmt.Sprintf("stats|%s|%d|%s|%s|%d",
			kind, conn.ID, req.StartDate, req.EndDate, out.WindowDays)
		if cached, ok := u.cache.get(cacheKey); ok {
			if result, ok := cached.(*StatsResult); ok {
				return result, nil
			}
		}
	}

	var extraAnd, extraOr []string
	if scope != "" {
		filter, err := u.scopeFilter(ctx, kind, scope)
		if err != nil {
			return nil, err
		}
		if filter == nil {
			out.Reason = "no_scope"
			return out, nil
		}
		identities, err := u.resolveIdentities(ctx, userID)
		if err != nil {
			return nil, err
		}
		and, or, bound := BuildPredicate(*filter, identities)
		if !bound {
			out.Reason = "unbound"
			return out, nil
		}
		extraAnd, extraOr = and, or
	}

	type facet struct {
		status   string
		severity string
	}
	jobs := make([]facet, 0, 6)
	jobs = append(jobs, facet{})
	for _, status := range statusesFor(kind) {
		jobs = append(jobs, facet{status: status})
	}
	for _, severity := range severitiesFor(kind) {
		jobs = append(jobs, facet{severity: severity})
	}

	results := make([]*int, len(jobs))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for i := range jobs {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			results[index] = u.count(ctx, conn, profile, req, extraAnd, extraOr, jobs[index].status, jobs[index].severity)
		}(i)
	}
	wg.Wait()

	out.Total = results[0]
	for i, status := range statusesFor(kind) {
		out.ByStatus[status] = results[1+i]
	}
	for i, severity := range severitiesFor(kind) {
		out.BySeverity[severity] = results[1+len(statusesFor(kind))+i]
	}
	if cacheKey != "" {
		u.cache.set(cacheKey, out, 60*time.Second)
	}
	return out, nil
}

func (u *Usecase) count(ctx context.Context, conn *model.Connection, profile SourceProfile, req ListRequest, extraAnd, extraOr []string, status, severity string) *int {
	if status != "" && profile.StatusField == "" {
		return nil
	}
	if severity != "" && profile.SeverityField == "" {
		return nil
	}
	filters := append([]string{}, extraAnd...)
	if status != "" {
		filters = append(filters, Expr(profile.StatusField, OpEq, status))
	}
	if severity != "" {
		filters = append(filters, Expr(profile.SeverityField, OpEq, severity))
	}
	countCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	page, err := u.querier.Query(countCtx, conn, QueryRequest{
		Table:     profile.DefaultTable,
		StartDate: req.StartDate,
		EndDate:   req.EndDate,
		Days:      req.Days,
		Page:      1,
		PageSize:  1,
		Filters:   filters,
		OrFilters: extraOr,
	})
	if err != nil {
		return nil
	}
	n := page.Total
	return &n
}

// PreviewFilter dry-runs a candidate filter with the caller's identity.
func (u *Usecase) PreviewFilter(ctx context.Context, kind string, in FilterInput, userID uint64) (*PreviewResult, error) {
	profile, ok := Profile(kind)
	if !ok {
		return nil, fmt.Errorf("%w: kind %q", errs.ErrInvalid, kind)
	}
	normalized, err := ValidateFilter(in, "")
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errs.ErrInvalid, err)
	}
	filter := Filter{Key: normalized.Key, Name: normalized.Name, Usage: normalized.Usage, Enabled: normalized.Enabled, And: normalized.And, Or: normalized.Or}
	identities, err := u.resolveIdentities(ctx, userID)
	if err != nil {
		return nil, err
	}
	and, or, bound := BuildPredicate(filter, identities)
	out := &PreviewResult{And: and, Or: or}
	if !bound {
		out.Reason = "unbound"
		return out, nil
	}
	conn, err := u.pickConnection(ctx, kind, 0)
	if err != nil {
		return nil, err
	}
	if conn == nil {
		out.Reason = "not_configured"
		return out, nil
	}
	page, err := u.querier.Query(ctx, conn, QueryRequest{
		Table: profile.DefaultTable, Days: profile.DefaultDays,
		Page: 1, PageSize: 1, Filters: and, OrFilters: or,
	})
	if err != nil {
		return nil, err
	}
	out.Matched = page.Total
	return out, nil
}

// FieldPaths scans one upstream page and returns field paths with counts. It
// never returns values: paths from an alert/ITSM record can carry personal
// data, and the UI only needs the shape.
func (u *Usecase) FieldPaths(ctx context.Context, kind string, connectionID uint64, prefix string) ([]FieldPath, error) {
	profile, ok := Profile(kind)
	if !ok {
		return nil, fmt.Errorf("%w: kind %q", errs.ErrInvalid, kind)
	}
	conn, err := u.pickConnection(ctx, kind, connectionID)
	if err != nil {
		return nil, err
	}
	if conn == nil {
		return nil, fmt.Errorf("%w: no connection configured for %s", errs.ErrNotFound, kind)
	}
	page, err := u.querier.Query(ctx, conn, QueryRequest{
		Table: profile.DefaultTable, Days: profile.DefaultDays,
		Page: 1, PageSize: 50,
	})
	if err != nil {
		return nil, err
	}
	counts := map[string]int{}
	for _, raw := range page.Items {
		var doc any
		if err := json.Unmarshal(raw, &doc); err != nil {
			continue
		}
		collectPaths("", doc, counts)
	}
	prefix = strings.TrimSpace(prefix)
	out := make([]FieldPath, 0, len(counts))
	for path, count := range counts {
		if prefix != "" && !strings.HasPrefix(path, prefix) {
			continue
		}
		out = append(out, FieldPath{Path: path, Count: count})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Path < out[j].Path
	})
	if len(out) > 200 {
		out = out[:200]
	}
	return out, nil
}

func collectPaths(prefix string, value any, counts map[string]int) {
	switch node := value.(type) {
	case map[string]any:
		for key, child := range node {
			switch key {
			case reservedFieldToken, reservedFieldToken2, reservedFieldToken3:
				continue
			}
			next := key
			if prefix != "" {
				next = prefix + "." + key
			}
			collectPaths(next, child, counts)
		}
	case []any:
		if len(node) == 0 {
			return
		}
		// Scan the first element: the upstream carries lists of objects and
		// indexing would produce paths no administrator can configure.
		collectPaths(prefix, node[0], counts)
	default:
		if prefix != "" {
			counts[prefix]++
		}
	}
}

func (u *Usecase) scopeFilter(ctx context.Context, kind, scope string) (*Filter, error) {
	rows, err := u.repo.ListFilters(ctx, kind)
	if err != nil {
		return nil, err
	}
	var chosen *model.CenterFilter
	if scope != "" {
		for i := range rows {
			if rows[i].Enabled && rows[i].FilterKey == scope {
				chosen = &rows[i]
				break
			}
		}
		if chosen == nil {
			return nil, fmt.Errorf("%w: filter %q", errs.ErrNotFound, scope)
		}
	} else {
		for i := range rows {
			if !rows[i].Enabled {
				continue
			}
			if rows[i].Usage == UsageBadge || rows[i].Usage == UsageBoth {
				chosen = &rows[i]
				break
			}
		}
		if chosen == nil {
			for i := range rows {
				if rows[i].Enabled {
					chosen = &rows[i]
					break
				}
			}
		}
	}
	if chosen == nil {
		return nil, nil
	}
	view, err := filterViewFromModel(chosen)
	if err != nil {
		return nil, err
	}
	return &Filter{
		Key: view.Key, Name: view.Name, Usage: view.Usage, Enabled: view.Enabled,
		And: view.And, Or: view.Or,
	}, nil
}

func (u *Usecase) resolveIdentities(ctx context.Context, userID uint64) (map[string][]string, error) {
	if u.identities == nil || userID == 0 {
		return map[string][]string{}, nil
	}
	values, err := u.identities.Resolve(ctx, userID)
	if err != nil {
		// Fail closed: an identity lookup failure must not widen the query.
		return nil, fmt.Errorf("resolve viewer identities: %w", err)
	}
	if values == nil {
		return map[string][]string{}, nil
	}
	return values, nil
}

func filterViewFromModel(row *model.CenterFilter) (FilterView, error) {
	var and, or []Rule
	if strings.TrimSpace(row.AndRulesJSON) != "" {
		if err := json.Unmarshal([]byte(row.AndRulesJSON), &and); err != nil {
			return FilterView{}, fmt.Errorf("filter %q has invalid AND rules: %w", row.FilterKey, err)
		}
	}
	if strings.TrimSpace(row.OrRulesJSON) != "" {
		if err := json.Unmarshal([]byte(row.OrRulesJSON), &or); err != nil {
			return FilterView{}, fmt.Errorf("filter %q has invalid OR rules: %w", row.FilterKey, err)
		}
	}
	return FilterView{
		Key: row.FilterKey, Name: row.Name, Usage: row.Usage, Enabled: row.Enabled,
		Position: row.Position, And: and, Or: or,
	}, nil
}

func filterNeedsIdentity(view FilterView) bool {
	for _, rule := range append(append([]Rule{}, view.And...), view.Or...) {
		if rule.ValueType == ValueTypeIdentity {
			return true
		}
	}
	return false
}

func statusesFor(kind string) []string {
	if kind == KindITSMTicket {
		return []string{"RUNNING", "ERROR", "COMPLETED", "TERMINATED"}
	}
	return []string{"firing", "resolved"}
}

func severitiesFor(kind string) []string {
	if kind == KindITSMTicket {
		return nil
	}
	return []string{"critical", "warning", "info"}
}

func defaultColumns(kind string) []model.DisplayColumn {
	if kind == KindITSMTicket {
		return []model.DisplayColumn{
			{Kind: kind, ColumnKey: "status", ColumnKind: ColumnKindBuiltin, Path: "form_data.instanceStatus", Render: RenderBadge, Visible: true, Position: 0},
			{Kind: kind, ColumnKey: "title", ColumnKind: ColumnKindBuiltin, Path: "form_data.title", Render: RenderText, Visible: true, Position: 1},
			{Kind: kind, ColumnKey: "priority", ColumnKind: ColumnKindCustom, Path: "form_data.priority", Render: RenderBadge, LabelZH: "优先级", LabelEN: "Priority", Visible: true, Position: 2},
			{Kind: kind, ColumnKey: "assignee", ColumnKind: ColumnKindCustom, Path: "form_data.assignee", Render: RenderText, LabelZH: "处理人", LabelEN: "Assignee", Visible: true, Position: 3},
			{Kind: kind, ColumnKey: "created", ColumnKind: ColumnKindCustom, Path: "created_at", Render: RenderTime, LabelZH: "创建时间", LabelEN: "Created", Visible: true, Position: 4},
		}
	}
	return []model.DisplayColumn{
		{Kind: kind, ColumnKey: "severity", ColumnKind: ColumnKindBuiltin, Path: "alert.labels.severity", Render: RenderBadge, Visible: true, Position: 0},
		{Kind: kind, ColumnKey: "status", ColumnKind: ColumnKindBuiltin, Path: "status", Render: RenderBadge, Visible: true, Position: 1},
		{Kind: kind, ColumnKey: "alertname", ColumnKind: ColumnKindBuiltin, Path: "alertname", Render: RenderText, Visible: true, Position: 2},
		{Kind: kind, ColumnKey: "summary", ColumnKind: ColumnKindBuiltin, Path: "annotations.summary", Render: RenderText, Visible: true, Position: 3},
		{Kind: kind, ColumnKey: "host", ColumnKind: ColumnKindCustom, Path: "alert.labels.host", Render: RenderText, LabelZH: "主机", LabelEN: "Host", Visible: true, Position: 4},
		{Kind: kind, ColumnKey: "created", ColumnKind: ColumnKindCustom, Path: "created_at", Render: RenderTime, LabelZH: "触发", LabelEN: "Fired", Visible: true, Position: 5},
	}
}
