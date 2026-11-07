package discovery

import (
	"encoding/json"
	"time"

	cmdbmodel "github.com/ongridio/ongrid/internal/cmdb/model"
)

// The machine side of auto-discovery.
//
// THESE ARE NOT CONSOLE ROWS. A principal is a riemann service credential, an
// euler is a registered collector, and the task/receipt tables exist so a
// report can be retried without duplicating a sighting. The console's existing
// rule/target/pool DTOs and columns are deliberately untouched; the agent API
// translates at its own boundary.

// AgentPrincipal is one riemann service credential (c_ad_agent_principals).
//
// THE SECRET IS NEVER STORED IN PLAINTEXT. It is a 256-bit random bearer
// token; only its SHA-256 digest is kept. A slow password hash (argon2id) is
// the wrong tool for a high-entropy token and would add latency to every
// batch.
type AgentPrincipal struct {
	cmdbmodel.Base

	Name string `gorm:"column:name;size:128"`

	// PublicID is the lookup key embedded in the token.
	PublicID string `gorm:"column:public_id;size:64;uniqueIndex:idx_c_ad_agent_principals_public_id"`

	// SecretSHA256 is the hex-encoded SHA-256 of the bearer secret.
	SecretSHA256 string `gorm:"column:secret_sha256;size:64"`

	// RiemannID scopes the principal to one control-plane site.
	RiemannID string `gorm:"column:riemann_id;size:64;index:idx_c_ad_agent_principals_riemann_id"`

	// ScopesJSON is a JSON array of scope strings.
	ScopesJSON string `gorm:"column:scopes_json;type:text"`

	ExpiresAt  *time.Time    `gorm:"column:expires_at"`
	RevokedAt  *time.Time    `gorm:"column:revoked_at"`
	LastUsedAt *time.Time    `gorm:"column:last_used_at"`
	CreatedBy  *cmdbmodel.ID `gorm:"column:created_by"`
}

func (AgentPrincipal) TableName() string { return "c_ad_agent_principals" }

// Scopes decodes the stored scope list. A malformed list yields no scopes, so
// a corrupted row fails closed.
func (p AgentPrincipal) Scopes() []string {
	if p.ScopesJSON == "" {
		return nil
	}
	var out []string
	if err := json.Unmarshal([]byte(p.ScopesJSON), &out); err != nil {
		return nil
	}
	return out
}

// Euler is one registered collector (c_ad_eulers).
//
// IT IS THE LAST-KNOWN INVENTORY, not the live connection state. Riemann owns
// the live roster; this row lets the console show an euler and lets task
// compilation know its public key.
type Euler struct {
	cmdbmodel.Base

	// EulerID is the collector's persisted identity, e.g. 0x + 32 hex.
	EulerID string `gorm:"column:euler_id;size:64;uniqueIndex:idx_c_ad_eulers_euler_id"`

	// RiemannID is the control-plane site that registered it.
	RiemannID string `gorm:"column:riemann_id;size:64;index:idx_c_ad_eulers_riemann_id"`

	Hostname  string `gorm:"column:hostname;size:255"`
	IPAddress string `gorm:"column:ip_address;size:64"`
	OSType    string `gorm:"column:os_type;size:64"`
	Version   string `gorm:"column:version;size:64"`

	RolesJSON        string `gorm:"column:roles_json;type:text"`
	CapabilitiesJSON string `gorm:"column:capabilities_json;type:text"`

	// PublicKey is the X25519 public key used for secret envelopes.
	PublicKey []byte `gorm:"column:public_key;type:blob"`

	CertSerial string `gorm:"column:cert_serial;size:128"`

	// Status is active or revoked.
	Status string `gorm:"column:status;size:32;index:idx_c_ad_eulers_status"`

	LastSeenAt *time.Time `gorm:"column:last_seen_at"`
}

func (Euler) TableName() string { return "c_ad_eulers" }

// Roles decodes the stored role list.
func (e Euler) Roles() []string {
	if e.RolesJSON == "" {
		return nil
	}
	var out []string
	if err := json.Unmarshal([]byte(e.RolesJSON), &out); err != nil {
		return nil
	}
	return out
}

// Capabilities decodes the stored capability map.
func (e Euler) Capabilities() map[string]any {
	if e.CapabilitiesJSON == "" {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(e.CapabilitiesJSON), &out); err != nil {
		return nil
	}
	return out
}

// EnrollmentToken is a one-time token a new euler uses to obtain a certificate
// (c_ad_enrollment_tokens). Only its digest is stored.
type EnrollmentToken struct {
	cmdbmodel.Base

	TokenSHA256 string `gorm:"column:token_sha256;size:64;uniqueIndex:idx_c_ad_enrollment_tokens_hash"`

	// EulerID optionally binds the token to one collector identity.
	EulerID *string `gorm:"column:euler_id;size:64"`

	LabelsJSON string `gorm:"column:labels_json;type:text"`

	ExpiresAt time.Time     `gorm:"column:expires_at;index:idx_c_ad_enrollment_tokens_expires_at"`
	UsedAt    *time.Time    `gorm:"column:used_at"`
	CreatedBy *cmdbmodel.ID `gorm:"column:created_by"`
}

func (EnrollmentToken) TableName() string { return "c_ad_enrollment_tokens" }

// EulerTaskState is the last ACK a collector sent for one task
// (c_ad_euler_task_states). The live known-revision map lives in euler; this is
// for audit and for a console "why has this task not applied" view.
type EulerTaskState struct {
	cmdbmodel.Base

	EulerID string `gorm:"column:euler_id;size:64;index:idx_c_ad_euler_task_states_euler_task,priority:1"`
	TaskID  string `gorm:"column:task_id;size:64;index:idx_c_ad_euler_task_states_euler_task,priority:2"`

	Revision  string     `gorm:"column:revision;size:128"`
	State     string     `gorm:"column:state;size:32"`
	LastError string     `gorm:"column:last_error;type:text"`
	LastAckAt *time.Time `gorm:"column:last_ack_at"`
}

func (EulerTaskState) TableName() string { return "c_ad_euler_task_states" }

// ReportReceipt is the idempotency record for one uploaded report
// (c_ad_report_receipts). A replay returns the stored status instead of
// applying the report twice.
type ReportReceipt struct {
	cmdbmodel.Base

	ReportID string        `gorm:"column:report_id;size:64;uniqueIndex:idx_c_ad_report_receipts_report_id"`
	TaskID   string        `gorm:"column:task_id;size:64;index:idx_c_ad_report_receipts_task_id"`
	Status   string        `gorm:"column:status;size:32"`
	CIID     *cmdbmodel.ID `gorm:"column:ci_id"`
}

func (ReportReceipt) TableName() string { return "c_ad_report_receipts" }
