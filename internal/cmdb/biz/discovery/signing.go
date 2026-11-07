package discovery

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
)

// Task signing is the integrity half of the control plane.
//
// THE TRANSPORT IS ALREADY AUTHENTICATED, but riemann is a relay: a compromised
// relay could rewrite a task between CMDB and euler. The signature binds the
// task's fields, the revision and the secret envelope, so euler can reject a
// task the CMDB did not mint even if it arrived over an authenticated stream.

const (
	taskSigningVersion     = "task-sign-v1"
	artifactSigningVersion = "artifact-sign-v1"
)

type taskSigningSchedule struct {
	Cron           string `json:"cron"`
	Timezone       string `json:"timezone"`
	JitterSeconds  int32  `json:"jitter_seconds"`
	TimeoutSeconds int32  `json:"timeout_seconds"`
	MaxConcurrency int32  `json:"max_concurrency"`
	RunOnStart     bool   `json:"run_on_start"`
}

type taskSigningPayload struct {
	Version      string              `json:"version"`
	TaskID       string              `json:"task_id"`
	Revision     string              `json:"revision"`
	Kind         string              `json:"kind"`
	TypeID       int32               `json:"type_id"`
	AdrID        int32               `json:"adr_id"`
	CollectKey   string              `json:"collect_key"`
	UniqueKey    string              `json:"unique_key"`
	Mapping      map[string]string   `json:"mapping"`
	Params       map[string]any      `json:"params"`
	Schedule     taskSigningSchedule `json:"schedule"`
	ArtifactSHA  string              `json:"artifact_sha256"`
	Capabilities []string            `json:"capabilities"`
	Enabled      bool                `json:"enabled"`
	EnvelopeSHA  string              `json:"secret_envelope_sha256"`
	SecretKeyID  string              `json:"secret_key_id"`
	SecretAlg    string              `json:"secret_alg"`
}

type artifactSigningPayload struct {
	Version    string `json:"version"`
	TaskID     string `json:"task_id"`
	Revision   string `json:"revision"`
	CollectKey string `json:"collect_key"`
	Language   string `json:"language"`
	SHA256     string `json:"sha256"`
}

// SigningKeyFromEnv derives the CMDB's task-signing key.
//
// A DEDICATED KEY IS OPTIONAL, NOT REQUIRED. When
// ONGRID_CMDB_DISCOVERY_SIGNING_KEY is set it is a base64 32-byte seed; when it
// is absent the key is derived from the deployment's secret material, so a
// restart keeps the same trust anchor instead of silently changing it.
func SigningKeyFromEnv() (ed25519.PrivateKey, string, error) {
	if raw := strings.TrimSpace(os.Getenv("ONGRID_CMDB_DISCOVERY_SIGNING_KEY")); raw != "" {
		seed, err := base64.StdEncoding.DecodeString(raw)
		if err != nil {
			return nil, "", fmt.Errorf("ONGRID_CMDB_DISCOVERY_SIGNING_KEY is not valid base64: %w", err)
		}
		if len(seed) != ed25519.SeedSize {
			return nil, "", fmt.Errorf("ONGRID_CMDB_DISCOVERY_SIGNING_KEY must decode to %d bytes, got %d", ed25519.SeedSize, len(seed))
		}
		key := ed25519.NewKeyFromSeed(seed)
		return key, signingKeyID(key.Public().(ed25519.PublicKey)), nil
	}
	secret := strings.TrimSpace(os.Getenv("ONGRID_SECRET_KEY"))
	if secret == "" {
		secret = strings.TrimSpace(os.Getenv("ONGRID_JWT_SECRET"))
	}
	if secret == "" {
		return nil, "", nil
	}
	seed := sha256.Sum256([]byte("ongrid-discovery-task-signing-v1:" + secret))
	key := ed25519.NewKeyFromSeed(seed[:])
	return key, signingKeyID(key.Public().(ed25519.PublicKey)), nil
}

func signingKeyID(public ed25519.PublicKey) string {
	sum := sha256.Sum256(public)
	return "ed25519:" + hex.EncodeToString(sum[:8])
}

func canonicalTaskSigningPayload(task AgentTask) []byte {
	schedule := taskSigningSchedule{
		Cron: task.Schedule.Cron, Timezone: task.Schedule.Timezone,
		JitterSeconds: task.Schedule.JitterSeconds, TimeoutSeconds: task.Schedule.TimeoutSeconds,
		MaxConcurrency: task.Schedule.MaxConcurrency, RunOnStart: task.Schedule.RunOnStart,
	}
	mapping := make(map[string]string, len(task.Mapping))
	for key, value := range task.Mapping {
		mapping[key] = value
	}
	params := make(map[string]any, len(task.Params))
	for key, value := range task.Params {
		params[key] = normalizeSigningValue(value)
	}
	capabilities := append([]string(nil), task.CapabilitiesRequired...)
	sort.Strings(capabilities)
	if capabilities == nil {
		capabilities = []string{}
	}
	artifactSHA := ""
	if task.Artifact != nil {
		artifactSHA = task.Artifact.SHA256
	}
	envelopeSHA := ""
	if len(task.SecretEnvelope) > 0 {
		sum := sha256.Sum256(task.SecretEnvelope)
		envelopeSHA = hex.EncodeToString(sum[:])
	}
	payload := taskSigningPayload{
		Version: taskSigningVersion, TaskID: task.TaskID, Revision: task.Revision,
		Kind: task.Kind, TypeID: int32(task.TypeID), AdrID: int32(task.AdrID),
		CollectKey: task.CollectKey, UniqueKey: task.UniqueKey,
		Mapping: mapping, Params: params, Schedule: schedule,
		ArtifactSHA: artifactSHA, Capabilities: capabilities, Enabled: task.Enabled,
		EnvelopeSHA: envelopeSHA, SecretKeyID: task.SecretKeyID, SecretAlg: task.SecretAlg,
	}
	raw, _ := json.Marshal(payload)
	return raw
}

func canonicalArtifactSigningPayload(task AgentTask) []byte {
	if task.Artifact == nil {
		return nil
	}
	raw, _ := json.Marshal(artifactSigningPayload{
		Version: artifactSigningVersion, TaskID: task.TaskID, Revision: task.Revision,
		CollectKey: task.CollectKey, Language: task.Artifact.Language, SHA256: task.Artifact.SHA256,
	})
	return raw
}

// normalizeSigningValue makes the JSON representation independent of which
// numeric Go type produced a parameter. euler's protobuf Struct gives float64
// for every number; the CMDB side may have an int from a constructed map.
func normalizeSigningValue(value any) any {
	switch typed := value.(type) {
	case nil, bool, string:
		return typed
	case json.Number:
		number, err := typed.Float64()
		if err != nil {
			return typed.String()
		}
		return number
	case float32:
		return float64(typed)
	case float64:
		return typed
	case int:
		return float64(typed)
	case int8:
		return float64(typed)
	case int16:
		return float64(typed)
	case int32:
		return float64(typed)
	case int64:
		return float64(typed)
	case uint:
		return float64(typed)
	case uint8:
		return float64(typed)
	case uint16:
		return float64(typed)
	case uint32:
		return float64(typed)
	case uint64:
		return float64(typed)
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = normalizeSigningValue(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = normalizeSigningValue(item)
		}
		return out
	default:
		return fmt.Sprint(typed)
	}
}

// signTask attaches a task signature and, when present, an artifact signature.
func (u *Usecase) signTask(task *AgentTask) error {
	if u.signingKey == nil {
		return nil
	}
	if task.Artifact != nil {
		task.Artifact.Signature = ed25519.Sign(u.signingKey, canonicalArtifactSigningPayload(*task))
		task.Artifact.SigningKey = u.signingKeyID
	}
	task.Signature = ed25519.Sign(u.signingKey, canonicalTaskSigningPayload(*task))
	task.SigningKeyID = u.signingKeyID
	return nil
}

func (u *Usecase) TaskSigningKey() ([]byte, string) {
	if u.signingKey == nil {
		return nil, ""
	}
	public := u.signingKey.Public().(ed25519.PublicKey)
	return append([]byte(nil), public...), u.signingKeyID
}
