package discovery

import (
	"strings"
	"testing"
)

func TestTencentAndHuaweiTasksUseTheirProviderIDs(t *testing.T) {
	t.Run("tencent", func(t *testing.T) {
		uc, repo, _, _ := cloudFixture(t, "tencent.cvm")
		repo.rules[0].Name = "腾讯云"
		repo.rules[0].Option = map[string]any{"en": "tencentcloud"}
		repo.targets[0].Attributes = map[string]any{"InstanceId": "hostname", "InstanceName": "name"}
		repo.targets[0].ExtraOption = map[string]any{
			"category": "云服务器 CVM", "region": "ap-guangzhou",
			"key": "AKID", "secret": "S3CR3T",
		}
		task := oneCloudTask(t, uc, repo)
		if task.CollectKey != "tencent.cvm" || task.UniqueKey != "InstanceId" || task.Kind != "cloud" {
			t.Fatalf("task = %s/%s/%s", task.Kind, task.CollectKey, task.UniqueKey)
		}
	})

	t.Run("huawei", func(t *testing.T) {
		uc, repo, _, _ := cloudFixture(t, "huawei.ecs")
		repo.rules[0].Name = "华为云"
		repo.rules[0].Option = map[string]any{"en": "huaweicloud"}
		repo.targets[0].Attributes = map[string]any{"id": "hostname", "name": "name"}
		repo.targets[0].ExtraOption = map[string]any{
			"category": "云服务器 ECS", "region": "cn-north-1", "project_id": "project-e2e",
			"key": "AKID", "secret": "S3CR3T",
		}
		task := oneCloudTask(t, uc, repo)
		if task.CollectKey != "huawei.ecs" || task.UniqueKey != "id" {
			t.Fatalf("task = %s/%s", task.CollectKey, task.UniqueKey)
		}
		if task.Params["project_id"] != "project-e2e" {
			t.Fatalf("params = %#v", task.Params)
		}
	})
}

func TestHuaweiTaskRequiresProjectID(t *testing.T) {
	uc, repo, _, _ := cloudFixture(t, "huawei.ecs")
	repo.rules[0].Name = "华为云"
	repo.rules[0].Option = map[string]any{"en": "huaweicloud"}
	repo.targets[0].Attributes = map[string]any{"id": "hostname"}
	repo.targets[0].ExtraOption = map[string]any{
		"category": "云服务器 ECS", "region": "cn-north-1",
		"key": "AKID", "secret": "S3CR3T",
	}
	snapshot, err := uc.SyncAgentTasks(t.Context(), agentPrincipal(), AgentTaskSyncRequest{EulerID: "0xabc"})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(snapshot.Changed) != 0 || !warningContains(snapshot.Warnings, "project_id") {
		t.Fatalf("changed=%+v warnings=%+v", snapshot.Changed, snapshot.Warnings)
	}
}

func TestVSphereTaskUsesHostPasswordAndVMKey(t *testing.T) {
	uc, repo, _, private := cloudFixture(t, "vsphere.vm")
	repo.rules[0].Name = "VCenter"
	repo.rules[0].Option = map[string]any{"en": "vcenter"}
	repo.targets[0].Attributes = map[string]any{"vm": "hostname", "name": "name"}
	repo.targets[0].ExtraOption = map[string]any{
		"category": "虚拟机", "host": "vcenter.example.com",
		"account": "admin", "password": "S3CR3T",
	}
	snapshot, err := uc.SyncAgentTasks(t.Context(), agentPrincipal(), AgentTaskSyncRequest{EulerID: "0xabc"})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(snapshot.Changed) != 1 {
		t.Fatalf("changed=%+v warnings=%+v", snapshot.Changed, snapshot.Warnings)
	}
	task := snapshot.Changed[0]
	if task.CollectKey != "vsphere.vm" || task.UniqueKey != "vm" || task.Kind != "cloud" {
		t.Fatalf("task = %s/%s/%s", task.Kind, task.CollectKey, task.UniqueKey)
	}
	if task.Params["host"] != "vcenter.example.com" || task.Params["account"] != "admin" {
		t.Fatalf("params = %#v", task.Params)
	}
	secrets := openTestEnvelope(t, private, task.SecretEnvelope,
		[]byte("0xabc|"+task.TaskID+"|"+task.Revision))
	if secrets["password"] != "S3CR3T" {
		t.Fatalf("secrets = %#v", secrets)
	}
}

func TestVSphereLegacyRuleWithoutProviderKeyStillUsesVCenterAuth(t *testing.T) {
	uc, repo, _, _ := cloudFixture(t, "vsphere.vm")
	repo.rules[0].Name = "VCenter" // no option.en, as in an older rule
	repo.rules[0].Option = nil
	repo.targets[0].Attributes = map[string]any{"vm": "hostname"}
	repo.targets[0].ExtraOption = map[string]any{
		"category": "虚拟机", "collect_key": "vsphere.vm",
		"host": "vcenter.example.com", "account": "admin", "password": "S3CR3T",
	}
	task := oneCloudTask(t, uc, repo)
	if task.CollectKey != "vsphere.vm" || task.Params["host"] != "vcenter.example.com" {
		t.Fatalf("task = %s params=%#v", task.CollectKey, task.Params)
	}
}

func TestVSphereTaskWarnsOnMissingAuthentication(t *testing.T) {
	uc, repo, _, _ := cloudFixture(t, "vsphere.vm")
	repo.rules[0].Name = "VCenter"
	repo.rules[0].Option = map[string]any{"en": "vcenter"}
	repo.targets[0].Attributes = map[string]any{"vm": "hostname"}
	repo.targets[0].ExtraOption = map[string]any{
		"category": "虚拟机", "host": "vcenter.example.com", "account": "admin",
	}
	snapshot, err := uc.SyncAgentTasks(t.Context(), agentPrincipal(), AgentTaskSyncRequest{EulerID: "0xabc"})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(snapshot.Changed) != 0 || !warningContains(snapshot.Warnings, "password") {
		t.Fatalf("changed=%+v warnings=%+v", snapshot.Changed, snapshot.Warnings)
	}
}

func oneCloudTask(t *testing.T, uc *Usecase, repo *stubRepo) AgentTask {
	t.Helper()
	snapshot, err := uc.SyncAgentTasks(t.Context(), agentPrincipal(), AgentTaskSyncRequest{EulerID: "0xabc"})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(snapshot.Changed) != 1 {
		t.Fatalf("changed=%+v warnings=%+v", snapshot.Changed, snapshot.Warnings)
	}
	return snapshot.Changed[0]
}

func warningContains(warnings []string, contains string) bool {
	for _, warning := range warnings {
		if strings.Contains(warning, contains) {
			return true
		}
	}
	return false
}
