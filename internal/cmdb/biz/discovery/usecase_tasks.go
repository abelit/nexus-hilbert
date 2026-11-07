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
	"reference": true, "_reference": true,
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

// buildAgentTask renders one target. A non-empty warning means the target is
// visible to an operator but cannot run yet (cloud collection needs an
// adapter; an SNMP target still needs a community and a collector).
func (u *Usecase) buildAgentTask(ctx context.Context, target discoverymodel.Target, rule discoverymodel.Rule, euler discoverymodel.Euler) (AgentTask, string, error) {
	typeID := derefID(target.TypeID)
	kind := derefString(rule.Type)
	if rule.IsPlugin {
		kind = "plugin"
	}
	if kind == discoverymodel.TypeHTTP {
		return AgentTask{}, fmt.Sprintf("target %d: %s collection requires a cloud adapter", target.ID, kind), nil
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
			for provider, attr := range mapping {
				if attr == ref.UniqueKey {
					uniqueKey = provider
					break
				}
			}
		}
	}
	if uniqueKey == "" {
		uniqueKey = derefString(rule.UniqueKey)
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
	collectKey := agentCollectKey(rule)
	if !agentCollectKeyRE.MatchString(collectKey) || strings.Contains(collectKey, "..") {
		return AgentTask{}, fmt.Sprintf("target %d: collect_key %q is not a safe agent name", target.ID, collectKey), nil
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

func agentCollectKey(rule discoverymodel.Rule) string {
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
