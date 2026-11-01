package ci

import (
	"testing"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
)

func TestParseTriggerRuleReadsADataWebhook(t *testing.T) {
	rule, err := parseTriggerRule(map[string]any{
		"name":     "notify ops",
		"enable":   true,
		"action":   "2",
		"attr_ids": []any{float64(11), "12"},
		"filter":   "status:down",
		"webhooks": map[string]any{
			"method":     "POST",
			"url":        "https://example.test/hooks/cmdb",
			"parameters": map[string]any{"env": "prod"},
			"headers":    map[string]any{"X-Source": "cmdb"},
			"body":       `{"host":"{{ hostname }}"}`,
			"auth_type":  "Bearer",
		},
	})
	if err != nil {
		t.Fatalf("parseTriggerRule: %v", err)
	}
	if rule.Name != "notify ops" || rule.Action != model.OperateUpdate || !rule.Enabled {
		t.Fatalf("rule = %+v", rule)
	}
	if len(rule.AttrIDs) != 2 || rule.AttrIDs[0] != 11 || rule.AttrIDs[1] != 12 {
		t.Fatalf("attr ids = %v", rule.AttrIDs)
	}
	if rule.Filter != "status:down" {
		t.Fatalf("filter = %q", rule.Filter)
	}
	if rule.Webhook == nil {
		t.Fatal("webhook = nil")
	}
	if rule.Webhook.Method != "POST" || rule.Webhook.URL != "https://example.test/hooks/cmdb" {
		t.Fatalf("webhook = %+v", rule.Webhook)
	}
	if rule.Webhook.Parameters["env"] != "prod" || rule.Webhook.Headers["X-Source"] != "cmdb" {
		t.Fatalf("parameters/headers = %+v / %+v", rule.Webhook.Parameters, rule.Webhook.Headers)
	}
	if rule.Webhook.AuthType != "Bearer" {
		t.Fatalf("auth type = %q", rule.Webhook.AuthType)
	}
}

func TestParseTriggerRuleDefaultsToDisabledAndGet(t *testing.T) {
	rule, err := parseTriggerRule(map[string]any{
		"name":     "always",
		"action":   "0",
		"webhooks": map[string]any{"url": "https://example.test/hook"},
	})
	if err != nil {
		t.Fatalf("parseTriggerRule: %v", err)
	}
	if rule.Enabled {
		t.Fatal("enable absent should mean disabled")
	}
	if rule.Webhook == nil || rule.Webhook.Method != "GET" {
		t.Fatalf("webhook = %+v, want default GET", rule.Webhook)
	}
}

func TestParseTriggerRuleRefusesAMalformedAction(t *testing.T) {
	if _, err := parseTriggerRule(map[string]any{
		"action":   "add",
		"webhooks": map[string]any{"url": "https://example.test/hook"},
	}); err == nil {
		t.Fatal("parseTriggerRule() = nil error, want malformed action refused")
	}
}

func TestTriggerRuleMatchesOnlyItsEvent(t *testing.T) {
	rule := triggerRule{Enabled: true, Action: model.OperateAdd}
	if !rule.matches(TriggerEvent{Kind: model.OperateAdd}) {
		t.Fatal("add trigger should match add")
	}
	if rule.matches(TriggerEvent{Kind: model.OperateUpdate}) {
		t.Fatal("add trigger should not match update")
	}
	rule.Enabled = false
	if rule.matches(TriggerEvent{Kind: model.OperateAdd}) {
		t.Fatal("disabled trigger should not match")
	}
}

func TestTriggerRuleUpdateScopeMatchesChangedAttributes(t *testing.T) {
	rule := triggerRule{Enabled: true, Action: model.OperateUpdate, AttrIDs: []model.ID{11, 12}}
	if !rule.matches(TriggerEvent{Kind: model.OperateUpdate, ChangedAttrIDs: []model.ID{12, 13}}) {
		t.Fatal("a changed in-scope attribute should match")
	}
	if rule.matches(TriggerEvent{Kind: model.OperateUpdate, ChangedAttrIDs: []model.ID{13}}) {
		t.Fatal("no changed in-scope attribute should not match")
	}
	rule.AttrIDs = nil
	if !rule.matches(TriggerEvent{Kind: model.OperateUpdate, ChangedAttrIDs: []model.ID{13}}) {
		t.Fatal("an unscoped update trigger should match any change")
	}
	if rule.matches(TriggerEvent{Kind: model.OperateDelete}) {
		t.Fatal("an update trigger should not match delete")
	}
}

func TestTriggerRuleScopeAlsoAppliesToAddButNotDelete(t *testing.T) {
	rule := triggerRule{Enabled: true, Action: model.OperateAdd, AttrIDs: []model.ID{11}}
	if !rule.matches(TriggerEvent{Kind: model.OperateAdd, ChangedAttrIDs: []model.ID{11, 12}}) {
		t.Fatal("an added in-scope attribute should match")
	}
	if rule.matches(TriggerEvent{Kind: model.OperateAdd, ChangedAttrIDs: []model.ID{12}}) {
		t.Fatal("no added in-scope attribute should not match")
	}
	deleteRule := triggerRule{Enabled: true, Action: model.OperateDelete, AttrIDs: []model.ID{11}}
	if !deleteRule.matches(TriggerEvent{Kind: model.OperateDelete}) {
		t.Fatal("delete ignores attr_ids in cantor, so it should match")
	}
}

func TestRenderTriggerTemplateReplacesKnownAttributes(t *testing.T) {
	got := renderTriggerTemplate(
		`{"host":"{{ hostname }}","env":"{{ env }}","missing":"{{ nope }}"}`,
		map[string]string{"hostname": "web-01", "env": "prod"},
	)
	want := `{"host":"web-01","env":"prod","missing":"{{ nope }}"}`
	if got != want {
		t.Fatalf("renderTriggerTemplate() = %q, want %q", got, want)
	}
}
