package ciobs_test

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"io"
	"testing"

	ciobsbiz "github.com/ongridio/ongrid/internal/manager/biz/ciobs"
	federationbiz "github.com/ongridio/ongrid/internal/manager/biz/federation"
	model "github.com/ongridio/ongrid/internal/manager/model/ciobs"
	"github.com/ongridio/ongrid/internal/pkg/errs"
	"github.com/ongridio/ongrid/internal/pkg/promquery"
)

type fakeRepo struct {
	links map[string]model.Link
}

func newFakeRepo() *fakeRepo { return &fakeRepo{links: map[string]model.Link{}} }

func key(provider string, typeID uint64) string {
	return fmt.Sprintf("%s/%d", provider, typeID)
}

func (f *fakeRepo) List(_ context.Context, provider string) ([]model.Link, error) {
	out := []model.Link{}
	for _, link := range f.links {
		if link.Provider == provider {
			out = append(out, link)
		}
	}
	return out, nil
}

func (f *fakeRepo) Get(_ context.Context, provider string, typeID uint64) (*model.Link, error) {
	link, ok := f.links[key(provider, typeID)]
	if !ok {
		return nil, fmt.Errorf("%w: link", errs.ErrNotFound)
	}
	return &link, nil
}

func (f *fakeRepo) Upsert(_ context.Context, link *model.Link) error {
	f.links[key(link.Provider, link.CITypeID)] = *link
	return nil
}

func (f *fakeRepo) Delete(_ context.Context, provider string, typeID uint64) error {
	k := key(provider, typeID)
	if _, ok := f.links[k]; !ok {
		return fmt.Errorf("%w: link", errs.ErrNotFound)
	}
	delete(f.links, k)
	return nil
}

type fakeCMDB struct {
	instance *federationbiz.CMDBInstance
}

func (f fakeCMDB) GetInstance(context.Context, uint64) (*federationbiz.CMDBInstance, error) {
	return f.instance, nil
}

type fakeProm struct {
	alerts []promquery.Alert
	err    error
}

func (f fakeProm) Alerts(context.Context) ([]promquery.Alert, error) {
	return f.alerts, f.err
}

func newUsecase(t *testing.T, cmdb *federationbiz.CMDBInstance, prom ciobsbiz.PromAlerts) (*ciobsbiz.Usecase, *fakeRepo) {
	t.Helper()
	repo := newFakeRepo()
	var reader ciobsbiz.CMDBReader
	if cmdb != nil {
		reader = fakeCMDB{instance: cmdb}
	}
	return ciobsbiz.NewUsecase(repo, reader, prom, slog.New(slog.NewTextHandler(io.Discard, nil))), repo
}

func TestSaveLinkAndList(t *testing.T) {
	uc, _ := newUsecase(t, nil, nil)
	ctx := context.Background()
	enabled := true
	view, err := uc.SaveLink(ctx, model.ProviderGrafana, 3, ciobsbiz.LinkInput{
		Enabled: &enabled, DashboardUID: "server-detail", DashboardSlug: "server-detail",
		VarMapping: []ciobsbiz.VarMapping{{CIAttribute: "hostname", VarName: "device_id"}},
	})
	if err != nil {
		t.Fatalf("SaveLink: %v", err)
	}
	if view.CITypeID != 3 || view.DashboardUID != "server-detail" || !view.Enabled {
		t.Fatalf("view = %+v", view)
	}
	rows, err := uc.ListLinks(ctx, model.ProviderGrafana)
	if err != nil || len(rows) != 1 {
		t.Fatalf("ListLinks = %+v, %v", rows, err)
	}
	if _, err := uc.SaveLink(ctx, model.ProviderGrafana, 4, ciobsbiz.LinkInput{}); !errors.Is(err, errs.ErrInvalid) {
		t.Fatalf("missing uid err = %v", err)
	}
	if _, err := uc.SaveLink(ctx, model.ProviderPrometheus, 4, ciobsbiz.LinkInput{}); !errors.Is(err, errs.ErrInvalid) {
		t.Fatalf("empty prom link err = %v", err)
	}
}

func TestGrafanaForCI(t *testing.T) {
	ci := &federationbiz.CMDBInstance{ID: 7, TypeID: 3, Values: map[string]any{"hostname": "web-1"}}
	uc, _ := newUsecase(t, ci, nil)
	ctx := context.Background()
	if _, err := uc.SaveLink(ctx, model.ProviderGrafana, 3, ciobsbiz.LinkInput{
		DashboardUID: "dash", DashboardSlug: "detail",
		VarMapping: []ciobsbiz.VarMapping{{CIAttribute: "hostname", VarName: "device_id"}},
	}); err != nil {
		t.Fatalf("SaveLink: %v", err)
	}
	got, err := uc.GrafanaForCI(ctx, 7)
	if err != nil {
		t.Fatalf("GrafanaForCI: %v", err)
	}
	if !got.Configured || got.UID != "dash" || got.Vars["device_id"] != "web-1" {
		t.Fatalf("got = %+v", got)
	}
	missingUC, _ := newUsecase(t, &federationbiz.CMDBInstance{ID: 8, TypeID: 4, Values: map[string]any{}}, nil)
	missing, err := missingUC.GrafanaForCI(ctx, 8)
	if err != nil || missing.Configured || missing.Reason != "not_configured" {
		t.Fatalf("missing = %+v, %v", missing, err)
	}
}

func TestPromAlertsForCIFilters(t *testing.T) {
	ci := &federationbiz.CMDBInstance{ID: 7, TypeID: 3, Values: map[string]any{"hostname": "web-1"}}
	prom := fakeProm{alerts: []promquery.Alert{
		{Labels: map[string]string{"host": "web-1", "severity": "critical"}, State: "firing"},
		{Labels: map[string]string{"host": "web-1", "severity": "warning"}, State: "firing"},
		{Labels: map[string]string{"host": "web-2", "severity": "critical"}, State: "firing"},
	}}
	uc, _ := newUsecase(t, ci, prom)
	ctx := context.Background()
	if _, err := uc.SaveLink(ctx, model.ProviderPrometheus, 3, ciobsbiz.LinkInput{
		LabelMapping:  []ciobsbiz.LabelMapping{{CIAttribute: "hostname", PromLabel: "host"}},
		ExtraMatchers: []ciobsbiz.Matcher{{Label: "severity", Op: "eq", Value: "critical"}},
	}); err != nil {
		t.Fatalf("SaveLink: %v", err)
	}
	got, err := uc.PromAlertsForCI(ctx, 7)
	if err != nil {
		t.Fatalf("PromAlertsForCI: %v", err)
	}
	if !got.Configured || got.Total != 1 || len(got.Alerts) != 1 {
		t.Fatalf("got = %+v", got)
	}
	if got.Labels["host"] != "web-1" {
		t.Fatalf("labels = %+v", got.Labels)
	}
}

func TestPromAlertsNoCIValueAndNoProm(t *testing.T) {
	ci := &federationbiz.CMDBInstance{ID: 7, TypeID: 3, Values: map[string]any{}}
	uc, _ := newUsecase(t, ci, nil)
	ctx := context.Background()
	if _, err := uc.SaveLink(ctx, model.ProviderPrometheus, 3, ciobsbiz.LinkInput{
		LabelMapping: []ciobsbiz.LabelMapping{{CIAttribute: "hostname", PromLabel: "host"}},
	}); err != nil {
		t.Fatalf("SaveLink: %v", err)
	}
	got, err := uc.PromAlertsForCI(ctx, 7)
	if err != nil || got.Reason != "no_ci_value" {
		t.Fatalf("no value = %+v, %v", got, err)
	}

	ci.Values["hostname"] = "web-1"
	got, err = uc.PromAlertsForCI(ctx, 7)
	if err != nil || got.Reason != "prometheus_unavailable" {
		t.Fatalf("no prom = %+v, %v", got, err)
	}
}

func TestLinkageAndCMDBUnavailable(t *testing.T) {
	uc, _ := newUsecase(t, nil, nil)
	if _, err := uc.SaveLink(context.Background(), model.ProviderGrafana, 3, ciobsbiz.LinkInput{DashboardUID: "d"}); err != nil {
		t.Fatalf("SaveLink: %v", err)
	}
	linkage, err := uc.Linkage(context.Background(), 3)
	if err != nil || !linkage.Grafana || linkage.Prometheus {
		t.Fatalf("linkage = %+v, %v", linkage, err)
	}
	got, err := uc.GrafanaForCI(context.Background(), 7)
	if err != nil || got.Reason != "cmdb_unavailable" {
		t.Fatalf("grafana = %+v, %v", got, err)
	}
	alerts, err := uc.PromAlertsForCI(context.Background(), 7)
	if err != nil || alerts.Reason != "cmdb_unavailable" {
		t.Fatalf("alerts = %+v, %v", alerts, err)
	}
}
