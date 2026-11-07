package discovery

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/ongridio/ongrid/internal/cmdb/biz/discovery/catalog"
	model "github.com/ongridio/ongrid/internal/cmdb/model"
	discoverymodel "github.com/ongridio/ongrid/internal/cmdb/model/discovery"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// The agent's task compiler.
//
// IT IS THE ONLY PLACE THAT TURNS A TARGET INTO A TASK. The console's target
// DTO is for a person; this one is for the process that does the work. The two
// are deliberately separate so the console contract can stay stable while the
// machine contract gains fields.

// maxAgentReportBatch mirrors the proto's advertised limit.
const maxAgentReportBatch = 1000

// agentSecretKeys are removed from params and, in P2, moved into the secret
// envelope. P1 refuses a task that needs one rather than handing out a task
// that cannot work.
var agentCollectKeyRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

var agentSecretKeys = map[string]bool{
	"key": true, "secret": true, "password": true, "community": true,
	"session_token": true,
	"reference":     true, "_reference": true,
}

// supportedCloudCollectors maps the collect_key the catalogue derives to the
// provider field that identifies one resource. The value is the unique-key
// fallback when the model's unique attribute is not part of the mapping.
//
// THE LIST IS A DEPLOYMENT FACT, NOT A CATALOGUE FACT: the catalogue describes
// every resource cantor knows, while euler only ships the adapters in this
// table. An unknown key is a configuration warning, not a task that silently
// fails at the far end.
var supportedCloudCollectors = map[string]string{
	"ali.ecs":      "InstanceId",
	"aws.ec2":      "instanceId",
	"tencent.cvm":  "InstanceId",
	"huawei.ecs":   "id",
	"vsphere.vm":   "vm",
	"vsphere.host": "host", "vsphere.cluster": "cluster", "vsphere.network": "network",
	"vsphere.datastore": "datastore", "vsphere.datacenter": "datacenter",
	"vsphere.folder": "folder", "vsphere.pool": "resource_pool",
}

// SyncAgentTasks computes the diff an euler needs.
func (u *Usecase) SyncAgentTasks(ctx context.Context, principal AgentPrincipalView, req AgentTaskSyncRequest) (*AgentTaskSnapshot, error) {
	if u.agents == nil {
		return nil, errs.ErrNotWiredYet
	}
	if !principal.Allows(ScopeTasksRead) {
		return nil, fmt.Errorf("%w: %s", errs.ErrForbidden, ScopeTasksRead)
	}
	eulerID := strings.TrimSpace(req.EulerID)
	euler, err := u.agents.LoadEuler(ctx, eulerID)
	if err != nil {
		return nil, err
	}
	if euler == nil || euler.RiemannID != principal.RiemannID {
		return nil, fmt.Errorf("%w: euler %s", errs.ErrNotFound, eulerID)
	}

	targets, err := u.repo.ListAllTargets(ctx)
	if err != nil {
		return nil, err
	}
	rules, err := u.rulesByID(ctx)
	if err != nil {
		return nil, err
	}

	current := map[string]AgentTask{}
	assigned := make([]discoverymodel.Target, 0, len(targets))
	warnings := []string{}
	for _, target := range targets {
		if !target.Enabled {
			continue
		}
		rule, hasRule := rules[derefID(target.AdrID)]
		if !hasRule {
			continue
		}
		applies, err := u.targetAppliesToEuler(ctx, target, rule, *euler)
		if err != nil {
			return nil, err
		}
		if !applies {
			continue
		}
		task, warning, err := u.buildAgentTask(ctx, target, rule, *euler)
		if err != nil {
			// A BAD TARGET MUST NOT STOP THE OTHER TARGETS. A dangling account
			// reference or an unreadable credential is configuration the
			// operator can fix; the healthy tasks still go out, and the warning
			// names the broken one. Database and envelope failures remain fatal.
			if errors.Is(err, ErrTargetIncomplete) || errors.Is(err, ErrCredentialUnreadable) {
				warnings = append(warnings, fmt.Sprintf("target %d: %v", target.ID, err))
				continue
			}
			return nil, err
		}
		if warning != "" {
			warnings = append(warnings, warning)
			continue
		}
		if !eulerAdvertises(*euler, task.CollectKey) {
			warnings = append(warnings, fmt.Sprintf("target %d: collector %s does not advertise %s",
				target.ID, euler.EulerID, task.CollectKey))
			continue
		}
		current[task.TaskID] = task
		assigned = append(assigned, target)
	}

	known := make(map[string]AgentTaskRevision, len(req.Known))
	for _, item := range req.Known {
		known[item.TaskID] = item
	}

	changed := make([]AgentTask, 0, len(current))
	for id, task := range current {
		prior, ok := known[id]
		if req.StateLost || !ok || prior.Revision != task.Revision || prior.NeedSecret {
			changed = append(changed, task)
		}
	}
	sort.Slice(changed, func(i, j int) bool { return changed[i].TaskID < changed[j].TaskID })

	// THE HANDOVER LOG RECORDS WHAT WAS ACTUALLY SENT, NOT EVERY POLL. Writing
	// one row per assigned target on every sync would multiply the handover
	// table by (targets × collectors) every 30 seconds; a collector's liveness
	// comes from its heartbeat instead, and the health view joins the two.
	if len(changed) > 0 {
		byTaskID := make(map[string]discoverymodel.Target, len(assigned))
		for _, target := range assigned {
			byTaskID[fmt.Sprintf("t:%d", target.ID)] = target
		}
		at := u.Now()
		entries := make([]SyncHistoryWrite, 0, len(changed))
		for _, task := range changed {
			target, ok := byTaskID[task.TaskID]
			if !ok {
				continue
			}
			entries = append(entries, SyncHistoryWrite{
				AdtID:        target.ID,
				OneagentID:   euler.EulerID,
				OneagentName: euler.Hostname,
				SyncAt:       at,
			})
		}
		if len(entries) > 0 {
			if err := u.repo.RecordSyncHistories(ctx, entries); err != nil {
				return nil, fmt.Errorf("record collector handover: %w", err)
			}
		}
	}

	removed := []string{}
	if !req.StateLost {
		for id := range known {
			if _, ok := current[id]; !ok {
				removed = append(removed, id)
			}
		}
		sort.Strings(removed)
	}

	sort.Strings(warnings)
	if len(warnings) > 1 {
		deduped := warnings[:1]
		for _, warning := range warnings[1:] {
			if warning != deduped[len(deduped)-1] {
				deduped = append(deduped, warning)
			}
		}
		warnings = deduped
	}

	all := make([]AgentTask, 0, len(current))
	for _, task := range current {
		all = append(all, task)
	}
	return &AgentTaskSnapshot{
		EulerID: eulerID, Epoch: snapshotEpoch(all), Reset: req.StateLost,
		Changed: changed, RemovedTaskIDs: removed, Warnings: warnings,
	}, nil
}

// targetAppliesToEuler is the agent-side form of targetApplies: an explicit
// binding, an expression evaluated against the euler's placement, or the
// catch-all rule for host-ish collectors.
func (u *Usecase) targetAppliesToEuler(ctx context.Context, target discoverymodel.Target, rule discoverymodel.Rule, euler discoverymodel.Euler) (bool, error) {
	agentID := strings.TrimSpace(derefString(target.AgentID))
	expr := strings.TrimSpace(derefString(target.QueryExpr))

	switch {
	case agentID != "":
		return agentID == euler.EulerID, nil
	case expr != "":
		if u.instances == nil {
			return false, nil
		}
		ciID, err := u.instances.LocateAgentInstance(ctx, euler.EulerID, euler.Hostname)
		if err != nil {
			return false, err
		}
		if ciID == 0 {
			return false, nil
		}
		return u.instances.MatchInstance(ctx, stripQueryPrefix(expr), ciID)
	default:
		// The catch-all does not include cloud or SNMP: those are not a host's
		// job and must be bound explicitly.
		switch derefString(rule.Type) {
		case discoverymodel.TypeSNMP, discoverymodel.TypeHTTP:
			return false, nil
		default:
			return true, nil
		}
	}
}

// eulerAdvertises reports whether the collector named the task's collect key.
// An empty capability list means "unknown" (an older collector), which is
// allowed so a rollout does not turn every target into a warning.
func eulerAdvertises(euler discoverymodel.Euler, collectKey string) bool {
	caps := euler.Capabilities()
	if len(caps) == 0 {
		return true
	}
	raw, ok := caps["collect_keys"]
	if !ok {
		return true
	}
	list, ok := raw.([]any)
	if !ok || len(list) == 0 {
		return true
	}
	for _, item := range list {
		if fmt.Sprint(item) == collectKey {
			return true
		}
	}
	return false
}

// buildAgentTask renders one target. A non-empty warning means the target is
// visible to an operator but cannot run yet (an unsupported cloud resource or
// an SNMP target without a community).
func (u *Usecase) buildAgentTask(ctx context.Context, target discoverymodel.Target, rule discoverymodel.Rule, euler discoverymodel.Euler) (AgentTask, string, error) {
	typeID := derefID(target.TypeID)
	ruleType := derefString(rule.Type)
	kind := ruleType
	if rule.IsPlugin {
		kind = "plugin"
	} else if ruleType == discoverymodel.TypeHTTP {
		// The machine contract calls an API collector `cloud`; the console keeps
		// calling the provider kind `http`.
		kind = "cloud"
	}

	collectKey := agentCollectKey(rule, target)
	if kind == "cloud" {
		if strings.TrimSpace(collectKey) == "" {
			return AgentTask{}, fmt.Sprintf("target %d: cloud target has no resource kind", target.ID), nil
		}
		if _, ok := supportedCloudCollectors[collectKey]; !ok {
			return AgentTask{}, fmt.Sprintf("target %d: cloud collector %q is not implemented", target.ID, collectKey), nil
		}
		if problem := cloudConfigProblem(rule, target, collectKey); problem != "" {
			return AgentTask{}, fmt.Sprintf("target %d: %s", target.ID, problem), nil
		}
	}
	if !agentCollectKeyRE.MatchString(collectKey) || strings.Contains(collectKey, "..") {
		return AgentTask{}, fmt.Sprintf("target %d: collect_key %q is not a safe agent name", target.ID, collectKey), nil
	}

	mapping := map[string]string{}
	for provider, attr := range target.Attributes {
		mapping[provider] = fmt.Sprint(attr)
	}

	uniqueKey := ""
	// A PLUGIN DECLARES ITS OWN UNIQUE FIELD. The model's unique attribute is
	// the fallback for built-in providers; a plugin such as panserver_plugin
	// keys on `ip` while the model identifies on `uuid`, and using the model's
	// key would make every collection a new sighting when the plugin generates
	// a fresh uuid.
	if rule.IsPlugin {
		uniqueKey = derefString(rule.UniqueKey)
	}
	if uniqueKey == "" && u.models != nil {
		ref, err := u.models.ResolveCIType(ctx, fmt.Sprint(typeID))
		if err != nil {
			return AgentTask{}, "", err
		}
		if ref != nil && ref.UniqueKey != "" {
			// Sort the candidates: two provider fields can map to the same model
			// attribute, and a map-iteration winner would make the task revision
			// drift between syncs.
			matches := make([]string, 0, 1)
			for provider, attr := range mapping {
				if attr == ref.UniqueKey {
					matches = append(matches, provider)
				}
			}
			if len(matches) > 0 {
				sort.Strings(matches)
				uniqueKey = matches[0]
			}
		}
	}
	if uniqueKey == "" {
		uniqueKey = derefString(rule.UniqueKey)
	}
	// A CLOUD RESOURCE ALWAYS HAS A PROVIDER ID, even when the model's unique
	// attribute is not part of this mapping. The fallback is the ID field the
	// shipped template uses (`InstanceId` / `instanceId`).
	if uniqueKey == "" && kind == "cloud" {
		uniqueKey = supportedCloudCollectors[collectKey]
	}
	// A NETWORK DEVICE ALWAYS HAS A MANAGEMENT ADDRESS, even when the model's
	// unique attribute is not part of this mapping. The template reports it
	// under `manager_ip`, so it is a deterministic fallback that cannot collide
	// with another device on the same collector.
	if uniqueKey == "" && kind == discoverymodel.TypeSNMP {
		uniqueKey = "manager_ip"
	}
	if uniqueKey == "" {
		return AgentTask{}, fmt.Sprintf("target %d: no deterministic unique key", target.ID), nil
	}

	opened, err := u.openCredentials(ctx, target)
	if err != nil {
		return AgentTask{}, "", err
	}
	if kind == "cloud" {
		// AN ACCOUNT MAY SUPPLY CREDENTIALS AND REGION, NOT THE COLLECTOR.
		// openCredentials merges the account over the target, so remove the
		// routing keys there and restore the target's category. Otherwise a
		// shared account could silently redirect a target to another provider.
		delete(opened, "collect_key")
		delete(opened, "provider")
		delete(opened, "endpoint")
		delete(opened, "insecure")
		if raw, ok := target.ExtraOption["insecure"]; ok {
			opened["insecure"] = raw
		}
		if raw, ok := target.ExtraOption["category"].(string); ok {
			opened["category"] = raw
		} else {
			delete(opened, "category")
		}
		if raw, ok := target.ExtraOption["endpoint"].(string); ok && strings.TrimSpace(raw) != "" {
			opened["endpoint"] = raw
		}
	}
	secrets := map[string]string{}
	snmpProblem := ""
	if kind == discoverymodel.TypeSNMP {
		// NODE COMMUNITIES ARE CREDENTIALS TOO. They live inside `nodes[]`,
		// which is not a top-level secret key, so they are moved into their own
		// envelope entry and removed from the task parameters before the task
		// is signed or sent.
		snmpProblem, err = extractSNMPCommunities(opened, secrets)
		if err != nil {
			return AgentTask{}, "", err
		}
	}
	params := map[string]any{}
	for key, value := range opened {
		if agentSecretKeys[key] {
			if key != "reference" && key != "_reference" {
				secrets[key] = fmt.Sprint(value)
			}
			continue
		}
		params[key] = value
	}
	if kind == discoverymodel.TypeSNMP && snmpProblem != "" {
		return AgentTask{}, fmt.Sprintf("target %d: %s", target.ID, snmpProblem), nil
	}
	if kind == "cloud" {
		if problem := cloudCredentialProblem(rule, target, collectKey, opened, secrets); problem != "" {
			return AgentTask{}, fmt.Sprintf("target %d: %s", target.ID, problem), nil
		}
	}
	task := AgentTask{
		TaskID:     fmt.Sprintf("t:%d", target.ID),
		Kind:       kind,
		TypeID:     typeID,
		AdrID:      derefID(target.AdrID),
		CollectKey: collectKey,
		UniqueKey:  uniqueKey,
		Mapping:    mapping,
		Params:     params,
		Schedule: AgentTaskSchedule{
			Cron: derefString(target.Cron),
		},
		Enabled:           true,
		SecretFingerprint: secretFingerprint(secrets),
	}
	if rule.IsPlugin {
		script := derefString(rule.PluginScript)
		if strings.TrimSpace(script) == "" {
			return AgentTask{}, fmt.Sprintf("target %d: plugin rule has no script", target.ID), nil
		}
		sum := sha256.Sum256([]byte(script))
		task.Artifact = &AgentArtifact{
			Language: "python", SHA256: hex.EncodeToString(sum[:]), Script: []byte(script),
		}
		task.CapabilitiesRequired = []string{"plugin:python"}
	} else if kind == discoverymodel.TypeSNMP {
		task.CapabilitiesRequired = []string{"snmp"}
	} else if kind == "cloud" {
		task.CapabilitiesRequired = []string{"cloud"}
	}
	task.Revision = canonicalTaskRevision(task)
	if len(secrets) > 0 {
		if len(euler.PublicKey) == 0 {
			return AgentTask{}, fmt.Sprintf("target %d: euler %s has no public key for credential delivery", target.ID, euler.EulerID), nil
		}
		plaintext, err := json.Marshal(secrets)
		if err != nil {
			return AgentTask{}, "", err
		}
		aad := []byte(euler.EulerID + "|" + task.TaskID + "|" + task.Revision)
		envelope, keyID, alg, err := sealSecretEnvelope(euler.PublicKey, plaintext, aad)
		if err != nil {
			return AgentTask{}, "", err
		}
		task.SecretEnvelope = envelope
		task.SecretKeyID = keyID
		task.SecretAlg = alg
	}
	if err := u.signTask(&task); err != nil {
		return AgentTask{}, "", fmt.Errorf("sign target %d: %w", target.ID, err)
	}
	return task, "", nil
}

// cloudCredentialProblem validates the fields each cloud family needs. A
// vCenter target authenticates with host/account/password, while the public
// clouds use region plus an access key; Huawei additionally needs the project
// id that is part of its URL.
func cloudCredentialProblem(rule discoverymodel.Rule, target discoverymodel.Target, collectKey string, opened map[string]any, secrets map[string]string) string {
	provider := cloudProviderOf(rule, target)
	if provider == "vcenter" || strings.HasPrefix(collectKey, "vsphere.") {
		if plainTextValue(opened["host"]) == "" {
			return "cloud target has no host"
		}
		if plainTextValue(opened["account"]) == "" {
			return "cloud target has no account"
		}
		if plainTextValue(secrets["password"]) == "" {
			return "cloud target has no password"
		}
		return ""
	}
	if plainTextValue(opened["region"]) == "" {
		return "cloud target has no region"
	}
	if collectKey == "huawei.ecs" && plainTextValue(opened["project_id"]) == "" {
		return "Huawei ECS target has no project_id"
	}
	accessKey := plainTextValue(secrets["key"])
	if accessKey == "" {
		// Imported accounts may spell the key id `access_key`; it is not a
		// secret, so it stays in params and the adapter accepts either name.
		accessKey = plainTextValue(opened["access_key"])
	}
	if accessKey == "" || plainTextValue(secrets["secret"]) == "" {
		return "cloud target has no access key"
	}
	return ""
}

func cloudProviderOf(rule discoverymodel.Rule, target discoverymodel.Target) string {
	if raw, ok := target.ExtraOption["provider"].(string); ok && strings.TrimSpace(raw) != "" {
		return normalizeCloudProvider(raw)
	}
	return normalizeCloudProvider(providerENOf(rule))
}

// normalizeCloudProvider reconciles the few historical spellings that predate
// the catalogue's stable provider keys. It deliberately does not guess a
// mapping for a display name such as "阿里云"; built-in rules carry `option.en`.
func normalizeCloudProvider(value string) string {
	value = strings.TrimSpace(value)
	if strings.EqualFold(value, "vcenter") {
		return "vcenter"
	}
	return value
}

// cloudConfigProblem catches a target that was saved under one resource kind
// and still carries a stale collector/provider pair. It is a warning, not a
// sync error: the operator can fix the target without stopping other targets.
func cloudConfigProblem(rule discoverymodel.Rule, target discoverymodel.Target, collectKey string) string {
	provider := normalizeCloudProvider(providerENOf(rule))
	if raw, ok := target.ExtraOption["provider"].(string); ok {
		raw = strings.TrimSpace(raw)
		if raw != "" && provider != "" && normalizeCloudProvider(raw) != provider {
			return fmt.Sprintf("target provider %q does not match rule provider %q", raw, provider)
		}
	}
	category := ""
	if raw, ok := target.ExtraOption["category"].(string); ok {
		category = strings.TrimSpace(raw)
	}
	if category == "" {
		return ""
	}
	derived, err := catalog.CollectKey(normalizeCloudProvider(cloudProviderOf(rule, target)), category)
	if err != nil {
		return fmt.Sprintf("cannot resolve cloud resource %q", category)
	}
	if derived != "" && derived != collectKey {
		return fmt.Sprintf("resource kind %q resolves to collector %q, not %q", category, derived, collectKey)
	}
	return ""
}

func agentCollectKey(rule discoverymodel.Rule, target discoverymodel.Target) string {
	// A PLUGIN'S SCRIPT IS INSTALLED UNDER ITS RULE NAME, so the task must name
	// the same collector.
	if rule.IsPlugin {
		return rule.Name
	}
	// SNMP IS ONE COLLECTOR FOR EVERY DEVICE KIND. A rule's display name is a
	// Chinese device label ("交换机"), which is neither a safe file name nor the
	// euler plugin that knows how to walk the device. This check comes before
	// `option.collect_key` so a stale cloud key cannot select the wrong
	// collector for a network device.
	if derefString(rule.Type) == discoverymodel.TypeSNMP {
		return "snmp"
	}
	if derefString(rule.Type) == discoverymodel.TypeHTTP {
		// THE COLLECTOR IS A PROPERTY OF THE TARGET, because the category is.
		// `applyProviderOptions` writes it on save; the rule-level option and
		// catalogue are fallbacks for rows that predate that derivation.
		if raw, ok := target.ExtraOption["collect_key"].(string); ok && strings.TrimSpace(raw) != "" {
			return strings.TrimSpace(raw)
		}
		if raw, ok := rule.Option["collect_key"].(string); ok && strings.TrimSpace(raw) != "" {
			return strings.TrimSpace(raw)
		}
		resource := ""
		if raw, ok := target.ExtraOption["category"].(string); ok {
			resource = strings.TrimSpace(raw)
		}
		if resource != "" {
			if key, err := catalog.CollectKey(providerENOf(rule), resource); err == nil {
				return key
			}
		}
		return ""
	}
	if raw, ok := rule.Option["collect_key"].(string); ok && strings.TrimSpace(raw) != "" {
		return strings.TrimSpace(raw)
	}
	if derefString(rule.Type) == discoverymodel.TypeComponents {
		return rule.Name
	}
	if derefString(rule.Type) == discoverymodel.TypeAgent {
		return "server"
	}
	return rule.Name
}

// SubmitAgentReports applies a batch of collected instances. Each item is
// independently idempotent and independently rejected; one bad row does not
// fail the batch.
func (u *Usecase) SubmitAgentReports(ctx context.Context, principal AgentPrincipalView, req AgentReportRequest) ([]AgentReportResult, error) {
	if u.agents == nil {
		return nil, errs.ErrNotWiredYet
	}
	if !principal.Allows(ScopeReportsWrite) {
		return nil, fmt.Errorf("%w: %s", errs.ErrForbidden, ScopeReportsWrite)
	}
	if len(req.Reports) > maxAgentReportBatch {
		return nil, fmt.Errorf("%w: at most %d reports per batch", errs.ErrInvalid, maxAgentReportBatch)
	}
	euler, err := u.agents.LoadEuler(ctx, strings.TrimSpace(req.EulerID))
	if err != nil {
		return nil, err
	}
	if euler == nil || euler.RiemannID != principal.RiemannID {
		return nil, fmt.Errorf("%w: euler %s", errs.ErrNotFound, req.EulerID)
	}

	out := make([]AgentReportResult, 0, len(req.Reports))
	for _, report := range req.Reports {
		result := AgentReportResult{ReportID: report.ReportID, Status: "rejected"}
		if report.ReportID == "" || report.TaskID == "" {
			result.Error = "report_id and task_id are required"
			out = append(out, result)
			continue
		}
		if receipt, err := u.agents.FindReportReceipt(ctx, report.ReportID); err != nil {
			return nil, err
		} else if receipt != nil {
			result.Status = "duplicate"
			result.CIID = derefID(receipt.CIID)
			out = append(out, result)
			continue
		}
		target, rule, err := u.agentTargetForTask(ctx, *euler, report.TaskID)
		if err != nil {
			result.Error = err.Error()
			out = append(out, result)
			continue
		}
		_ = rule
		typeID := derefID(target.TypeID)
		if report.Deleted {
			if err := u.agents.MarkPoolStale(ctx, typeID, strings.TrimSpace(report.UniqueValue), u.Now()); err != nil {
				result.Error = err.Error()
				out = append(out, result)
				continue
			}
			result.Status = "stale"
			u.recordReceipt(ctx, report.ReportID, report.TaskID, result.Status, 0)
			out = append(out, result)
			continue
		}

		var instance map[string]any
		dec := json.NewDecoder(bytes.NewReader(report.Instance))
		dec.UseNumber()
		if err := dec.Decode(&instance); err != nil || instance == nil {
			result.Error = "instance must be a JSON object"
			out = append(out, result)
			continue
		}
		unique := strings.TrimSpace(report.UniqueValue)
		if unique == "" {
			unique = fmt.Sprint(instance[agentUniqueField(ctx, u, target, rule)])
		}
		if unique == "" || unique == "<nil>" {
			result.Error = "unique value is empty"
			out = append(out, result)
			continue
		}
		entry, err := u.UpsertPool(ctx, PoolUpsertInput{
			TypeID: typeID, AdtID: target.ID, UniqueValue: unique,
			Instance: instance, OneagentID: euler.EulerID, OneagentName: euler.Hostname,
		}, Actor{})
		if err != nil {
			result.Error = err.Error()
			out = append(out, result)
			continue
		}
		result.Status = "accepted"
		if entry != nil {
			result.CIID = derefID(entry.CIID)
		}
		u.recordReceipt(ctx, report.ReportID, report.TaskID, result.Status, result.CIID)
		out = append(out, result)
	}
	return out, nil
}

// SubmitAgentExecLogs appends a batch of collector log lines. Logs are
// best-effort: one bad line does not fail the batch.
func (u *Usecase) SubmitAgentExecLogs(ctx context.Context, principal AgentPrincipalView, req AgentExecLogRequest) ([]AgentExecLogResult, error) {
	if u.agents == nil {
		return nil, errs.ErrNotWiredYet
	}
	if !principal.Allows(ScopeLogsWrite) {
		return nil, fmt.Errorf("%w: %s", errs.ErrForbidden, ScopeLogsWrite)
	}
	euler, err := u.agents.LoadEuler(ctx, strings.TrimSpace(req.EulerID))
	if err != nil {
		return nil, err
	}
	if euler == nil || euler.RiemannID != principal.RiemannID {
		return nil, fmt.Errorf("%w: euler %s", errs.ErrNotFound, req.EulerID)
	}
	out := make([]AgentExecLogResult, 0, len(req.Logs))
	for _, item := range req.Logs {
		result := AgentExecLogResult{LogID: item.LogID}
		target, _, err := u.agentTargetForTask(ctx, *euler, item.TaskID)
		if err != nil {
			result.Error = err.Error()
			out = append(out, result)
			continue
		}
		text := item.Stdout
		if item.Stderr != "" {
			text += "\n[stderr]\n" + item.Stderr
		}
		text = truncate(text, 64*1024)
		if strings.TrimSpace(text) == "" {
			result.Error = "empty log"
			out = append(out, result)
			continue
		}
		if err := u.AddExecHistory(ctx, derefID(target.TypeID), text); err != nil {
			result.Error = err.Error()
			out = append(out, result)
			continue
		}
		result.Accepted = true
		out = append(out, result)
	}
	return out, nil
}

func (u *Usecase) recordReceipt(ctx context.Context, reportID, taskID, status string, ciID model.ID) {
	if u.agents == nil {
		return
	}
	_, _ = u.agents.CreateReportReceipt(ctx, ReportReceiptWrite{
		ReportID: reportID, TaskID: taskID, Status: status, CIID: ciID,
	})
}

// agentTargetForTask resolves the target a task id names and verifies that the
// euler is the one it was assigned to.
func (u *Usecase) agentTargetForTask(ctx context.Context, euler discoverymodel.Euler, taskID string) (discoverymodel.Target, discoverymodel.Rule, error) {
	raw := strings.TrimPrefix(strings.TrimSpace(taskID), "t:")
	targetID, ok := parseID(raw)
	if !ok || targetID == 0 {
		return discoverymodel.Target{}, discoverymodel.Rule{}, fmt.Errorf("%w: task %q", errs.ErrInvalid, taskID)
	}
	target, err := u.repo.LoadTarget(ctx, targetID)
	if err != nil {
		return discoverymodel.Target{}, discoverymodel.Rule{}, err
	}
	if target == nil {
		return discoverymodel.Target{}, discoverymodel.Rule{}, fmt.Errorf("%w: task %s", errs.ErrNotFound, taskID)
	}
	rule, err := u.repo.LoadRule(ctx, derefID(target.AdrID))
	if err != nil {
		return discoverymodel.Target{}, discoverymodel.Rule{}, err
	}
	if rule == nil {
		return discoverymodel.Target{}, discoverymodel.Rule{}, fmt.Errorf("%w: rule for task %s", errs.ErrNotFound, taskID)
	}
	applies, err := u.targetAppliesToEuler(ctx, *target, *rule, euler)
	if err != nil {
		return discoverymodel.Target{}, discoverymodel.Rule{}, err
	}
	if !applies {
		return discoverymodel.Target{}, discoverymodel.Rule{}, fmt.Errorf("%w: task %s is not assigned to %s", errs.ErrForbidden, taskID, euler.EulerID)
	}
	return *target, *rule, nil
}

func agentUniqueField(ctx context.Context, u *Usecase, target discoverymodel.Target, rule discoverymodel.Rule) string {
	if rule.IsPlugin && derefString(rule.UniqueKey) != "" {
		return derefString(rule.UniqueKey)
	}
	if u.models != nil {
		if ref, err := u.models.ResolveCIType(ctx, fmt.Sprint(derefID(target.TypeID))); err == nil && ref != nil && ref.UniqueKey != "" {
			for provider, attr := range target.Attributes {
				if fmt.Sprint(attr) == ref.UniqueKey {
					return provider
				}
			}
		}
	}
	return derefString(rule.UniqueKey)
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
