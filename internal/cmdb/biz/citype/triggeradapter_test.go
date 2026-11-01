package citype

import (
	"context"
	"strings"
	"testing"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
	"github.com/ongridio/ongrid/internal/pkg/secretbox"
)

func sealedTrigger(t *testing.T, id model.ID, typeID model.ID) citypemodel.CITypeTrigger {
	t.Helper()
	username, err := secretbox.Encrypt("ops")
	if err != nil {
		t.Fatalf("encrypt username: %v", err)
	}
	password, err := secretbox.Encrypt("s3cret")
	if err != nil {
		t.Fatalf("encrypt password: %v", err)
	}
	authType, err := secretbox.Encrypt("BasicAuth")
	if err != nil {
		t.Fatalf("encrypt type: %v", err)
	}
	row := citypemodel.CITypeTrigger{
		TypeID: typeID,
		Notify: map[string]any{
			"name":   "hook",
			"enable": true,
			"action": "2",
			"webhooks": map[string]any{
				"method":    "POST",
				"url":       "https://example.test/hook",
				"auth_type": "BasicAuth",
				"authorization": map[string]any{
					"username": username,
					"password": password,
					"type":     authType,
				},
			},
		},
	}
	row.ID = id
	return row
}

func TestTriggerSourceDecryptsTheCredentialAndRedactsTheOption(t *testing.T) {
	repo := ruleRepo(10, textAttr(1, "hostname"))
	repo.triggers = []citypemodel.CITypeTrigger{sealedTrigger(t, 700, 10)}
	source := NewTriggerSource(attrUsecase(repo))

	configs, err := source.TriggersForType(context.Background(), 10)
	if err != nil {
		t.Fatalf("TriggersForType: %v", err)
	}
	if len(configs) != 1 {
		t.Fatalf("configs = %+v", configs)
	}
	config := configs[0]
	webhooks, ok := config.Option["webhooks"].(map[string]any)
	if !ok {
		t.Fatalf("option webhooks = %T", config.Option["webhooks"])
	}
	if _, leaked := webhooks["authorization"]; leaked {
		t.Fatal("the redacted option still carries the authorization block")
	}
	if webhooks["auth_type"] != "BasicAuth" {
		t.Fatalf("auth_type = %v, want it kept outside the credential", webhooks["auth_type"])
	}
	if config.Authorization["username"] != "ops" || config.Authorization["password"] != "s3cret" || config.Authorization["type"] != "BasicAuth" {
		t.Fatalf("authorization = %+v", config.Authorization)
	}

	byID, err := source.TriggerByID(context.Background(), 700)
	if err != nil || byID == nil {
		t.Fatalf("TriggerByID = %+v, %v", byID, err)
	}
	if byID.Authorization["password"] != "s3cret" {
		t.Fatalf("by-id authorization = %+v", byID.Authorization)
	}
}

func TestTriggerSourceSkipsAnUndecryptableCredentialButKeepsTheOthers(t *testing.T) {
	repo := ruleRepo(10, textAttr(1, "hostname"))
	broken := sealedTrigger(t, 700, 10)
	webhooks := broken.Notify["webhooks"].(map[string]any)
	auth := webhooks["authorization"].(map[string]any)
	auth["password"] = "v1:not-a-ciphertext"
	healthy := sealedTrigger(t, 701, 10)
	repo.triggers = []citypemodel.CITypeTrigger{broken, healthy}
	source := NewTriggerSource(attrUsecase(repo))

	configs, err := source.TriggersForType(context.Background(), 10)
	if err != nil {
		t.Fatalf("TriggersForType: %v", err)
	}
	if len(configs) != 1 || configs[0].ID != 701 {
		t.Fatalf("configs = %+v, want only the readable rule", configs)
	}

	// A manual test names one rule, so it must report the corrupt credential
	// rather than silently firing unauthenticated.
	if _, err := source.TriggerByID(context.Background(), 700); err == nil {
		t.Fatal("TriggerByID() = nil error, want the corrupt credential refused")
	} else if strings.Contains(err.Error(), "s3cret") {
		t.Fatalf("error leaked the plaintext: %v", err)
	}
}
