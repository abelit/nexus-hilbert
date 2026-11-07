package discovery

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"

	discoverymodel "github.com/ongridio/ongrid/internal/cmdb/model/discovery"
)

func TestSNMPTaskSealsNodeCommunitiesAndUsesTheSNMPCollector(t *testing.T) {
	uc, repo, agents, _ := agentFixture(t)
	curve := ecdh.X25519()
	private, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	euler := agents.eulers["0xabc"]
	euler.PublicKey = private.PublicKey().Bytes()
	agents.eulers["0xabc"] = euler

	repo.rules[0] = discoverymodel.Rule{Name: "交换机", Type: strp("snmp")}
	repo.rules[0].ID = 1
	repo.targets[0].Attributes = map[string]any{"manager_ip": "ip", "sn": "sn"}
	repo.targets[0].ExtraOption = map[string]any{
		"nodes": []any{
			map[string]any{"ip": "10.0.0.1", "version": "v2c", "community": "public"},
			map[string]any{"ip": "10.0.0.2", "version": "v2c", "community": "private"},
		},
		"version": "v2c", "timeout": 3.0, "retries": 1,
	}

	snapshot, err := uc.SyncAgentTasks(t.Context(), agentPrincipal(), AgentTaskSyncRequest{EulerID: "0xabc"})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(snapshot.Changed) != 1 {
		t.Fatalf("changed = %+v; warnings = %+v", snapshot.Changed, snapshot.Warnings)
	}
	task := snapshot.Changed[0]
	if task.Kind != discoverymodel.TypeSNMP || task.CollectKey != "snmp" {
		t.Fatalf("kind/collect_key = %s/%s", task.Kind, task.CollectKey)
	}
	if task.UniqueKey != "manager_ip" {
		t.Fatalf("unique key = %q; the SNMP fallback was not applied", task.UniqueKey)
	}
	if len(task.CapabilitiesRequired) != 1 || task.CapabilitiesRequired[0] != "snmp" {
		t.Fatalf("capabilities = %+v", task.CapabilitiesRequired)
	}

	nodes, ok := task.Params["nodes"].([]any)
	if !ok || len(nodes) != 2 {
		t.Fatalf("nodes = %#v", task.Params["nodes"])
	}
	for _, raw := range nodes {
		node, _ := raw.(map[string]any)
		if _, leaked := node["community"]; leaked {
			t.Fatalf("node community leaked into params: %#v", node)
		}
		if _, leaked := node["has_community"]; leaked {
			t.Fatalf("read flag leaked into params: %#v", node)
		}
	}
	if task.Params["community"] != nil {
		t.Fatalf("top-level community leaked into params: %#v", task.Params)
	}

	aad := []byte(euler.EulerID + "|" + task.TaskID + "|" + task.Revision)
	secrets := openTestEnvelope(t, private, task.SecretEnvelope, aad)
	if secrets["node_communities"] != `{"10.0.0.1":"public","10.0.0.2":"private"}` {
		t.Fatalf("node communities = %q", secrets["node_communities"])
	}

	// A community edit must reach the collector even though the sanitized
	// params are unchanged; the fingerprint is what makes the revision move.
	nodes[0].(map[string]any)["community"] = "rotated"
	repo.targets[0].ExtraOption["nodes"] = nodes
	second, err := uc.SyncAgentTasks(t.Context(), agentPrincipal(), AgentTaskSyncRequest{
		EulerID: "0xabc",
		Known:   []AgentTaskRevision{{TaskID: task.TaskID, Revision: task.Revision}},
	})
	if err != nil {
		t.Fatalf("second sync: %v", err)
	}
	if len(second.Changed) != 1 || second.Changed[0].Revision == task.Revision {
		t.Fatalf("a community edit did not change the revision: %+v", second.Changed)
	}
}

func TestSNMPTaskWithoutCommunityIsAWarningNotAFailure(t *testing.T) {
	uc, repo, _, _ := agentFixture(t)
	repo.rules[0] = discoverymodel.Rule{Name: "交换机", Type: strp("snmp")}
	repo.rules[0].ID = 1
	repo.targets[0].Attributes = map[string]any{"manager_ip": "ip"}
	repo.targets[0].ExtraOption = map[string]any{
		"nodes": []any{map[string]any{"ip": "10.0.0.1", "version": "v2c"}},
	}

	snapshot, err := uc.SyncAgentTasks(t.Context(), agentPrincipal(), AgentTaskSyncRequest{EulerID: "0xabc"})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(snapshot.Changed) != 0 {
		t.Fatalf("an SNMP target without a community was sent: %+v", snapshot.Changed)
	}
	found := false
	for _, warning := range snapshot.Warnings {
		if warning == "target 10: SNMP target has no community" {
			found = true
		}
	}
	if !found {
		t.Fatalf("warnings = %+v", snapshot.Warnings)
	}
}

func TestSNMPCIDRWithoutNodesNamesTheUnimplementedFeature(t *testing.T) {
	uc, repo, _, _ := agentFixture(t)
	repo.rules[0] = discoverymodel.Rule{Name: "交换机", Type: strp("snmp")}
	repo.rules[0].ID = 1
	repo.targets[0].Attributes = map[string]any{"manager_ip": "sn"}
	repo.targets[0].ExtraOption = map[string]any{
		"community": "public",
		"cidr":      []any{"10.0.0.0/24"},
	}

	snapshot, err := uc.SyncAgentTasks(t.Context(), agentPrincipal(), AgentTaskSyncRequest{EulerID: "0xabc"})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(snapshot.Changed) != 0 {
		t.Fatalf("a CIDR-only SNMP target was sent: %+v", snapshot.Changed)
	}
	found := false
	for _, warning := range snapshot.Warnings {
		if warning == "target 10: SNMP CIDR discovery is not implemented; add nodes explicitly" {
			found = true
		}
	}
	if !found {
		t.Fatalf("warnings = %+v", snapshot.Warnings)
	}
}

// openTestEnvelope mirrors the euler side of the envelope so the test proves
// what the collector can actually decrypt, not only that bytes were produced.
func openTestEnvelope(t *testing.T, private *ecdh.PrivateKey, envelope, aad []byte) map[string]string {
	t.Helper()
	var wire struct {
		Alg             string `json:"alg"`
		EphemeralPublic string `json:"ephemeral_public"`
		Salt            string `json:"salt"`
		Nonce           string `json:"nonce"`
		Ciphertext      string `json:"ciphertext"`
	}
	if err := json.Unmarshal(envelope, &wire); err != nil {
		t.Fatal(err)
	}
	if wire.Alg != secretEnvelopeAlg {
		t.Fatalf("alg = %q", wire.Alg)
	}
	rawPublic, err := base64.StdEncoding.DecodeString(wire.EphemeralPublic)
	if err != nil {
		t.Fatal(err)
	}
	peer, err := ecdh.X25519().NewPublicKey(rawPublic)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := private.ECDH(peer)
	if err != nil {
		t.Fatal(err)
	}
	salt, err := base64.StdEncoding.DecodeString(wire.Salt)
	if err != nil {
		t.Fatal(err)
	}
	key, err := hkdf.Key(sha256.New, shared, salt, "nexus-discovery-secret-v1", 32)
	if err != nil {
		t.Fatal(err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce, err := base64.StdEncoding.DecodeString(wire.Nonce)
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, err := base64.StdEncoding.DecodeString(wire.Ciphertext)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := gcm.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		t.Fatalf("envelope did not open: %v", err)
	}
	var secrets map[string]string
	if err := json.Unmarshal(plain, &secrets); err != nil {
		t.Fatal(err)
	}
	return secrets
}
