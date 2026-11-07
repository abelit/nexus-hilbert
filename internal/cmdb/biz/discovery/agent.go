package discovery

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	discoverymodel "github.com/ongridio/ongrid/internal/cmdb/model/discovery"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// AgentTokenPrefix is the visible prefix of a riemann service credential.
const AgentTokenPrefix = "cmdbagent_"

// Agent scopes. The agent middleware checks one of these per route; the
// console's Role/IsSuperuser flags are deliberately not involved.
const (
	ScopeTasksRead    = "discovery.agent.tasks.read"
	ScopeReportsWrite = "discovery.agent.reports.write"
	ScopeLogsWrite    = "discovery.agent.logs.write"
	ScopeEulersWrite  = "discovery.agent.eulers.write"
	ScopeEnroll       = "discovery.agent.enroll"
)

// AgentScopes is the full scope set a principal may hold.
func AgentScopes() []string {
	return []string{ScopeTasksRead, ScopeReportsWrite, ScopeLogsWrite, ScopeEulersWrite, ScopeEnroll}
}

// AgentPrincipalView is the authenticated service principal.
type AgentPrincipalView struct {
	ID        model.ID `json:"id"`
	PublicID  string   `json:"public_id"`
	RiemannID string   `json:"riemann_id"`
	Scopes    []string `json:"scopes"`
}

// Allows reports whether the principal holds every requested scope.
func (p AgentPrincipalView) Allows(scopes ...string) bool {
	for _, want := range scopes {
		ok := false
		for _, held := range p.Scopes {
			if held == want {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	return true
}

// AgentPrincipalCreated is returned once, when a principal is issued.
type AgentPrincipalCreated struct {
	Principal AgentPrincipalView `json:"principal"`
	Secret    string             `json:"secret"`
}

// AgentCapabilities is what a collector advertises.
type AgentCapabilities struct {
	Roles          []string `json:"roles,omitempty"`
	CollectKeys    []string `json:"collect_keys,omitempty"`
	CloudProviders []string `json:"cloud_providers,omitempty"`
	SNMPProfiles   []string `json:"snmp_profiles,omitempty"`
	BuildTags      []string `json:"build_tags,omitempty"`
	Version        string   `json:"version,omitempty"`
}

// EulerRegistration is one collector announcement.
type EulerRegistration struct {
	EulerID      string            `json:"euler_id"`
	RiemannID    string            `json:"riemann_id"`
	Hostname     string            `json:"hostname"`
	IPAddress    string            `json:"ip_address"`
	OSType       string            `json:"os_type"`
	Version      string            `json:"version"`
	Roles        []string          `json:"roles,omitempty"`
	Capabilities AgentCapabilities `json:"capabilities"`
	PublicKey    []byte            `json:"public_key,omitempty"`
	CertSerial   string            `json:"cert_serial,omitempty"`
}

// EulerView is the console/agent view of a collector.
type EulerView struct {
	ID           model.ID          `json:"id"`
	EulerID      string            `json:"euler_id"`
	RiemannID    string            `json:"riemann_id"`
	Hostname     string            `json:"hostname"`
	IPAddress    string            `json:"ip_address"`
	OSType       string            `json:"os_type"`
	Version      string            `json:"version"`
	Roles        []string          `json:"roles"`
	Capabilities AgentCapabilities `json:"capabilities"`
	Status       string            `json:"status"`
	LastSeenAt   string            `json:"last_seen_at,omitempty"`
}

// AgentTaskRevision is one entry in a collector's known-revision map.
type AgentTaskRevision struct {
	TaskID     string `json:"task_id"`
	Revision   string `json:"revision"`
	NeedSecret bool   `json:"need_secret,omitempty"`
}

// AgentTaskSyncRequest is one task poll.
type AgentTaskSyncRequest struct {
	EulerID      string              `json:"euler_id"`
	StateLost    bool                `json:"state_lost,omitempty"`
	Known        []AgentTaskRevision `json:"known,omitempty"`
	Capabilities AgentCapabilities   `json:"capabilities,omitempty"`
	SpoolDepth   int64               `json:"spool_depth,omitempty"`
	LastError    string              `json:"last_error,omitempty"`
}

// AgentTaskSchedule is the scheduling half of a task.
type AgentTaskSchedule struct {
	Cron           string `json:"cron,omitempty"`
	Timezone       string `json:"timezone,omitempty"`
	JitterSeconds  int32  `json:"jitter_seconds,omitempty"`
	TimeoutSeconds int32  `json:"timeout_seconds,omitempty"`
	MaxConcurrency int32  `json:"max_concurrency,omitempty"`
	RunOnStart     bool   `json:"run_on_start,omitempty"`
}

// AgentArtifact is a signed plugin script. It is empty in P1.
type AgentArtifact struct {
	Language   string `json:"language,omitempty"`
	SHA256     string `json:"sha256,omitempty"`
	Script     []byte `json:"script,omitempty"`
	Signature  []byte `json:"signature,omitempty"`
	SigningKey string `json:"signing_key_id,omitempty"`
}

// AgentTask is one unit of work handed to an euler.
type AgentTask struct {
	TaskID               string            `json:"task_id"`
	Kind                 string            `json:"kind"`
	Revision             string            `json:"revision"`
	TypeID               model.ID          `json:"type_id"`
	AdrID                model.ID          `json:"adr_id"`
	CollectKey           string            `json:"collect_key"`
	UniqueKey            string            `json:"unique_key"`
	Mapping              map[string]string `json:"mapping,omitempty"`
	Params               map[string]any    `json:"params,omitempty"`
	Schedule             AgentTaskSchedule `json:"schedule"`
	SecretEnvelope       []byte            `json:"secret_envelope,omitempty"`
	SecretKeyID          string            `json:"secret_key_id,omitempty"`
	SecretAlg            string            `json:"secret_alg,omitempty"`
	Artifact             *AgentArtifact    `json:"artifact,omitempty"`
	CapabilitiesRequired []string          `json:"capabilities_required,omitempty"`
	Enabled              bool              `json:"enabled"`
	ExpiresAt            string            `json:"expires_at,omitempty"`
	TraceID              string            `json:"trace_id,omitempty"`
	Signature            []byte            `json:"signature,omitempty"`
	SigningKeyID         string            `json:"signing_key_id,omitempty"`

	// SecretFingerprint participates in the revision but never travels on the
	// wire. It changes when a credential changes without exposing it.
	SecretFingerprint string `json:"-"`
}

// AgentTaskSnapshot is the answer to a task poll.
type AgentTaskSnapshot struct {
	EulerID        string      `json:"euler_id"`
	Epoch          string      `json:"snapshot_epoch"`
	Reset          bool        `json:"reset,omitempty"`
	Changed        []AgentTask `json:"changed,omitempty"`
	RemovedTaskIDs []string    `json:"removed_task_ids,omitempty"`
	Warnings       []string    `json:"warnings,omitempty"`
}

// AgentReport is one collected instance or a deletion.
type AgentReport struct {
	ReportID    string `json:"report_id"`
	TaskID      string `json:"task_id"`
	UniqueValue string `json:"unique_value,omitempty"`
	Instance    []byte `json:"instance_json,omitempty"`
	Deleted     bool   `json:"deleted,omitempty"`
	ObservedAt  string `json:"observed_at,omitempty"`
	TraceID     string `json:"trace_id,omitempty"`
}

// AgentReportResult is the per-item outcome of a report batch.
type AgentReportResult struct {
	ReportID string   `json:"report_id"`
	Status   string   `json:"status"`
	Error    string   `json:"error,omitempty"`
	CIID     model.ID `json:"ci_id,omitempty"`
}

// AgentReportRequest is one upload batch.
type AgentReportRequest struct {
	EulerID string        `json:"euler_id"`
	Reports []AgentReport `json:"reports"`
}

// AgentExecLog is one collector log line.
type AgentExecLog struct {
	LogID      string `json:"log_id"`
	TaskID     string `json:"task_id"`
	StartedAt  string `json:"started_at,omitempty"`
	FinishedAt string `json:"finished_at,omitempty"`
	Success    bool   `json:"success"`
	Stdout     string `json:"stdout,omitempty"`
	Stderr     string `json:"stderr,omitempty"`
	TraceID    string `json:"trace_id,omitempty"`
}

// AgentExecLogRequest is one log batch.
type AgentExecLogRequest struct {
	EulerID string         `json:"euler_id"`
	Logs    []AgentExecLog `json:"logs"`
}

// AgentExecLogResult is the per-item outcome of a log batch.
type AgentExecLogResult struct {
	LogID    string `json:"log_id"`
	Accepted bool   `json:"accepted"`
	Error    string `json:"error,omitempty"`
}

// AgentRepo is the persistence the agent API needs. It is separate from Repo
// so the console-side stub does not grow a second responsibility.
type AgentRepo interface {
	CreateAgentPrincipal(ctx context.Context, in AgentPrincipalWrite) (*discoverymodel.AgentPrincipal, error)
	FindAgentPrincipalByPublicID(ctx context.Context, publicID string) (*discoverymodel.AgentPrincipal, error)
	ListAgentPrincipals(ctx context.Context) ([]discoverymodel.AgentPrincipal, error)
	RevokeAgentPrincipal(ctx context.Context, id model.ID, at time.Time) error
	TouchAgentPrincipal(ctx context.Context, id model.ID, at time.Time) error

	UpsertEuler(ctx context.Context, in EulerWrite) (*discoverymodel.Euler, error)
	LoadEuler(ctx context.Context, eulerID string) (*discoverymodel.Euler, error)
	ListEulers(ctx context.Context) ([]discoverymodel.Euler, error)
	TouchEuler(ctx context.Context, eulerID string, at time.Time, capabilities string) error

	CreateEnrollmentToken(ctx context.Context, in EnrollmentTokenWrite) (*discoverymodel.EnrollmentToken, error)
	ConsumeEnrollmentToken(ctx context.Context, hash string, at time.Time) (*discoverymodel.EnrollmentToken, error)

	UpsertEulerTaskState(ctx context.Context, in EulerTaskStateWrite) error
	CreateReportReceipt(ctx context.Context, in ReportReceiptWrite) (*discoverymodel.ReportReceipt, error)
	FindReportReceipt(ctx context.Context, reportID string) (*discoverymodel.ReportReceipt, error)

	MarkPoolStale(ctx context.Context, typeID model.ID, uniqueValue string, at time.Time) error
}

// AgentPrincipalWrite is one principal creation.
type AgentPrincipalWrite struct {
	Name         string
	PublicID     string
	SecretSHA256 string
	RiemannID    string
	ScopesJSON   string
	ExpiresAt    *time.Time
	CreatedBy    model.ID
}

// EulerWrite is one collector registration upsert.
type EulerWrite struct {
	EulerID          string
	RiemannID        string
	Hostname         string
	IPAddress        string
	OSType           string
	Version          string
	RolesJSON        string
	CapabilitiesJSON string
	PublicKey        []byte
	CertSerial       string
	Status           string
}

// EnrollmentTokenWrite is one one-time enrollment token.
type EnrollmentTokenWrite struct {
	TokenSHA256 string
	EulerID     string
	LabelsJSON  string
	ExpiresAt   time.Time
	CreatedBy   model.ID
}

// EulerTaskStateWrite is one ACK record.
type EulerTaskStateWrite struct {
	EulerID  string
	TaskID   string
	Revision string
	State    string
	Error    string
	At       time.Time
}

// ReportReceiptWrite is the idempotency record for one report.
type ReportReceiptWrite struct {
	ReportID string
	TaskID   string
	Status   string
	CIID     model.ID
}

// WithAgents supplies the agent persistence.
func (u *Usecase) WithAgents(repo AgentRepo) *Usecase {
	u.agents = repo
	return u
}

// WithSigningKey enables task/artifact signatures.
func (u *Usecase) WithSigningKey(key ed25519.PrivateKey) *Usecase {
	u.signingKey = key
	u.signingKeyID = ""
	if key != nil {
		u.signingKeyID = signingKeyID(key.Public().(ed25519.PublicKey))
	}
	return u
}

// CreateAgentPrincipal issues a riemann service credential. The plaintext
// secret is returned exactly once; only its digest is stored.
func (u *Usecase) CreateAgentPrincipal(ctx context.Context, name, riemannID string, scopes []string, ttl time.Duration, actor Actor) (*AgentPrincipalCreated, error) {
	if u.agents == nil {
		return nil, errs.ErrNotWiredYet
	}
	if !actor.IsAdmin {
		return nil, fmt.Errorf("%w: an agent principal is a deployment credential", errs.ErrForbidden)
	}
	name = strings.TrimSpace(name)
	riemannID = strings.TrimSpace(riemannID)
	if name == "" || riemannID == "" {
		return nil, fmt.Errorf("%w: name and riemann_id", errs.ErrInvalid)
	}
	if len(scopes) == 0 {
		scopes = AgentScopes()
	}
	for _, scope := range scopes {
		if !containsString(AgentScopes(), scope) {
			return nil, fmt.Errorf("%w: scope %q", errs.ErrInvalid, scope)
		}
	}
	publicID, err := randomHex(16)
	if err != nil {
		return nil, err
	}
	secret, err := randomHex(32)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256([]byte(secret))
	var expires *time.Time
	if ttl > 0 {
		at := u.Now().Add(ttl)
		expires = &at
	}
	scopesJSON, _ := json.Marshal(scopes)
	row, err := u.agents.CreateAgentPrincipal(ctx, AgentPrincipalWrite{
		Name: name, PublicID: publicID, SecretSHA256: hex.EncodeToString(digest[:]),
		RiemannID: riemannID, ScopesJSON: string(scopesJSON), ExpiresAt: expires, CreatedBy: actor.UserID,
	})
	if err != nil {
		return nil, err
	}
	return &AgentPrincipalCreated{
		Principal: AgentPrincipalView{ID: row.ID, PublicID: row.PublicID, RiemannID: row.RiemannID, Scopes: scopes},
		Secret:    AgentTokenPrefix + publicID + "." + secret,
	}, nil
}

// ListAgentPrincipals returns principals without secrets.
func (u *Usecase) ListAgentPrincipals(ctx context.Context, actor Actor) ([]AgentPrincipalView, error) {
	if u.agents == nil {
		return nil, errs.ErrNotWiredYet
	}
	if !actor.IsAdmin {
		return nil, fmt.Errorf("%w: an agent principal is a deployment credential", errs.ErrForbidden)
	}
	rows, err := u.agents.ListAgentPrincipals(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]AgentPrincipalView, 0, len(rows))
	for _, row := range rows {
		out = append(out, principalView(row))
	}
	return out, nil
}

// RevokeAgentPrincipal invalidates a service credential.
func (u *Usecase) RevokeAgentPrincipal(ctx context.Context, id model.ID, actor Actor) error {
	if u.agents == nil {
		return errs.ErrNotWiredYet
	}
	if !actor.IsAdmin {
		return fmt.Errorf("%w: an agent principal is a deployment credential", errs.ErrForbidden)
	}
	return u.agents.RevokeAgentPrincipal(ctx, id, u.Now())
}

// AuthenticateAgent verifies a bearer token and returns its principal.
func (u *Usecase) AuthenticateAgent(ctx context.Context, raw string) (*AgentPrincipalView, error) {
	if u.agents == nil {
		return nil, errs.ErrNotWiredYet
	}
	raw = strings.TrimSpace(raw)
	if !strings.HasPrefix(raw, AgentTokenPrefix) {
		return nil, errs.ErrUnauthorized
	}
	parts := strings.SplitN(strings.TrimPrefix(raw, AgentTokenPrefix), ".", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil, errs.ErrUnauthorized
	}
	row, err := u.agents.FindAgentPrincipalByPublicID(ctx, parts[0])
	if err != nil {
		return nil, err
	}
	if row == nil || row.SecretSHA256 == "" {
		return nil, errs.ErrUnauthorized
	}
	digest := sha256.Sum256([]byte(parts[1]))
	want := hex.EncodeToString(digest[:])
	if subtle.ConstantTimeCompare([]byte(want), []byte(row.SecretSHA256)) != 1 {
		return nil, errs.ErrUnauthorized
	}
	now := u.Now()
	if row.RevokedAt != nil || (row.ExpiresAt != nil && !row.ExpiresAt.After(now)) {
		return nil, errs.ErrUnauthorized
	}
	_ = u.agents.TouchAgentPrincipal(ctx, row.ID, now)
	view := principalView(*row)
	return &view, nil
}

func principalView(row discoverymodel.AgentPrincipal) AgentPrincipalView {
	return AgentPrincipalView{ID: row.ID, PublicID: row.PublicID, RiemannID: row.RiemannID, Scopes: row.Scopes()}
}

// RegisterEuler records a collector's identity and capabilities.
func (u *Usecase) RegisterEuler(ctx context.Context, principal AgentPrincipalView, in EulerRegistration) (*EulerView, error) {
	if u.agents == nil {
		return nil, errs.ErrNotWiredYet
	}
	if !principal.Allows(ScopeEulersWrite) {
		return nil, fmt.Errorf("%w: %s", errs.ErrForbidden, ScopeEulersWrite)
	}
	eulerID := strings.TrimSpace(in.EulerID)
	riemannID := strings.TrimSpace(in.RiemannID)
	if eulerID == "" || riemannID == "" {
		return nil, fmt.Errorf("%w: euler_id and riemann_id", errs.ErrInvalid)
	}
	if riemannID != principal.RiemannID {
		return nil, fmt.Errorf("%w: euler belongs to another riemann", errs.ErrForbidden)
	}
	rolesJSON, _ := json.Marshal(in.Roles)
	capsJSON, _ := json.Marshal(in.Capabilities)
	row, err := u.agents.UpsertEuler(ctx, EulerWrite{
		EulerID: eulerID, RiemannID: riemannID, Hostname: in.Hostname, IPAddress: in.IPAddress,
		OSType: in.OSType, Version: in.Version, RolesJSON: string(rolesJSON),
		CapabilitiesJSON: string(capsJSON), PublicKey: in.PublicKey, CertSerial: in.CertSerial,
		Status: "active",
	})
	if err != nil {
		return nil, err
	}
	view := eulerView(*row)
	return &view, nil
}

// HeartbeatEuler refreshes liveness and capabilities.
func (u *Usecase) HeartbeatEuler(ctx context.Context, principal AgentPrincipalView, in EulerRegistration) error {
	if u.agents == nil {
		return errs.ErrNotWiredYet
	}
	if !principal.Allows(ScopeEulersWrite) {
		return fmt.Errorf("%w: %s", errs.ErrForbidden, ScopeEulersWrite)
	}
	row, err := u.agents.LoadEuler(ctx, in.EulerID)
	if err != nil {
		return err
	}
	if row == nil || row.RiemannID != principal.RiemannID {
		return fmt.Errorf("%w: euler %s", errs.ErrNotFound, in.EulerID)
	}
	capsJSON, _ := json.Marshal(in.Capabilities)
	return u.agents.TouchEuler(ctx, in.EulerID, u.Now(), string(capsJSON))
}

// ListEulers returns registered collectors for the console.
func (u *Usecase) ListEulers(ctx context.Context, actor Actor) ([]EulerView, error) {
	if u.agents == nil {
		return nil, errs.ErrNotWiredYet
	}
	if !actor.IsAdmin {
		return nil, fmt.Errorf("%w: collector inventory", errs.ErrForbidden)
	}
	rows, err := u.agents.ListEulers(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]EulerView, 0, len(rows))
	for _, row := range rows {
		out = append(out, eulerView(row))
	}
	return out, nil
}

func eulerView(row discoverymodel.Euler) EulerView {
	caps := row.Capabilities()
	view := EulerView{
		ID: row.ID, EulerID: row.EulerID, RiemannID: row.RiemannID,
		Hostname: row.Hostname, IPAddress: row.IPAddress, OSType: row.OSType,
		Version: row.Version, Roles: row.Roles(), Status: row.Status,
	}
	if row.LastSeenAt != nil {
		view.LastSeenAt = cmdbTime(*row.LastSeenAt)
	}
	if caps != nil {
		if raw, err := json.Marshal(caps); err == nil {
			_ = json.Unmarshal(raw, &view.Capabilities)
		}
	}
	return view
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// canonicalTaskRevision hashes the logical task configuration. It excludes the
// euler so the same target yields the same revision on any collector.
func canonicalTaskRevision(task AgentTask) string {
	payload := struct {
		Compiler     string            `json:"compiler"`
		TaskID       string            `json:"task_id"`
		Kind         string            `json:"kind"`
		TypeID       model.ID          `json:"type_id"`
		AdrID        model.ID          `json:"adr_id"`
		CollectKey   string            `json:"collect_key"`
		UniqueKey    string            `json:"unique_key"`
		Mapping      map[string]string `json:"mapping"`
		Params       map[string]any    `json:"params"`
		Schedule     AgentTaskSchedule `json:"schedule"`
		Enabled      bool              `json:"enabled"`
		ArtifactHash string            `json:"artifact_sha256,omitempty"`
		SecretHash   string            `json:"secret_hash,omitempty"`
	}{
		Compiler: "agent-task-v1", TaskID: task.TaskID, Kind: task.Kind, TypeID: task.TypeID,
		AdrID: task.AdrID, CollectKey: task.CollectKey, UniqueKey: task.UniqueKey,
		Mapping: task.Mapping, Params: task.Params, Schedule: task.Schedule, Enabled: task.Enabled,
		SecretHash: task.SecretFingerprint,
	}
	if task.Artifact != nil {
		payload.ArtifactHash = task.Artifact.SHA256
	}
	raw, _ := json.Marshal(payload)
	sum := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func snapshotEpoch(tasks []AgentTask) string {
	lines := make([]string, 0, len(tasks))
	for _, task := range tasks {
		lines = append(lines, task.TaskID+":"+task.Revision)
	}
	sort.Strings(lines)
	sum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return "sha256:" + hex.EncodeToString(sum[:])
}
