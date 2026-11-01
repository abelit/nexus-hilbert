package ci

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
)

// TriggerEvent is one committed instance write, as the trigger engine sees it.
//
// It is built after the write's transaction commits and carries a SNAPSHOT of
// the values the templates may reference. Loading the values again inside the
// engine would let a concurrent edit change the payload of an event that has
// already happened.
type TriggerEvent struct {
	TypeID model.ID
	CIID   model.ID
	// RecordID is the operation record the write produced, when it produced
	// one. A delete has no operation record in this build.
	RecordID model.ID

	Kind           model.OperateType
	ChangedAttrIDs []model.ID

	// Values is keyed by attribute NAME and already rendered: lists are joined
	// with ", " and JSON values are encoded. Passwords are never present.
	Values map[string]string

	Actor      model.ID
	ActorEmail string
}

// triggerRule is the part of an option document the dispatcher understands.
//
// The option is an open-ended JSON document shared with cantor; everything the
// dispatcher does not read is deliberately left alone, and an unrecognised key
// is never a reason to refuse an otherwise valid rule.
type triggerRule struct {
	Name    string
	Enabled bool
	Action  model.OperateType
	AttrIDs []model.ID
	Filter  string

	Webhook *triggerWebhook
}

// triggerWebhook is one outbound request definition, with the credential kept
// separately because the store seals it and the adapter decrypts it.
type triggerWebhook struct {
	Method        string
	URL           string
	Parameters    map[string]string
	Headers       map[string]string
	Body          string
	AuthType      string
	Authorization map[string]string
}

// parseTriggerRule reads the option document into the dispatcher's vocabulary.
//
// A malformed rule returns an error rather than a zero value: the engine skips
// that one row and keeps the other rules on the model working.
func parseTriggerRule(option map[string]any) (triggerRule, error) {
	// cantor requires an explicit truthy `enable` before a rule fires, and this
	// build keeps that: a rule whose flag is missing is configuration in
	// progress, not a rule that has silently opted itself in.
	rule := triggerRule{Enabled: false}

	if name, ok := option["name"].(string); ok {
		rule.Name = strings.TrimSpace(name)
	}
	if raw, ok := option["enable"]; ok {
		enabled, err := triggerBool(raw)
		if err != nil {
			return rule, fmt.Errorf("trigger enable: %w", err)
		}
		rule.Enabled = enabled
	}

	rawAction, ok := option["action"]
	if !ok {
		return rule, fmt.Errorf("trigger action is missing")
	}
	action, err := triggerOperateType(rawAction)
	if err != nil {
		return rule, err
	}
	rule.Action = action

	if raw, ok := option["attr_ids"]; ok && raw != nil {
		ids, err := triggerAttrIDs(raw)
		if err != nil {
			return rule, err
		}
		rule.AttrIDs = ids
	}
	if filter, ok := option["filter"].(string); ok {
		rule.Filter = strings.TrimSpace(filter)
	}

	rawWebhook, ok := option["webhooks"]
	if !ok || rawWebhook == nil {
		return rule, nil
	}
	webhook, err := parseTriggerWebhook(rawWebhook)
	if err != nil {
		return rule, err
	}
	rule.Webhook = webhook
	return rule, nil
}

// matches reports whether the rule is enabled for this event and, on a create
// or update, whether one of the changed attributes is in its scope.
//
// A DELETE IGNORES THE SCOPE, which is cantor's delete path: deletion has no
// per-attribute change list, and the rule's action already names the event.
func (r triggerRule) matches(event TriggerEvent) bool {
	if !r.Enabled || r.Action != event.Kind {
		return false
	}
	if event.Kind == model.OperateDelete || len(r.AttrIDs) == 0 {
		return true
	}
	for _, changed := range event.ChangedAttrIDs {
		for _, scoped := range r.AttrIDs {
			if changed == scoped {
				return true
			}
		}
	}
	return false
}

func parseTriggerWebhook(raw any) (*triggerWebhook, error) {
	object, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("webhooks must be an object")
	}
	if len(object) == 0 {
		// An empty block is cantor's "no webhook action": it is falsy there and
		// falls through to notifies, which this dispatcher does not send.
		return nil, nil
	}
	url, _ := object["url"].(string)
	url = strings.TrimSpace(url)
	webhook := &triggerWebhook{
		// cantor's sender defaults to GET when the option carries no method.
		Method:     "GET",
		URL:        url,
		Parameters: stringMap(object["parameters"]),
		Headers:    stringMap(object["headers"]),
	}
	if method, ok := object["method"].(string); ok {
		if method = strings.ToUpper(strings.TrimSpace(method)); method != "" {
			webhook.Method = method
		}
	}
	switch body := object["body"].(type) {
	case nil:
	case string:
		webhook.Body = body
	default:
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("webhook body: %w", err)
		}
		webhook.Body = string(encoded)
	}
	if authType, ok := object["auth_type"].(string); ok {
		webhook.AuthType = strings.TrimSpace(authType)
	}
	return webhook, nil
}

// triggerBool accepts the boolean and the string/number spellings an adopted
// document may hold.
func triggerBool(raw any) (bool, error) {
	switch v := raw.(type) {
	case bool:
		return v, nil
	case string:
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "true", "1", "yes", "on":
			return true, nil
		case "false", "0", "no", "off":
			return false, nil
		}
	case float64:
		return v != 0, nil
	case int:
		return v != 0, nil
	case int64:
		return v != 0, nil
	}
	return false, fmt.Errorf("expected a boolean, got %T", raw)
}

func triggerOperateType(raw any) (model.OperateType, error) {
	var action model.OperateType
	switch v := raw.(type) {
	case string:
		action = model.OperateType(strings.TrimSpace(v))
	case float64:
		action = model.OperateType(fmt.Sprint(int64(v)))
	case int:
		action = model.OperateType(fmt.Sprint(v))
	case int64:
		action = model.OperateType(fmt.Sprint(v))
	default:
		return "", fmt.Errorf("trigger action: expected a string, got %T", raw)
	}
	if !action.Valid() {
		return "", fmt.Errorf("trigger action %q is not 0, 1 or 2", action)
	}
	return action, nil
}

// triggerAttrIDs coerces the attribute scope. cantor stored whatever shape the
// caller sent and only iterated it at fire time; accepting a scalar here is
// deliberate because the field has appeared in both shapes.
func triggerAttrIDs(raw any) ([]model.ID, error) {
	switch v := raw.(type) {
	case []model.ID:
		return v, nil
	case []any:
		out := make([]model.ID, 0, len(v))
		for _, item := range v {
			id, err := triggerAttrID(item)
			if err != nil {
				return nil, err
			}
			out = append(out, id)
		}
		return out, nil
	default:
		id, err := triggerAttrID(raw)
		if err != nil {
			return nil, err
		}
		return []model.ID{id}, nil
	}
}

func triggerAttrID(raw any) (model.ID, error) {
	var n int64
	switch v := raw.(type) {
	case float64:
		n = int64(v)
	case int:
		n = int64(v)
	case int64:
		n = int64(v)
	case int32:
		n = int64(v)
	case string:
		if _, err := fmt.Sscanf(strings.TrimSpace(v), "%d", &n); err != nil {
			return 0, fmt.Errorf("attr_ids contains %q", v)
		}
	default:
		return 0, fmt.Errorf("attr_ids contains %T", raw)
	}
	if n <= 0 {
		return 0, fmt.Errorf("attr_ids contains %d", n)
	}
	return model.ID(n), nil
}

func stringMap(raw any) map[string]string {
	out := map[string]string{}
	switch v := raw.(type) {
	case map[string]string:
		for key, value := range v {
			out[key] = value
		}
	case map[string]any:
		for key, value := range v {
			switch typed := value.(type) {
			case string:
				out[key] = typed
			case nil:
				out[key] = ""
			case float64, bool:
				out[key] = fmt.Sprint(typed)
			default:
				// cantor JSON-dumps a non-scalar parameter before rendering it.
				// Encoding it keeps an adopted document's request shape rather
				// than dropping the key.
				if encoded, err := json.Marshal(typed); err == nil {
					out[key] = string(encoded)
				}
			}
		}
	}
	return out
}

var triggerTemplatePattern = regexp.MustCompile(`\{\{\s*([^{}]+?)\s*\}\}`)

// renderTriggerTemplate replaces `{{ attribute_name }}` with the event
// snapshot. An unknown reference is LEFT AS WRITTEN: silently deleting it would
// make a typo produce a valid request with a missing field, which is harder to
// notice than a literal placeholder in the receiver's log.
func renderTriggerTemplate(text string, values map[string]string) string {
	if text == "" || len(values) == 0 {
		return text
	}
	return triggerTemplatePattern.ReplaceAllStringFunc(text, func(match string) string {
		name := strings.TrimSpace(triggerTemplatePattern.FindStringSubmatch(match)[1])
		if value, ok := values[name]; ok {
			return value
		}
		return match
	})
}
