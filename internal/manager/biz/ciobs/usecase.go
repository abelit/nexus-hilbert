package ciobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"strings"
	"time"

	federationbiz "github.com/ongridio/ongrid/internal/manager/biz/federation"
	model "github.com/ongridio/ongrid/internal/manager/model/ciobs"
	"github.com/ongridio/ongrid/internal/pkg/errs"
	"github.com/ongridio/ongrid/internal/pkg/promquery"
)

var (
	ErrCMDBUnavailable = errors.New("ciobs: cmdb unavailable")
	ErrUpstream        = errors.New("ciobs: prometheus upstream failure")
)

type Repo interface {
	List(ctx context.Context, provider string) ([]model.Link, error)
	Get(ctx context.Context, provider string, ciTypeID uint64) (*model.Link, error)
	Upsert(ctx context.Context, link *model.Link) error
	Delete(ctx context.Context, provider string, ciTypeID uint64) error
}

// CMDBReader reuses the federation projection: one adapter serves both.
type CMDBReader interface {
	GetInstance(ctx context.Context, id uint64) (*federationbiz.CMDBInstance, error)
}

type PromAlerts interface {
	Alerts(ctx context.Context) ([]promquery.Alert, error)
}

type VarMapping struct {
	CIAttribute string `json:"ci_attribute"`
	VarName     string `json:"var_name"`
}

type LabelMapping struct {
	CIAttribute string `json:"ci_attribute"`
	PromLabel   string `json:"prom_label"`
}

type Matcher struct {
	Label string `json:"label"`
	Op    string `json:"op"`
	Value string `json:"value"`
}

type LinkInput struct {
	Enabled       *bool          `json:"enabled"`
	DashboardUID  string         `json:"dashboard_uid"`
	DashboardSlug string         `json:"dashboard_slug"`
	OpenMode      string         `json:"open_mode"`
	VarMapping    []VarMapping   `json:"var_mapping"`
	LabelMapping  []LabelMapping `json:"label_mapping"`
	ExtraMatchers []Matcher      `json:"extra_matchers"`
}

type LinkView struct {
	CITypeID      uint64         `json:"ci_type_id"`
	Provider      string         `json:"provider"`
	Enabled       bool           `json:"enabled"`
	DashboardUID  string         `json:"dashboard_uid,omitempty"`
	DashboardSlug string         `json:"dashboard_slug,omitempty"`
	OpenMode      string         `json:"open_mode,omitempty"`
	VarMapping    []VarMapping   `json:"var_mapping,omitempty"`
	LabelMapping  []LabelMapping `json:"label_mapping,omitempty"`
	ExtraMatchers []Matcher      `json:"extra_matchers,omitempty"`
}

type Linkage struct {
	Grafana    bool `json:"grafana"`
	Prometheus bool `json:"prometheus"`
}

type GrafanaResult struct {
	Configured bool              `json:"configured"`
	Reason     string            `json:"reason,omitempty"`
	UID        string            `json:"uid,omitempty"`
	Slug       string            `json:"slug,omitempty"`
	OpenMode   string            `json:"open_mode,omitempty"`
	Vars       map[string]string `json:"vars,omitempty"`
}

type PromAlertView struct {
	Labels      map[string]string `json:"labels"`
	Annotations map[string]string `json:"annotations,omitempty"`
	State       string            `json:"state"`
	ActiveAt    time.Time         `json:"active_at"`
	Value       string            `json:"value,omitempty"`
}

type PromResult struct {
	Configured bool              `json:"configured"`
	Reason     string            `json:"reason,omitempty"`
	Labels     map[string]string `json:"labels,omitempty"`
	Alerts     []PromAlertView   `json:"alerts"`
	Total      int               `json:"total"`
}

type PreviewResult struct {
	Vars    map[string]string `json:"vars,omitempty"`
	Labels  map[string]string `json:"labels,omitempty"`
	Matched int               `json:"matched"`
	Reason  string            `json:"reason,omitempty"`
}

type Usecase struct {
	repo Repo
	cmdb CMDBReader
	prom PromAlerts
	log  *slog.Logger
}

func NewUsecase(repo Repo, cmdb CMDBReader, prom PromAlerts, log *slog.Logger) *Usecase {
	if log == nil {
		log = slog.Default()
	}
	return &Usecase{repo: repo, cmdb: cmdb, prom: prom, log: log}
}

func (u *Usecase) ListLinks(ctx context.Context, provider string) ([]LinkView, error) {
	if !validProvider(provider) {
		return nil, fmt.Errorf("%w: provider %q", errs.ErrInvalid, provider)
	}
	rows, err := u.repo.List(ctx, provider)
	if err != nil {
		return nil, err
	}
	out := make([]LinkView, 0, len(rows))
	for i := range rows {
		view, err := linkView(&rows[i])
		if err != nil {
			return nil, err
		}
		out = append(out, view)
	}
	return out, nil
}

func (u *Usecase) SaveLink(ctx context.Context, provider string, ciTypeID uint64, in LinkInput) (*LinkView, error) {
	if !validProvider(provider) {
		return nil, fmt.Errorf("%w: provider %q", errs.ErrInvalid, provider)
	}
	if ciTypeID == 0 {
		return nil, fmt.Errorf("%w: ci_type_id is required", errs.ErrInvalid)
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	openMode := strings.ToLower(strings.TrimSpace(in.OpenMode))
	if openMode == "" {
		openMode = model.OpenModeLink
	}
	if openMode != model.OpenModeLink && openMode != model.OpenModeEmbed {
		return nil, fmt.Errorf("%w: open_mode %q", errs.ErrInvalid, openMode)
	}
	for _, mapping := range in.VarMapping {
		if strings.TrimSpace(mapping.CIAttribute) == "" || strings.TrimSpace(mapping.VarName) == "" {
			return nil, fmt.Errorf("%w: var mapping needs an attribute and a variable name", errs.ErrInvalid)
		}
	}
	for _, mapping := range in.LabelMapping {
		if strings.TrimSpace(mapping.CIAttribute) == "" || strings.TrimSpace(mapping.PromLabel) == "" {
			return nil, fmt.Errorf("%w: label mapping needs an attribute and a Prometheus label", errs.ErrInvalid)
		}
	}
	for _, matcher := range in.ExtraMatchers {
		if strings.TrimSpace(matcher.Label) == "" || strings.TrimSpace(matcher.Value) == "" {
			return nil, fmt.Errorf("%w: extra matcher needs a label and a value", errs.ErrInvalid)
		}
		if err := validOp(matcher.Op); err != nil {
			return nil, err
		}
	}
	if provider == model.ProviderGrafana && strings.TrimSpace(in.DashboardUID) == "" {
		return nil, fmt.Errorf("%w: dashboard_uid is required for Grafana", errs.ErrInvalid)
	}
	if provider == model.ProviderPrometheus && len(in.LabelMapping) == 0 && len(in.ExtraMatchers) == 0 {
		return nil, fmt.Errorf("%w: a Prometheus link needs at least one label mapping or matcher", errs.ErrInvalid)
	}
	row := &model.Link{
		CITypeID: ciTypeID, Provider: provider, Enabled: enabled,
		DashboardUID: strings.TrimSpace(in.DashboardUID), DashboardSlug: strings.TrimSpace(in.DashboardSlug),
		OpenMode: openMode,
	}
	var err error
	if row.VarMappingJSON, err = marshal(in.VarMapping); err != nil {
		return nil, err
	}
	if row.LabelMappingJSON, err = marshal(in.LabelMapping); err != nil {
		return nil, err
	}
	if row.ExtraMatchersJSON, err = marshal(in.ExtraMatchers); err != nil {
		return nil, err
	}
	if err := u.repo.Upsert(ctx, row); err != nil {
		return nil, err
	}
	view, err := linkView(row)
	if err != nil {
		return nil, err
	}
	return &view, nil
}

func (u *Usecase) DeleteLink(ctx context.Context, provider string, ciTypeID uint64) error {
	if !validProvider(provider) {
		return fmt.Errorf("%w: provider %q", errs.ErrInvalid, provider)
	}
	return u.repo.Delete(ctx, provider, ciTypeID)
}

// Linkage reports whether the CMDB drawer should show the monitoring tab.
func (u *Usecase) Linkage(ctx context.Context, ciTypeID uint64) (*Linkage, error) {
	out := &Linkage{}
	for _, provider := range []string{model.ProviderGrafana, model.ProviderPrometheus} {
		row, err := u.repo.Get(ctx, provider, ciTypeID)
		if err != nil {
			if errors.Is(err, errs.ErrNotFound) {
				continue
			}
			return nil, err
		}
		if !row.Enabled {
			continue
		}
		if provider == model.ProviderGrafana {
			out.Grafana = true
		} else {
			out.Prometheus = true
		}
	}
	return out, nil
}

func (u *Usecase) GrafanaForCI(ctx context.Context, ciID uint64) (*GrafanaResult, error) {
	ci, reason, err := u.resolveCI(ctx, ciID)
	if err != nil {
		return nil, err
	}
	if ci == nil {
		return &GrafanaResult{Configured: false, Reason: reason}, nil
	}
	row, err := u.repo.Get(ctx, model.ProviderGrafana, ci.TypeID)
	if err != nil {
		if errors.Is(err, errs.ErrNotFound) {
			return &GrafanaResult{Configured: false, Reason: "not_configured"}, nil
		}
		return nil, err
	}
	if !row.Enabled {
		return &GrafanaResult{Configured: false, Reason: "not_configured"}, nil
	}
	mappings, err := unmarshal[VarMapping](row.VarMappingJSON)
	if err != nil {
		return nil, err
	}
	return &GrafanaResult{
		Configured: true, UID: row.DashboardUID, Slug: row.DashboardSlug,
		OpenMode: row.OpenMode, Vars: varsFrom(ci, mappings),
	}, nil
}

func (u *Usecase) PromAlertsForCI(ctx context.Context, ciID uint64) (*PromResult, error) {
	ci, reason, err := u.resolveCI(ctx, ciID)
	if err != nil {
		return nil, err
	}
	if ci == nil {
		return &PromResult{Configured: false, Reason: reason, Alerts: []PromAlertView{}}, nil
	}
	row, err := u.repo.Get(ctx, model.ProviderPrometheus, ci.TypeID)
	if err != nil {
		if errors.Is(err, errs.ErrNotFound) {
			return &PromResult{Configured: false, Reason: "not_configured", Alerts: []PromAlertView{}}, nil
		}
		return nil, err
	}
	if !row.Enabled {
		return &PromResult{Configured: false, Reason: "not_configured", Alerts: []PromAlertView{}}, nil
	}
	labelMappings, err := unmarshal[LabelMapping](row.LabelMappingJSON)
	if err != nil {
		return nil, err
	}
	extra, err := unmarshal[Matcher](row.ExtraMatchersJSON)
	if err != nil {
		return nil, err
	}
	labels := labelsFrom(ci, labelMappings)
	matchers := append(matchersFromLabels(labels), extra...)
	if len(matchers) == 0 {
		return &PromResult{Configured: true, Reason: "no_ci_value", Alerts: []PromAlertView{}}, nil
	}
	if u.prom == nil {
		return &PromResult{Configured: false, Reason: "prometheus_unavailable", Alerts: []PromAlertView{}}, nil
	}
	alerts, err := u.prom.Alerts(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	out := make([]PromAlertView, 0, len(alerts))
	for _, alert := range alerts {
		if matches(alert.Labels, matchers) {
			out = append(out, PromAlertView{
				Labels: alert.Labels, Annotations: alert.Annotations,
				State: alert.State, ActiveAt: alert.ActiveAt, Value: alert.Value,
			})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ActiveAt.After(out[j].ActiveAt) })
	total := len(out)
	if len(out) > 100 {
		out = out[:100]
	}
	return &PromResult{Configured: true, Labels: labels, Alerts: out, Total: total}, nil
}

func (u *Usecase) PreviewLink(ctx context.Context, provider string, ciID uint64, in LinkInput) (*PreviewResult, error) {
	if !validProvider(provider) {
		return nil, fmt.Errorf("%w: provider %q", errs.ErrInvalid, provider)
	}
	ci, reason, err := u.resolveCI(ctx, ciID)
	if err != nil {
		return nil, err
	}
	if ci == nil {
		return &PreviewResult{Reason: reason}, nil
	}
	if provider == model.ProviderGrafana {
		return &PreviewResult{Vars: varsFrom(ci, in.VarMapping)}, nil
	}
	labels := labelsFrom(ci, in.LabelMapping)
	matchers := append(matchersFromLabels(labels), in.ExtraMatchers...)
	out := &PreviewResult{Labels: labels}
	if len(matchers) == 0 {
		out.Reason = "no_ci_value"
		return out, nil
	}
	if u.prom == nil {
		out.Reason = "prometheus_unavailable"
		return out, nil
	}
	alerts, err := u.prom.Alerts(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	for _, alert := range alerts {
		if matches(alert.Labels, matchers) {
			out.Matched++
		}
	}
	return out, nil
}

func (u *Usecase) resolveCI(ctx context.Context, ciID uint64) (*federationbiz.CMDBInstance, string, error) {
	if u.cmdb == nil {
		return nil, "cmdb_unavailable", nil
	}
	ci, err := u.cmdb.GetInstance(ctx, ciID)
	if err != nil {
		return nil, "", err
	}
	if ci == nil {
		return nil, "cmdb_unavailable", nil
	}
	return ci, "", nil
}

func validProvider(provider string) bool {
	return provider == model.ProviderGrafana || provider == model.ProviderPrometheus
}

func validOp(op string) error {
	switch strings.ToLower(strings.TrimSpace(op)) {
	case "", "eq", "ne":
		return nil
	case "regex":
		return nil
	default:
		return fmt.Errorf("%w: matcher op %q", errs.ErrInvalid, op)
	}
}

func varsFrom(ci *federationbiz.CMDBInstance, mappings []VarMapping) map[string]string {
	out := map[string]string{}
	for _, mapping := range mappings {
		value, ok := flatten(ci.Values[mapping.CIAttribute])
		if ok {
			out[mapping.VarName] = value
		}
	}
	return out
}

func labelsFrom(ci *federationbiz.CMDBInstance, mappings []LabelMapping) map[string]string {
	out := map[string]string{}
	for _, mapping := range mappings {
		value, ok := flatten(ci.Values[mapping.CIAttribute])
		if ok {
			out[mapping.PromLabel] = value
		}
	}
	return out
}

func matchersFromLabels(labels map[string]string) []Matcher {
	out := make([]Matcher, 0, len(labels))
	for label, value := range labels {
		out = append(out, Matcher{Label: label, Op: "eq", Value: value})
	}
	return out
}

func matches(labels map[string]string, matchers []Matcher) bool {
	for _, matcher := range matchers {
		value, ok := labels[matcher.Label]
		switch strings.ToLower(strings.TrimSpace(matcher.Op)) {
		case "", "eq":
			if !ok || value != matcher.Value {
				return false
			}
		case "ne":
			if ok && value == matcher.Value {
				return false
			}
		case "regex":
			re, err := regexp.Compile(matcher.Value)
			if err != nil || !re.MatchString(value) {
				return false
			}
		}
	}
	return true
}

func flatten(raw any) (string, bool) {
	switch value := raw.(type) {
	case nil:
		return "", false
	case string:
		value = strings.TrimSpace(value)
		return value, value != ""
	case []string:
		return strings.Join(value, ","), len(value) > 0
	case []any:
		parts := make([]string, 0, len(value))
		for _, item := range value {
			if item != nil {
				if text := strings.TrimSpace(fmt.Sprint(item)); text != "" {
					parts = append(parts, text)
				}
			}
		}
		return strings.Join(parts, ","), len(parts) > 0
	default:
		text := strings.TrimSpace(fmt.Sprint(value))
		return text, text != ""
	}
}

func linkView(row *model.Link) (LinkView, error) {
	vars, err := unmarshal[VarMapping](row.VarMappingJSON)
	if err != nil {
		return LinkView{}, err
	}
	labels, err := unmarshal[LabelMapping](row.LabelMappingJSON)
	if err != nil {
		return LinkView{}, err
	}
	extra, err := unmarshal[Matcher](row.ExtraMatchersJSON)
	if err != nil {
		return LinkView{}, err
	}
	return LinkView{
		CITypeID: row.CITypeID, Provider: row.Provider, Enabled: row.Enabled,
		DashboardUID: row.DashboardUID, DashboardSlug: row.DashboardSlug, OpenMode: row.OpenMode,
		VarMapping: vars, LabelMapping: labels, ExtraMatchers: extra,
	}, nil
}

func marshal[T any](value []T) (string, error) {
	if value == nil {
		return "[]", nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("%w: encode mapping: %v", errs.ErrInvalid, err)
	}
	return string(raw), nil
}

func unmarshal[T any](raw string) ([]T, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var out []T
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, fmt.Errorf("ciobs: decode stored mapping: %w", err)
	}
	return out, nil
}
