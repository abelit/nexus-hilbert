package discovery

import (
	"crypto/ecdh"
	"crypto/rand"
	"strings"
	"testing"

	discoverymodel "github.com/ongridio/ongrid/internal/cmdb/model/discovery"
)

func cloudFixture(t *testing.T, collectKey string) (*Usecase, *stubRepo, *stubAgentRepo, *ecdh.PrivateKey) {
	t.Helper()
	uc, repo, agents, _ := agentFixture(t)
	curve := ecdh.X25519()
	private, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	euler := agents.eulers["0xabc"]
	euler.PublicKey = private.PublicKey().Bytes()
	agents.eulers["0xabc"] = euler

	rule := discoverymodel.Rule{Name: "阿里云", Type: strp("http")}
	rule.ID = 1
	rule.Option = map[string]any{"en": "aliyun"}
	repo.rules[0] = rule
	repo.targets[0].Attributes = map[string]any{"InstanceId": "hostname", "InstanceName": "name"}
	repo.targets[0].ExtraOption = map[string]any{
		"region":   "cn-hangzhou",
		"key":      "AKID",
		"secret":   "S3CR3T",
		"category": "云服务器 ECS",
	}
	if collectKey != "" {
		// The target carries the derived collector; rule.Option deliberately
		// stays empty so this fixture proves the compiler reads the target.
		repo.targets[0].ExtraOption["collect_key"] = collectKey
	}
	return uc, repo, agents, private
}

func TestCloudTaskCarriesNativeCollectorAndSealedCredentials(t *testing.T) {
	uc, _, _, private := cloudFixture(t, "ali.ecs")
	snapshot, err := uc.SyncAgentTasks(t.Context(), agentPrincipal(), AgentTaskSyncRequest{EulerID: "0xabc"})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(snapshot.Changed) != 1 {
		t.Fatalf("changed = %+v; warnings = %+v", snapshot.Changed, snapshot.Warnings)
	}
	task := snapshot.Changed[0]
	if task.Kind != "cloud" || task.CollectKey != "ali.ecs" {
		t.Fatalf("kind/collect_key = %s/%s", task.Kind, task.CollectKey)
	}
	if task.UniqueKey != "InstanceId" {
		t.Fatalf("unique key = %q", task.UniqueKey)
	}
	if len(task.CapabilitiesRequired) != 1 || task.CapabilitiesRequired[0] != "cloud" {
		t.Fatalf("capabilities = %+v", task.CapabilitiesRequired)
	}
	if task.Params["region"] != "cn-hangzhou" || task.Params["category"] != "云服务器 ECS" {
		t.Fatalf("non-secret params = %#v", task.Params)
	}
	for _, key := range []string{"key", "secret"} {
		if _, leaked := task.Params[key]; leaked {
			t.Fatalf("%s leaked into params: %#v", key, task.Params)
		}
	}
	aad := []byte("0xabc|" + task.TaskID + "|" + task.Revision)
	secrets := openTestEnvelope(t, private, task.SecretEnvelope, aad)
	if secrets["key"] != "AKID" || secrets["secret"] != "S3CR3T" {
		t.Fatalf("secrets = %#v", secrets)
	}
}

func TestCloudTaskFallsBackToTheProviderID(t *testing.T) {
	uc, repo, _, _ := cloudFixture(t, "aws.ec2")
	repo.rules[0].Name = "AWS"
	repo.rules[0].Option = map[string]any{"en": "aws"}
	repo.targets[0].ExtraOption["category"] = "云服务器 EC2"
	// The model's unique attribute is not part of this mapping; the task must
	// still be deterministic through the provider's ID field.
	repo.targets[0].Attributes = map[string]any{"InstanceName": "name"}

	snapshot, err := uc.SyncAgentTasks(t.Context(), agentPrincipal(), AgentTaskSyncRequest{EulerID: "0xabc"})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(snapshot.Changed) != 1 {
		t.Fatalf("changed = %+v; warnings = %+v", snapshot.Changed, snapshot.Warnings)
	}
	if snapshot.Changed[0].UniqueKey != "instanceId" {
		t.Fatalf("unique key = %q", snapshot.Changed[0].UniqueKey)
	}
}

func TestCloudAccountCannotOverrideTheCollectorOrCategory(t *testing.T) {
	uc, repo, _, _ := cloudFixture(t, "ali.ecs")
	repo.accounts = []discoverymodel.Account{{
		Config: map[string]any{
			"collect_key": "aws.ec2",
			"provider":    "aws",
			"category":    "云服务器 EC2",
			"region":      "us-east-1",
			"endpoint":    "http://evil.example",
			"insecure":    true,
			"key":         "AKID",
			"secret":      "S3CR3T",
		},
	}}
	repo.accounts[0].ID = 9
	repo.accounts[0].AdrID = idp(1)
	repo.targets[0].ExtraOption = map[string]any{
		"_reference":  float64(9),
		"collect_key": "ali.ecs",
		"category":    "云服务器 ECS",
		"endpoint":    "http://good.example",
		"insecure":    false,
	}

	snapshot, err := uc.SyncAgentTasks(t.Context(), agentPrincipal(), AgentTaskSyncRequest{EulerID: "0xabc"})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(snapshot.Changed) != 1 {
		t.Fatalf("changed = %+v; warnings = %+v", snapshot.Changed, snapshot.Warnings)
	}
	task := snapshot.Changed[0]
	if task.CollectKey != "ali.ecs" {
		t.Fatalf("an account redirected the collector: %q", task.CollectKey)
	}
	if task.Params["category"] != "云服务器 ECS" || task.Params["region"] != "us-east-1" ||
		task.Params["endpoint"] != "http://good.example" || task.Params["insecure"] != false {
		t.Fatalf("params = %#v", task.Params)
	}
	for _, key := range []string{"collect_key", "provider"} {
		if _, leaked := task.Params[key]; leaked {
			t.Fatalf("account-controlled %s leaked into params: %#v", key, task.Params)
		}
	}
}

func TestCloudUniqueKeyIsDeterministicWhenTwoFieldsMapTheModelKey(t *testing.T) {
	uc, repo, _, _ := cloudFixture(t, "ali.ecs")
	repo.targets[0].Attributes = map[string]any{
		"InstanceName": "hostname",
		"InstanceId":   "hostname",
	}
	snapshot, err := uc.SyncAgentTasks(t.Context(), agentPrincipal(), AgentTaskSyncRequest{EulerID: "0xabc"})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(snapshot.Changed) != 1 || snapshot.Changed[0].UniqueKey != "InstanceId" {
		t.Fatalf("unique key = %+v", snapshot.Changed)
	}
}

func TestCloudTaskWarnsOnStaleRouting(t *testing.T) {
	uc, repo, _, _ := cloudFixture(t, "ali.ecs")
	repo.targets[0].ExtraOption["category"] = "云服务器 Disk"
	snapshot, err := uc.SyncAgentTasks(t.Context(), agentPrincipal(), AgentTaskSyncRequest{EulerID: "0xabc"})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(snapshot.Changed) != 0 {
		t.Fatalf("stale routing was dispatched: %+v", snapshot.Changed)
	}
	found := false
	for _, warning := range snapshot.Warnings {
		if strings.Contains(warning, `resolves to collector "ali.ecs_disk"`) {
			found = true
		}
	}
	if !found {
		t.Fatalf("warnings = %+v", snapshot.Warnings)
	}

	repo.targets[0].ExtraOption["category"] = "云服务器 ECS"
	repo.targets[0].ExtraOption["provider"] = "aws"
	snapshot, err = uc.SyncAgentTasks(t.Context(), agentPrincipal(), AgentTaskSyncRequest{EulerID: "0xabc"})
	if err != nil {
		t.Fatalf("second sync: %v", err)
	}
	found = false
	for _, warning := range snapshot.Warnings {
		if strings.Contains(warning, `target provider "aws"`) {
			found = true
		}
	}
	if !found {
		t.Fatalf("warnings = %+v", snapshot.Warnings)
	}
}

func TestCloudTaskSkipsACollectorThatDoesNotAdvertiseTheKey(t *testing.T) {
	uc, _, agents, _ := cloudFixture(t, "ali.ecs")
	euler := agents.eulers["0xabc"]
	euler.CapabilitiesJSON = `{"collect_keys":["server","snmp"]}`
	agents.eulers["0xabc"] = euler

	snapshot, err := uc.SyncAgentTasks(t.Context(), agentPrincipal(), AgentTaskSyncRequest{EulerID: "0xabc"})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(snapshot.Changed) != 0 {
		t.Fatalf("unadvertised collector received a task: %+v", snapshot.Changed)
	}
	found := false
	for _, warning := range snapshot.Warnings {
		if strings.Contains(warning, "does not advertise ali.ecs") {
			found = true
		}
	}
	if !found {
		t.Fatalf("warnings = %+v", snapshot.Warnings)
	}
}

func TestCloudTaskWarnsInsteadOfSendingAnUnusableTask(t *testing.T) {
	cases := []struct {
		name       string
		collect    string
		extra      map[string]any
		attributes map[string]any
		warning    string
	}{
		{
			name:    "no resource kind",
			collect: "",
			extra: map[string]any{
				"region": "cn-hangzhou", "key": "AKID", "secret": "S3CR3T",
			},
			warning: "target 10: cloud target has no resource kind",
		},
		{
			name:    "unsupported collector",
			collect: "ali.oss",
			extra: map[string]any{
				"region": "cn-hangzhou", "key": "AKID", "secret": "S3CR3T",
			},
			warning: `target 10: cloud collector "ali.oss" is not implemented`,
		},
		{
			name:    "no region",
			collect: "ali.ecs",
			extra: map[string]any{
				"key": "AKID", "secret": "S3CR3T",
			},
			warning: "target 10: cloud target has no region",
		},
		{
			name:    "no access key",
			collect: "ali.ecs",
			extra: map[string]any{
				"region": "cn-hangzhou",
			},
			warning: "target 10: cloud target has no access key",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			uc, repo, _, _ := cloudFixture(t, tc.collect)
			repo.targets[0].ExtraOption = tc.extra
			if tc.collect != "" {
				repo.targets[0].ExtraOption["collect_key"] = tc.collect
			}
			if tc.attributes != nil {
				repo.targets[0].Attributes = tc.attributes
			}
			snapshot, err := uc.SyncAgentTasks(t.Context(), agentPrincipal(), AgentTaskSyncRequest{EulerID: "0xabc"})
			if err != nil {
				t.Fatalf("sync: %v", err)
			}
			if len(snapshot.Changed) != 0 {
				t.Fatalf("unusable task was sent: %+v", snapshot.Changed)
			}
			found := false
			for _, warning := range snapshot.Warnings {
				if warning == tc.warning {
					found = true
				}
			}
			if !found {
				t.Fatalf("warnings = %+v, want %q", snapshot.Warnings, tc.warning)
			}
		})
	}
}
