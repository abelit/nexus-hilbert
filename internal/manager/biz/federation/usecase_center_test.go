package federation_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	biz "github.com/ongridio/ongrid/internal/manager/biz/federation"
	model "github.com/ongridio/ongrid/internal/manager/model/federation"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

type fakeIdentities map[string][]string

func (f fakeIdentities) Resolve(context.Context, uint64) (map[string][]string, error) {
	return map[string][]string(f), nil
}

func createAlertConnection(t *testing.T, uc *biz.Usecase) {
	t.Helper()
	if _, err := uc.CreateConnection(context.Background(), biz.ConnectionInput{
		Kind: model.KindExternalAlert, Name: "primary",
		BaseURL: "http://morse.invalid", APIPath: "/api/v1/alerts",
	}, 1); err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}
}

func badgeFilter(key string, usage string) biz.FilterInput {
	return biz.FilterInput{
		Key: key, Name: key, Usage: usage, Enabled: ptr(true),
		And: []biz.Rule{{Field: "status", Op: "eq", ValueType: biz.ValueTypeFixed, Values: []string{"firing"}}},
	}
}

func TestSaveFilterBadgeUniqueness(t *testing.T) {
	uc, _ := newUsecase(t, fakeCrypto{}, &fakeQuerier{})
	ctx := context.Background()
	if _, err := uc.SaveFilter(ctx, model.KindExternalAlert, badgeFilter("mine", biz.UsageBoth), ""); err != nil {
		t.Fatalf("SaveFilter mine: %v", err)
	}
	if _, err := uc.SaveFilter(ctx, model.KindExternalAlert, badgeFilter("other", biz.UsageBadge), ""); !errors.Is(err, errs.ErrConflict) {
		t.Fatalf("second badge err = %v", err)
	}
	if _, err := uc.SaveFilter(ctx, model.KindExternalAlert, badgeFilter("plain", biz.UsageFilter), ""); err != nil {
		t.Fatalf("plain filter: %v", err)
	}
}

func TestFilterSummariesExcludeDisabled(t *testing.T) {
	uc, _ := newUsecase(t, fakeCrypto{}, &fakeQuerier{})
	ctx := context.Background()
	if _, err := uc.SaveFilter(ctx, model.KindExternalAlert, badgeFilter("mine", biz.UsageBoth), ""); err != nil {
		t.Fatalf("SaveFilter mine: %v", err)
	}
	off := badgeFilter("off", biz.UsageFilter)
	off.Enabled = ptr(false)
	if _, err := uc.SaveFilter(ctx, model.KindExternalAlert, off, ""); err != nil {
		t.Fatalf("SaveFilter off: %v", err)
	}
	summaries, err := uc.FilterSummaries(ctx, model.KindExternalAlert)
	if err != nil {
		t.Fatalf("FilterSummaries: %v", err)
	}
	if len(summaries) != 1 || summaries[0].Key != "mine" {
		t.Fatalf("summaries = %+v", summaries)
	}
}

func TestListMineUsesIdentityAndVoidsWhenUnbound(t *testing.T) {
	querier := &fakeQuerier{}
	uc, _ := newUsecase(t, fakeCrypto{}, querier)
	createAlertConnection(t, uc)
	ctx := context.Background()
	if _, err := uc.SaveFilter(ctx, model.KindExternalAlert, biz.FilterInput{
		Key: "mine", Name: "Mine", Usage: biz.UsageBoth, Enabled: ptr(true),
		And: []biz.Rule{
			{Field: "owner", Op: "eq", ValueType: biz.ValueTypeIdentity, Identity: "email"},
			{Field: "status", Op: "eq", ValueType: biz.ValueTypeFixed, Values: []string{"firing"}},
		},
	}, ""); err != nil {
		t.Fatalf("SaveFilter: %v", err)
	}

	uc.SetIdentityResolver(fakeIdentities{"email": {"a@b"}})
	res, err := uc.ListMine(ctx, model.KindExternalAlert, "mine", biz.ListRequest{Page: 1, PageSize: 50}, 7)
	if err != nil {
		t.Fatalf("ListMine: %v", err)
	}
	if res.Identity != "bound" || res.Scope != "mine" {
		t.Fatalf("result = %+v", res)
	}
	if len(querier.got.Filters) != 2 || querier.got.Filters[0] != "owner:eq:a@b" || querier.got.Filters[1] != "status:eq:firing" {
		t.Fatalf("filters = %v", querier.got.Filters)
	}

	querier.got = biz.QueryRequest{}
	uc.SetIdentityResolver(fakeIdentities{})
	res, err = uc.ListMine(ctx, model.KindExternalAlert, "mine", biz.ListRequest{Page: 1, PageSize: 50}, 7)
	if err != nil {
		t.Fatalf("ListMine unbound: %v", err)
	}
	if res.Reason != "unbound" || res.Identity != "unbound" {
		t.Fatalf("unbound result = %+v", res)
	}
	if len(querier.got.Filters) != 0 {
		t.Fatalf("unbound query must not be sent: %v", querier.got)
	}
}

func TestStatsCountsAndNilOnUpstreamFailure(t *testing.T) {
	uc, _ := newUsecase(t, fakeCrypto{}, &fakeQuerier{})
	createAlertConnection(t, uc)
	ctx := context.Background()
	stats, err := uc.Stats(ctx, model.KindExternalAlert, "", biz.ListRequest{Days: 7}, 1)
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if !stats.Configured || stats.Total == nil || *stats.Total != 1 {
		t.Fatalf("stats = %+v", stats)
	}
	if stats.ByStatus["firing"] == nil || stats.BySeverity["critical"] == nil {
		t.Fatalf("facets = %+v %+v", stats.ByStatus, stats.BySeverity)
	}

	failing, _ := newUsecase(t, fakeCrypto{}, &fakeQuerier{err: errors.New("upstream down")})
	createAlertConnection(t, failing)
	stats, err = failing.Stats(ctx, model.KindExternalAlert, "", biz.ListRequest{Days: 7}, 1)
	if err != nil {
		t.Fatalf("Stats failing: %v", err)
	}
	if stats.Total != nil {
		t.Fatalf("failed count must be nil, not 0: %+v", stats.Total)
	}
}

func TestFieldPathsReturnsPathsNotValues(t *testing.T) {
	querier := &fakeQuerier{page: &biz.QueryPage{
		Total: 1, Page: 1, PageSize: 50, Pages: 1,
		Items: []json.RawMessage{json.RawMessage(`{"alertname":"DiskFull","alert":{"labels":{"host":"web-1","severity":"critical"}},"__proto__":{"x":"y"}}`)},
	}}
	uc, _ := newUsecase(t, fakeCrypto{}, querier)
	createAlertConnection(t, uc)
	paths, err := uc.FieldPaths(context.Background(), model.KindExternalAlert, 0, "alert.labels")
	if err != nil {
		t.Fatalf("FieldPaths: %v", err)
	}
	if len(paths) != 2 {
		t.Fatalf("paths = %+v", paths)
	}
	for _, path := range paths {
		if path.Path == "alert.labels.host" && path.Count == 1 {
			return
		}
	}
	t.Fatalf("host path missing: %+v", paths)
}

func TestColumnsDefaultAndReplace(t *testing.T) {
	uc, _ := newUsecase(t, fakeCrypto{}, &fakeQuerier{})
	ctx := context.Background()
	defaults, err := uc.GetColumns(ctx, model.KindExternalAlert)
	if err != nil || len(defaults) == 0 {
		t.Fatalf("defaults = %+v, %v", defaults, err)
	}
	replaced, err := uc.ReplaceColumns(ctx, model.KindExternalAlert, []biz.DisplayColumn{
		{ColumnKey: "status", ColumnKind: biz.ColumnKindBuiltin, Visible: true},
		{ColumnKey: "host", ColumnKind: biz.ColumnKindCustom, Path: "alert.labels.host", Render: biz.RenderText, LabelZH: "主机", LabelEN: "Host", Visible: true},
	})
	if err != nil {
		t.Fatalf("ReplaceColumns: %v", err)
	}
	if len(replaced) != 2 || replaced[1].Kind != model.KindExternalAlert {
		t.Fatalf("replaced = %+v", replaced)
	}
	stored, err := uc.GetColumns(ctx, model.KindExternalAlert)
	if err != nil || len(stored) != 2 || stored[1].ColumnKey != "host" {
		t.Fatalf("stored = %+v, %v", stored, err)
	}
}

func TestPreviewFilterUnboundDoesNotQuery(t *testing.T) {
	querier := &fakeQuerier{}
	uc, _ := newUsecase(t, fakeCrypto{}, querier)
	createAlertConnection(t, uc)
	uc.SetIdentityResolver(fakeIdentities{})
	preview, err := uc.PreviewFilter(context.Background(), model.KindExternalAlert, biz.FilterInput{
		Key: "mine", Name: "Mine", Usage: biz.UsageFilter, Enabled: ptr(true),
		And: []biz.Rule{{Field: "owner", Op: "eq", ValueType: biz.ValueTypeIdentity, Identity: "email"}},
	}, 1)
	if err != nil {
		t.Fatalf("PreviewFilter: %v", err)
	}
	if preview.Reason != "unbound" || preview.Matched != 0 {
		t.Fatalf("preview = %+v", preview)
	}
	if len(querier.got.Filters) != 0 {
		t.Fatalf("unbound preview queried: %v", querier.got)
	}
}

func createTicketConnection(t *testing.T, uc *biz.Usecase) {
	t.Helper()
	if _, err := uc.CreateConnection(context.Background(), biz.ConnectionInput{
		Kind: model.KindITSMTicket, Name: "itsm",
		BaseURL: "http://itsm.invalid", APIPath: "/api/v1/webhook/dingtalk/database/incidents",
	}, 1); err != nil {
		t.Fatalf("CreateConnection ticket: %v", err)
	}
}

func TestListItemsTicketUsesFilterGrammarAndCap(t *testing.T) {
	querier := &fakeQuerier{}
	uc, _ := newUsecase(t, fakeCrypto{}, querier)
	createTicketConnection(t, uc)
	if _, err := uc.ListItems(context.Background(), model.KindITSMTicket, biz.ListRequest{
		Status: "RUNNING", Keyword: "disk", PageSize: 9999,
	}); err != nil {
		t.Fatalf("ListItems: %v", err)
	}
	if querier.got.PageSize != 100 {
		t.Fatalf("page size = %d", querier.got.PageSize)
	}
	if querier.got.Table != "" {
		t.Fatalf("ticket table = %q", querier.got.Table)
	}
	want := map[string]bool{
		"form_data.instanceStatus:eq:RUNNING": false,
		"form_data.title:regex:disk":          false,
	}
	for _, filter := range querier.got.Filters {
		if _, ok := want[filter]; ok {
			want[filter] = true
		}
	}
	for filter, found := range want {
		if !found {
			t.Fatalf("filter %q missing from %v", filter, querier.got.Filters)
		}
	}
}

func TestStatsTicketUsesTicketStatuses(t *testing.T) {
	uc, _ := newUsecase(t, fakeCrypto{}, &fakeQuerier{})
	createTicketConnection(t, uc)
	stats, err := uc.Stats(context.Background(), model.KindITSMTicket, "", biz.ListRequest{Days: 30}, 1)
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	for _, status := range []string{"RUNNING", "ERROR", "COMPLETED", "TERMINATED"} {
		if _, ok := stats.ByStatus[status]; !ok {
			t.Fatalf("status %q missing from %+v", status, stats.ByStatus)
		}
	}
	if len(stats.BySeverity) != 0 {
		t.Fatalf("ticket stats must not have severity facets: %+v", stats.BySeverity)
	}
}
