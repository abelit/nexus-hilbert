package discovery

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"errors"
	"testing"
	"time"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	discoverymodel "github.com/ongridio/ongrid/internal/cmdb/model/discovery"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

type stubAgentRepo struct {
	principals map[string]discoverymodel.AgentPrincipal
	eulers     map[string]discoverymodel.Euler
	receipts   map[string]discoverymodel.ReportReceipt
	states     []EulerTaskStateWrite
	stale      []string
	nextID     model.ID
}

func newAgentStub() *stubAgentRepo {
	return &stubAgentRepo{
		principals: map[string]discoverymodel.AgentPrincipal{},
		eulers:     map[string]discoverymodel.Euler{},
		receipts:   map[string]discoverymodel.ReportReceipt{},
		nextID:     100,
	}
}

func (s *stubAgentRepo) CreateAgentPrincipal(_ context.Context, in AgentPrincipalWrite) (*discoverymodel.AgentPrincipal, error) {
	s.nextID++
	row := discoverymodel.AgentPrincipal{
		Name: in.Name, PublicID: in.PublicID, SecretSHA256: in.SecretSHA256,
		RiemannID: in.RiemannID, ScopesJSON: in.ScopesJSON, ExpiresAt: in.ExpiresAt,
	}
	row.ID = s.nextID
	s.principals[in.PublicID] = row
	return &row, nil
}

func (s *stubAgentRepo) FindAgentPrincipalByPublicID(_ context.Context, publicID string) (*discoverymodel.AgentPrincipal, error) {
	row, ok := s.principals[publicID]
	if !ok {
		return nil, nil
	}
	return &row, nil
}

func (s *stubAgentRepo) ListAgentPrincipals(context.Context) ([]discoverymodel.AgentPrincipal, error) {
	out := make([]discoverymodel.AgentPrincipal, 0, len(s.principals))
	for _, row := range s.principals {
		out = append(out, row)
	}
	return out, nil
}

func (s *stubAgentRepo) RevokeAgentPrincipal(_ context.Context, id model.ID, at time.Time) error {
	for key, row := range s.principals {
		if row.ID == id {
			row.RevokedAt = &at
			s.principals[key] = row
		}
	}
	return nil
}

func (s *stubAgentRepo) TouchAgentPrincipal(context.Context, model.ID, time.Time) error {
	return nil
}

func (s *stubAgentRepo) UpsertEuler(_ context.Context, in EulerWrite) (*discoverymodel.Euler, error) {
	row := discoverymodel.Euler{
		EulerID: in.EulerID, RiemannID: in.RiemannID, Hostname: in.Hostname,
		IPAddress: in.IPAddress, OSType: in.OSType, Version: in.Version,
		RolesJSON: in.RolesJSON, CapabilitiesJSON: in.CapabilitiesJSON,
		PublicKey: in.PublicKey, CertSerial: in.CertSerial, Status: in.Status,
	}
	if old, ok := s.eulers[in.EulerID]; ok {
		row.ID = old.ID
	} else {
		s.nextID++
		row.ID = s.nextID
	}
	s.eulers[in.EulerID] = row
	return &row, nil
}

func (s *stubAgentRepo) LoadEuler(_ context.Context, eulerID string) (*discoverymodel.Euler, error) {
	row, ok := s.eulers[eulerID]
	if !ok {
		return nil, nil
	}
	return &row, nil
}

func (s *stubAgentRepo) ListEulers(context.Context) ([]discoverymodel.Euler, error) {
	out := make([]discoverymodel.Euler, 0, len(s.eulers))
	for _, row := range s.eulers {
		out = append(out, row)
	}
	return out, nil
}

func (s *stubAgentRepo) TouchEuler(_ context.Context, eulerID string, at time.Time, capabilities string) error {
	row, ok := s.eulers[eulerID]
	if !ok {
		return nil
	}
	row.LastSeenAt = &at
	if capabilities != "" {
		row.CapabilitiesJSON = capabilities
	}
	s.eulers[eulerID] = row
	return nil
}

func (s *stubAgentRepo) CreateEnrollmentToken(context.Context, EnrollmentTokenWrite) (*discoverymodel.EnrollmentToken, error) {
	return &discoverymodel.EnrollmentToken{}, nil
}

func (s *stubAgentRepo) ConsumeEnrollmentToken(context.Context, string, time.Time) (*discoverymodel.EnrollmentToken, error) {
	return nil, nil
}

func (s *stubAgentRepo) UpsertEulerTaskState(_ context.Context, in EulerTaskStateWrite) error {
	s.states = append(s.states, in)
	return nil
}

func (s *stubAgentRepo) CreateReportReceipt(_ context.Context, in ReportReceiptWrite) (*discoverymodel.ReportReceipt, error) {
	row := discoverymodel.ReportReceipt{ReportID: in.ReportID, TaskID: in.TaskID, Status: in.Status}
	if in.CIID != 0 {
		row.CIID = &in.CIID
	}
	s.receipts[in.ReportID] = row
	return &row, nil
}

func (s *stubAgentRepo) FindReportReceipt(_ context.Context, reportID string) (*discoverymodel.ReportReceipt, error) {
	row, ok := s.receipts[reportID]
	if !ok {
		return nil, nil
	}
	return &row, nil
}

func (s *stubAgentRepo) MarkPoolStale(_ context.Context, _ model.ID, unique string, _ time.Time) error {
	s.stale = append(s.stale, unique)
	return nil
}

func agentFixture(t *testing.T) (*Usecase, *stubRepo, *stubAgentRepo, *stubPoolRepo) {
	t.Helper()
	repo := newStub()
	rule := discoverymodel.Rule{Name: "server", Type: strp("agent")}
	rule.ID = 1
	target := discoverymodel.Target{
		AdrID: idp(1), TypeID: idp(1), AgentID: strp("0xabc"),
		Cron:       strp("*/5 * * * *"),
		Attributes: map[string]any{"machine_uuid": "hostname"},
	}
	target.ID = 10
	target.Enabled = true
	repo.rules = []discoverymodel.Rule{rule}
	repo.targets = []discoverymodel.Target{target}

	agents := newAgentStub()
	agents.eulers["0xabc"] = discoverymodel.Euler{
		EulerID: "0xabc", RiemannID: "riemann-1", Hostname: "host-1", Status: "active",
	}
	pool := newPoolStub()
	uc := NewUsecase(repo).
		WithAgents(agents).
		WithModels(modelsFor(1, "host", "hostname")).
		WithPool(pool)
	return uc, repo, agents, pool
}

func agentPrincipal(scopes ...string) AgentPrincipalView {
	if len(scopes) == 0 {
		scopes = AgentScopes()
	}
	return AgentPrincipalView{ID: 1, PublicID: "public", RiemannID: "riemann-1", Scopes: scopes}
}

func TestAgentTaskSyncIsIncrementalAndDeterministic(t *testing.T) {
	uc, repo, agents, _ := agentFixture(t)
	ctx := context.Background()
	principal := agentPrincipal()

	first, err := uc.SyncAgentTasks(ctx, principal, AgentTaskSyncRequest{EulerID: "0xabc"})
	if err != nil {
		t.Fatalf("first sync: %v", err)
	}
	if len(first.Changed) != 1 || first.Changed[0].CollectKey != "server" {
		t.Fatalf("first snapshot = %+v", first)
	}
	task := first.Changed[0]
	if task.UniqueKey != "machine_uuid" || task.Mapping["machine_uuid"] != "hostname" {
		t.Fatalf("task mapping = %+v", task)
	}
	// The handover log is what the console's health panel reads: the collector
	// that pulled the target and when it was last pulled.
	if len(repo.histories) != 1 || derefID(repo.histories[0].AdtID) != 10 ||
		derefString(repo.histories[0].OneagentID) != "0xabc" ||
		derefString(repo.histories[0].OneagentName) != "host-1" {
		t.Fatalf("handover log = %+v", repo.histories)
	}

	// The same task at the same revision is not re-sent.
	second, err := uc.SyncAgentTasks(ctx, principal, AgentTaskSyncRequest{
		EulerID: "0xabc",
		Known:   []AgentTaskRevision{{TaskID: task.TaskID, Revision: task.Revision}},
	})
	if err != nil {
		t.Fatalf("second sync: %v", err)
	}
	if len(second.Changed) != 0 {
		t.Fatalf("unchanged task was re-sent: %+v", second.Changed)
	}

	// A schedule edit changes the revision.
	repo.targets[0].Cron = strp("*/10 * * * *")
	third, err := uc.SyncAgentTasks(ctx, principal, AgentTaskSyncRequest{
		EulerID: "0xabc",
		Known:   []AgentTaskRevision{{TaskID: task.TaskID, Revision: task.Revision}},
	})
	if err != nil {
		t.Fatalf("third sync: %v", err)
	}
	if len(third.Changed) != 1 || third.Changed[0].Revision == task.Revision {
		t.Fatalf("schedule edit did not change the revision: %+v", third.Changed)
	}

	// Reassigning the target removes it from this euler.
	repo.targets[0].AgentID = strp("0xdef")
	fourth, err := uc.SyncAgentTasks(ctx, principal, AgentTaskSyncRequest{
		EulerID: "0xabc",
		Known:   []AgentTaskRevision{{TaskID: task.TaskID, Revision: third.Changed[0].Revision}},
	})
	if err != nil {
		t.Fatalf("fourth sync: %v", err)
	}
	if len(fourth.RemovedTaskIDs) != 1 || fourth.RemovedTaskIDs[0] != task.TaskID {
		t.Fatalf("removal = %+v", fourth)
	}
	_ = agents
}

func TestCollectorInventoryIsAdminOnly(t *testing.T) {
	uc, _, _, _ := agentFixture(t)
	ctx := context.Background()
	if _, err := uc.ListEulers(ctx, Actor{UserID: 7}); !errors.Is(err, errs.ErrForbidden) {
		t.Fatalf("non-admin inventory err = %v", err)
	}
	got, err := uc.ListEulers(ctx, Actor{UserID: 1, IsAdmin: true})
	if err != nil {
		t.Fatalf("admin inventory: %v", err)
	}
	if len(got) != 1 || got[0].EulerID != "0xabc" {
		t.Fatalf("inventory = %+v", got)
	}
}

func TestTargetHealthJoinsHeartbeatAndHandover(t *testing.T) {
	uc, _, agents, _ := agentFixture(t)
	ctx := context.Background()
	now := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	uc.Now = func() time.Time { return now }

	seen := now.Add(-time.Minute)
	euler := agents.eulers["0xabc"]
	euler.LastSeenAt = &seen
	agents.eulers["0xabc"] = euler

	// The first sync sends the task and writes the handover log.
	if _, err := uc.SyncAgentTasks(ctx, agentPrincipal(), AgentTaskSyncRequest{EulerID: "0xabc"}); err != nil {
		t.Fatalf("sync: %v", err)
	}
	health, err := uc.TargetHealth(ctx, 10)
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	if len(health.Agents) != 1 {
		t.Fatalf("agents = %+v", health.Agents)
	}
	agent := health.Agents[0]
	if agent.EulerID != "0xabc" || !agent.Registered || !agent.Eligible || !agent.Online {
		t.Fatalf("agent health = %+v", agent)
	}
	if agent.LastSeenAt != cmdbTime(seen) || agent.LastHandoverAt != cmdbTime(now) {
		t.Fatalf("timestamps = %+v", agent)
	}

	// A silent collector flips to offline without losing the handover record.
	stale := now.Add(-DefaultTargetOnlineWindow - time.Minute)
	euler.LastSeenAt = &stale
	agents.eulers["0xabc"] = euler
	health, err = uc.TargetHealth(ctx, 10)
	if err != nil {
		t.Fatalf("health after silence: %v", err)
	}
	if health.Agents[0].Online {
		t.Fatal("silent collector still reads online")
	}
	if health.Agents[0].LastHandoverAt == "" {
		t.Fatal("offline collector lost its last handover")
	}
}

func TestTargetHealthReportsUnregisteredAndScopedWarnings(t *testing.T) {
	uc, repo, _, _ := agentFixture(t)
	ctx := context.Background()

	// An explicitly bound collector that has not registered is still named,
	// because an empty list would hide the binding mistake.
	repo.targets[0].AgentID = strp("0xdef")
	health, err := uc.TargetHealth(ctx, 10)
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	if len(health.Agents) != 1 || health.Agents[0].EulerID != "0xdef" ||
		health.Agents[0].Registered || !health.Agents[0].Eligible || health.Agents[0].Online {
		t.Fatalf("unregistered agent = %+v", health.Agents)
	}

	// A cloud target with no explicit collector can never be handed to a host
	// collector, and the health view says so instead of looking merely empty.
	cloudRule := discoverymodel.Rule{Name: "aliyun", Type: strp("http")}
	cloudRule.ID = 2
	repo.rules = append(repo.rules, cloudRule)
	cloud := discoverymodel.Target{
		AdrID: idp(2), TypeID: idp(1), Cron: strp("0 * * * *"), Enabled: true,
		Attributes: map[string]any{"instance_id": "uuid"},
	}
	cloud.ID = 20
	repo.targets = append(repo.targets, cloud)

	health, err = uc.TargetHealth(ctx, 20)
	if err != nil {
		t.Fatalf("cloud health: %v", err)
	}
	if len(health.Agents) != 0 {
		t.Fatalf("cloud target gained host collectors: %+v", health.Agents)
	}
	found := false
	for _, warning := range health.Warnings {
		if warning == "cloud and SNMP targets need a named collector" {
			found = true
		}
	}
	if !found {
		t.Fatalf("warnings = %+v", health.Warnings)
	}
}

func TestAgentTaskCarriesSecretEnvelope(t *testing.T) {
	uc, repo, agents, _ := agentFixture(t)
	curve := ecdh.X25519()
	key, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	euler := agents.eulers["0xabc"]
	euler.PublicKey = key.PublicKey().Bytes()
	agents.eulers["0xabc"] = euler
	repo.targets[0].ExtraOption = map[string]any{"secret": "s3cr3t", "region": "cn-hangzhou"}

	snapshot, err := uc.SyncAgentTasks(context.Background(), agentPrincipal(), AgentTaskSyncRequest{EulerID: "0xabc"})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(snapshot.Changed) != 1 {
		t.Fatalf("changed = %d", len(snapshot.Changed))
	}
	task := snapshot.Changed[0]
	if len(task.SecretEnvelope) == 0 || task.SecretKeyID == "" || task.SecretAlg == "" {
		t.Fatalf("secret envelope missing: %+v", task)
	}
	if task.Params["secret"] != nil {
		t.Fatalf("secret leaked into params: %+v", task.Params)
	}
	if task.Params["region"] != "cn-hangzhou" {
		t.Fatalf("non-secret param lost: %+v", task.Params)
	}
	if task.SecretFingerprint == "" {
		t.Fatal("revision fingerprint is empty")
	}
}

func TestAgentPrincipalIsIssuedOnceAndRevocable(t *testing.T) {
	uc, _, _, _ := agentFixture(t)
	ctx := context.Background()
	admin := Actor{UserID: 1, IsAdmin: true}

	created, err := uc.CreateAgentPrincipal(ctx, "site-a", "riemann-1", nil, time.Hour, admin)
	if err != nil {
		t.Fatalf("create principal: %v", err)
	}
	got, err := uc.AuthenticateAgent(ctx, created.Secret)
	if err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	if !got.Allows(ScopeTasksRead) {
		t.Fatalf("issued principal has no tasks scope: %+v", got)
	}
	if _, err := uc.AuthenticateAgent(ctx, created.Secret+"x"); !errors.Is(err, errs.ErrUnauthorized) {
		t.Fatalf("wrong secret err = %v", err)
	}
	if err := uc.RevokeAgentPrincipal(ctx, created.Principal.ID, admin); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := uc.AuthenticateAgent(ctx, created.Secret); !errors.Is(err, errs.ErrUnauthorized) {
		t.Fatalf("revoked principal authenticated: %v", err)
	}
}

func TestAgentReportsAreBoundAndIdempotent(t *testing.T) {
	uc, _, agents, pool := agentFixture(t)
	ctx := context.Background()
	principal := agentPrincipal(ScopeReportsWrite)
	report := AgentReport{
		ReportID: "r-1", TaskID: "t:10",
		Instance: []byte(`{"machine_uuid":"m-1","hostname":"host-1"}`),
	}
	results, err := uc.SubmitAgentReports(ctx, principal, AgentReportRequest{
		EulerID: "0xabc", Reports: []AgentReport{report},
	})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if len(results) != 1 || results[0].Status != "accepted" {
		t.Fatalf("results = %+v", results)
	}
	if pool.lastWrite.UniqueValue != "m-1" {
		t.Fatalf("unique value = %q", pool.lastWrite.UniqueValue)
	}

	// The same report id is a duplicate, not a second sighting.
	again, err := uc.SubmitAgentReports(ctx, principal, AgentReportRequest{
		EulerID: "0xabc", Reports: []AgentReport{report},
	})
	if err != nil {
		t.Fatalf("duplicate: %v", err)
	}
	if again[0].Status != "duplicate" {
		t.Fatalf("duplicate status = %q", again[0].Status)
	}

	// A deletion marks the sighting stale rather than deleting a CI.
	deleted := report
	deleted.ReportID = "r-2"
	deleted.Deleted = true
	deleted.UniqueValue = "m-1"
	if _, err := uc.SubmitAgentReports(ctx, principal, AgentReportRequest{
		EulerID: "0xabc", Reports: []AgentReport{deleted},
	}); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if len(agents.stale) != 1 || agents.stale[0] != "m-1" {
		t.Fatalf("stale = %+v", agents.stale)
	}
}

func TestAgentReportsRejectAnotherEuler(t *testing.T) {
	uc, _, _, _ := agentFixture(t)
	principal := agentPrincipal(ScopeReportsWrite)
	results, err := uc.SubmitAgentReports(context.Background(), principal, AgentReportRequest{
		EulerID: "0xdef",
		Reports: []AgentReport{{ReportID: "r-1", TaskID: "t:10", Instance: []byte(`{}`)}},
	})
	if err == nil {
		t.Fatalf("another euler was accepted: %+v", results)
	}
}
