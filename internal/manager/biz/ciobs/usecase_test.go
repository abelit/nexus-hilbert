package ciobs_test

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"

	ciobsbiz "github.com/ongridio/ongrid/internal/manager/biz/ciobs"
	federationbiz "github.com/ongridio/ongrid/internal/manager/biz/federation"
	model "github.com/ongridio/ongrid/internal/manager/model/ciobs"
	"github.com/ongridio/ongrid/internal/pkg/errs"
	"github.com/ongridio/ongrid/internal/pkg/promquery"
)

type fakeCrypto struct{ weak bool }

func (f fakeCrypto) Encrypt(plain string) (string, error) {
	return "enc:" + base64.StdEncoding.EncodeToString([]byte(plain)), nil
}
func (f fakeCrypto) Decrypt(cipher string) (string, error) {
	if !strings.HasPrefix(cipher, "enc:") {
		return "", errors.New("bad cipher")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(cipher, "enc:"))
	if err != nil {
		return "", err
	}
	return string(raw), nil
}
func (f fakeCrypto) Weak() bool { return f.weak }

type fakeRepo struct {
	links  map[string]model.Link
	conns  map[uint64]model.Connection
	nextID uint64
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{links: map[string]model.Link{}, conns: map[uint64]model.Connection{}, nextID: 1}
}

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

func (f *fakeRepo) ListConnections(_ context.Context, provider string) ([]model.Connection, error) {
	out := []model.Connection{}
	for _, conn := range f.conns {
		if conn.Provider == provider {
			out = append(out, conn)
		}
	}
	return out, nil
}

func (f *fakeRepo) GetConnection(_ context.Context, id uint64) (*model.Connection, error) {
	conn, ok := f.conns[id]
	if !ok {
		return nil, fmt.Errorf("%w: connection", errs.ErrNotFound)
	}
	return &conn, nil
}

func (f *fakeRepo) CreateConnection(_ context.Context, conn *model.Connection) error {
	conn.ID = f.nextID
	f.nextID++
	f.conns[conn.ID] = *conn
	return nil
}

func (f *fakeRepo) UpdateConnection(_ context.Context, conn *model.Connection) error {
	if _, ok := f.conns[conn.ID]; !ok {
		return fmt.Errorf("%w: connection", errs.ErrNotFound)
	}
	f.conns[conn.ID] = *conn
	return nil
}

func (f *fakeRepo) DeleteConnection(_ context.Context, id uint64) error {
	for _, link := range f.links {
		if link.ConnectionID == id {
			return fmt.Errorf("%w: connection referenced", errs.ErrConflict)
		}
	}
	if _, ok := f.conns[id]; !ok {
		return fmt.Errorf("%w: connection", errs.ErrNotFound)
	}
	delete(f.conns, id)
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

func TestListConnectionsIncludesInternal(t *testing.T) {
	uc, _ := newUsecase(t, nil, nil)
	rows, err := uc.ListConnections(context.Background(), model.ProviderGrafana)
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows = %+v, %v", rows, err)
	}
	if rows[0].ID != 0 || rows[0].Kind != model.ConnectionKindInternal || !rows[0].Enabled {
		t.Fatalf("internal = %+v", rows[0])
	}
}

type failingProbe struct{ err error }

func (f failingProbe) ProbeGrafana(context.Context) error { return f.err }
func (f failingProbe) ProbeProm(context.Context) error    { return f.err }

func TestConnectionsHealthInternalPointsAtIntegrations(t *testing.T) {
	uc, _ := newUsecase(t, nil, nil)
	uc.SetGlobalProbe(failingProbe{err: errors.New("grafana: sa_token / api_key empty")})
	rows, err := uc.ConnectionsHealth(context.Background(), model.ProviderGrafana)
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows = %+v, %v", rows, err)
	}
	if rows[0].OK {
		t.Fatalf("internal connection reported healthy")
	}
	if !strings.Contains(rows[0].Error, "sa_token / api_key empty") {
		t.Fatalf("probe error lost: %q", rows[0].Error)
	}
	if !strings.Contains(rows[0].Error, "Settings → Integrations") {
		t.Fatalf("error does not point at the global integration: %q", rows[0].Error)
	}
}

func TestSaveConnectionEncryptsAndMasks(t *testing.T) {
	uc, repo := newUsecase(t, nil, nil)
	uc.SetCrypto(fakeCrypto{})
	view, err := uc.SaveConnection(context.Background(), model.ProviderGrafana, ciobsbiz.ConnectionInput{
		Provider: model.ProviderGrafana, Name: "external", BaseURL: "https://grafana.example.com/grafana/",
		AuthType: "bearer", Auth: &ciobsbiz.Credentials{Token: "tok-secret"},
	}, 0)
	if err != nil {
		t.Fatalf("SaveConnection: %v", err)
	}
	if view.Kind != model.ConnectionKindExternal || !view.TokenSet || view.PasswordSet {
		t.Fatalf("view = %+v", view)
	}
	if view.BaseURL != "https://grafana.example.com/grafana" {
		t.Fatalf("base = %q", view.BaseURL)
	}
	stored := repo.conns[view.ID]
	if strings.Contains(stored.AuthCipher, "tok-secret") || stored.AuthCipher == "" {
		t.Fatalf("cipher = %q", stored.AuthCipher)
	}
	rows, _ := uc.ListConnections(context.Background(), model.ProviderGrafana)
	if len(rows) != 2 || rows[1].Name != "external" {
		t.Fatalf("list = %+v", rows)
	}
}

func TestGrafanaForCIExternalRoot(t *testing.T) {
	uc, _ := newUsecase(t, &federationbiz.CMDBInstance{ID: 7, TypeID: 3, Values: map[string]any{"hostname": "web-1"}}, nil)
	uc.SetCrypto(fakeCrypto{})
	conn, err := uc.SaveConnection(context.Background(), model.ProviderGrafana, ciobsbiz.ConnectionInput{
		Provider: model.ProviderGrafana, Name: "external", BaseURL: "https://grafana.example.com/grafana",
		AuthType: "bearer", Auth: &ciobsbiz.Credentials{Token: "tok"},
	}, 0)
	if err != nil {
		t.Fatalf("SaveConnection: %v", err)
	}
	if _, err := uc.SaveLink(context.Background(), model.ProviderGrafana, 3, ciobsbiz.LinkInput{
		ConnectionID: conn.ID, DashboardUID: "dash",
		VarMapping: []ciobsbiz.VarMapping{{CIAttribute: "hostname", VarName: "device_id"}},
	}); err != nil {
		t.Fatalf("SaveLink: %v", err)
	}
	got, err := uc.GrafanaForCI(context.Background(), 7)
	if err != nil {
		t.Fatalf("GrafanaForCI: %v", err)
	}
	if got.Kind != model.ConnectionKindExternal || got.RootURL != "https://grafana.example.com/grafana" || got.Vars["device_id"] != "web-1" {
		t.Fatalf("got = %+v", got)
	}
}

func TestDeleteConnectionRefusesWhenReferenced(t *testing.T) {
	uc, _ := newUsecase(t, nil, nil)
	uc.SetCrypto(fakeCrypto{})
	conn, err := uc.SaveConnection(context.Background(), model.ProviderGrafana, ciobsbiz.ConnectionInput{
		Provider: model.ProviderGrafana, Name: "external", BaseURL: "https://grafana.example.com",
		AuthType: "bearer", Auth: &ciobsbiz.Credentials{Token: "tok"},
	}, 0)
	if err != nil {
		t.Fatalf("SaveConnection: %v", err)
	}
	if _, err := uc.SaveLink(context.Background(), model.ProviderGrafana, 3, ciobsbiz.LinkInput{
		ConnectionID: conn.ID, DashboardUID: "dash",
	}); err != nil {
		t.Fatalf("SaveLink: %v", err)
	}
	if err := uc.DeleteConnection(context.Background(), conn.ID); !errors.Is(err, errs.ErrConflict) {
		t.Fatalf("delete err = %v", err)
	}
}

func TestSaveLinkRejectsWrongProviderConnection(t *testing.T) {
	uc, _ := newUsecase(t, nil, nil)
	uc.SetCrypto(fakeCrypto{})
	conn, err := uc.SaveConnection(context.Background(), model.ProviderGrafana, ciobsbiz.ConnectionInput{
		Provider: model.ProviderGrafana, Name: "external", BaseURL: "https://grafana.example.com",
		AuthType: "bearer", Auth: &ciobsbiz.Credentials{Token: "tok"},
	}, 0)
	if err != nil {
		t.Fatalf("SaveConnection: %v", err)
	}
	_, err = uc.SaveLink(context.Background(), model.ProviderPrometheus, 3, ciobsbiz.LinkInput{
		ConnectionID: conn.ID,
		LabelMapping: []ciobsbiz.LabelMapping{{CIAttribute: "hostname", PromLabel: "host"}},
	})
	if !errors.Is(err, errs.ErrInvalid) {
		t.Fatalf("err = %v", err)
	}
}
