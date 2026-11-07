package discovery

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	discoverybiz "github.com/ongridio/ongrid/internal/cmdb/biz/discovery"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// The agent-facing API.
//
// IT IS A SEPARATE AUTHENTICATION REALM FROM THE CONSOLE. These routes accept
// only a riemann service token (`cmdbagent_<public_id>.<secret>`); they never
// read the console's JWT and never expose Role/IsSuperuser. The routes are
// mounted outside auth.Middleware by cmd/ongrid-cmdb, deliberately.

type agentPrincipalKey struct{}

// AgentMiddleware authenticates a machine request and puts its principal on
// the context.
func (h *Handler) AgentMiddleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			raw := bearerToken(r)
			principal, err := h.uc.AuthenticateAgent(r.Context(), raw)
			if err != nil {
				writeErr(w, err)
				return
			}
			ctx := context.WithValue(r.Context(), agentPrincipalKey{}, *principal)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func agentPrincipalFrom(r *http.Request) (discoverybiz.AgentPrincipalView, bool) {
	value, ok := r.Context().Value(agentPrincipalKey{}).(discoverybiz.AgentPrincipalView)
	return value, ok
}

func bearerToken(r *http.Request) string {
	const prefix = "Bearer "
	if value := r.Header.Get("Authorization"); strings.HasPrefix(value, prefix) {
		return strings.TrimSpace(strings.TrimPrefix(value, prefix))
	}
	return ""
}

// RegisterAgent mounts the routes relative to the agent prefix. The caller
// installs AgentMiddleware first.
func (h *Handler) RegisterAgent(r chi.Router) {
	r.Post("/register", h.agentRegister)
	r.Post("/heartbeat", h.agentHeartbeat)
	r.Post("/tasks/sync", h.agentTaskSync)
	r.Post("/reports", h.agentReports)
	r.Post("/exec-logs", h.agentExecLogs)
}

const maxAgentBody = 16 << 20

func (h *Handler) agentRegister(w http.ResponseWriter, r *http.Request) {
	principal, ok := agentPrincipalFrom(r)
	if !ok {
		writeErr(w, errs.ErrUnauthorized)
		return
	}
	var body discoverybiz.EulerRegistration
	if err := decodeAgentBody(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	got, err := h.uc.RegisterEuler(r.Context(), principal, body)
	if err != nil {
		writeErr(w, err)
		return
	}
	response := map[string]any{
		"api_version":     "agent.v1",
		"max_batch_items": 1000,
		"euler":           got,
	}
	if publicKey, keyID := h.uc.TaskSigningKey(); len(publicKey) > 0 {
		response["task_signing_public_key"] = publicKey
		response["task_signing_key_id"] = keyID
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *Handler) agentHeartbeat(w http.ResponseWriter, r *http.Request) {
	principal, ok := agentPrincipalFrom(r)
	if !ok {
		writeErr(w, errs.ErrUnauthorized)
		return
	}
	var body discoverybiz.EulerRegistration
	if err := decodeAgentBody(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	if err := h.uc.HeartbeatEuler(r.Context(), principal, body); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) agentTaskSync(w http.ResponseWriter, r *http.Request) {
	principal, ok := agentPrincipalFrom(r)
	if !ok {
		writeErr(w, errs.ErrUnauthorized)
		return
	}
	var body discoverybiz.AgentTaskSyncRequest
	if err := decodeAgentBody(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	got, err := h.uc.SyncAgentTasks(r.Context(), principal, body)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, got)
}

func (h *Handler) agentReports(w http.ResponseWriter, r *http.Request) {
	principal, ok := agentPrincipalFrom(r)
	if !ok {
		writeErr(w, errs.ErrUnauthorized)
		return
	}
	var body discoverybiz.AgentReportRequest
	if err := decodeAgentBody(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	results, err := h.uc.SubmitAgentReports(r.Context(), principal, body)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func (h *Handler) agentExecLogs(w http.ResponseWriter, r *http.Request) {
	principal, ok := agentPrincipalFrom(r)
	if !ok {
		writeErr(w, errs.ErrUnauthorized)
		return
	}
	var body discoverybiz.AgentExecLogRequest
	if err := decodeAgentBody(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	results, err := h.uc.SubmitAgentExecLogs(r.Context(), principal, body)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func decodeAgentBody(r *http.Request, out any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, maxAgentBody))
	dec.UseNumber()
	if err := dec.Decode(out); err != nil {
		return errs.ErrInvalid
	}
	return nil
}

// --- console-side issuance and inventory ---

func (h *Handler) createAgentPrincipal(w http.ResponseWriter, r *http.Request) {
	actor, err := actorOf(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var body struct {
		Name       string   `json:"name"`
		RiemannID  string   `json:"riemann_id"`
		Scopes     []string `json:"scopes"`
		TTLSeconds int64    `json:"ttl_seconds"`
	}
	if err := decodeAgentBody(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	created, err := h.uc.CreateAgentPrincipal(r.Context(), body.Name, body.RiemannID, body.Scopes,
		durationSeconds(body.TTLSeconds), actor)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (h *Handler) listAgentPrincipals(w http.ResponseWriter, r *http.Request) {
	actor, err := actorOf(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	items, err := h.uc.ListAgentPrincipals(r.Context(), actor)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": len(items)})
}

func (h *Handler) revokeAgentPrincipal(w http.ResponseWriter, r *http.Request) {
	actor, err := actorOf(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := h.uc.RevokeAgentPrincipal(r.Context(), id, actor); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

func (h *Handler) listEulers(w http.ResponseWriter, r *http.Request) {
	actor, err := actorOf(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	items, err := h.uc.ListEulers(r.Context(), actor)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": len(items)})
}

func durationSeconds(seconds int64) time.Duration {
	if seconds <= 0 {
		return 0
	}
	return time.Duration(seconds) * time.Second
}
