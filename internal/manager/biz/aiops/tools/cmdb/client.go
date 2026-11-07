// Package cmdb exposes the standalone CMDB service to the AIOps assistant.
//
// It deliberately talks HTTP instead of importing internal/cmdb: the manager
// and CMDB are separate bounded contexts and processes (ADR-035), and
// .go-arch-lint.yml forbids manager_biz from depending on cmdb_*.
//
// Every request carries the caller's own short-lived JWT, minted from
// tenantctx. There is no service account fallback: a background investigation
// or workflow with no authenticated caller gets ErrNoCaller and the tool
// fails closed. See ADR-037.
package cmdb

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ongridio/ongrid/internal/pkg/auth"
	"github.com/ongridio/ongrid/internal/pkg/tenantctx"
)

// apiPrefix is where cmd/ongrid-cmdb mounts its handlers: the routes register
// /v1/cmdb/* and the process mounts them under /api.
const apiPrefix = "/api/v1/cmdb"

// maxResponseBytes bounds one CMDB reply before it reaches the model.
const maxResponseBytes = 4 << 20

// maxErrorBody caps the backend body copied into an error message.
const maxErrorBody = 300

// TokenMinter mints the short-lived bearer token for one caller.
type TokenMinter func(tenantctx.Tenant) (string, error)

// ErrNoCaller is returned when the context carries no authenticated caller.
// Background investigations and flows start from context.Background() and
// therefore cannot call CMDB tools yet: fail-closed is the P0 contract.
var ErrNoCaller = errors.New("cmdb: interactive caller identity required; background investigations and workflows cannot call CMDB tools yet")

// APIError is a non-2xx reply from cmdb-api. It keeps the status and a short
// body excerpt so the model can correct the request instead of guessing.
type APIError struct {
	Status int
	Body   string
}

func (e *APIError) Error() string {
	switch {
	case e.Status == http.StatusBadRequest:
		return fmt.Sprintf("cmdb: request rejected: %s", e.Body)
	case e.Status == http.StatusUnauthorized:
		return fmt.Sprintf("cmdb: caller credential rejected; the session may have expired: %s", e.Body)
	case e.Status == http.StatusForbidden:
		return fmt.Sprintf("cmdb: caller is not allowed to perform this operation: %s", e.Body)
	case e.Status == http.StatusNotFound:
		return fmt.Sprintf("cmdb: resource not found: %s", e.Body)
	case e.Status >= 500:
		return fmt.Sprintf("cmdb: unavailable (status %d): %s", e.Status, e.Body)
	default:
		return fmt.Sprintf("cmdb: request failed (status %d): %s", e.Status, e.Body)
	}
}

// Client is the HTTP surface the CMDB tools use. Safe for concurrent use.
type Client struct {
	baseURL string
	minter  TokenMinter
	http    *http.Client
	log     *slog.Logger
}

// New builds a client for the CMDB service root (e.g.
// http://ongrid-cmdb:8082). It returns nil when the deployment has not
// configured CMDB: the registry treats a nil client as "tools off".
func New(baseURL string, minter TokenMinter, hc *http.Client, log *slog.Logger) *Client {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" || minter == nil {
		return nil
	}
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	if log == nil {
		log = slog.Default()
	}
	return &Client{baseURL: baseURL, minter: minter, http: hc, log: log}
}

// NewSignerMinter adapts the manager's JWT signer to a TokenMinter. The
// claims are the caller's own identity, so cmdb-api's audit attributes the
// operation to the person who asked, not to a service account.
func NewSignerMinter(s *auth.Signer, ttl time.Duration) TokenMinter {
	return func(t tenantctx.Tenant) (string, error) {
		if s == nil {
			return "", errors.New("cmdb: signer not configured")
		}
		return s.SignWithTTL(auth.Claims{
			UserID:      t.UserID,
			Email:       t.Email,
			Role:        t.Role,
			IsSuperuser: t.IsSuperuser,
		}, ttl)
	}
}

// Get performs one GET against path (relative to /api/v1/cmdb).
func (c *Client) Get(ctx context.Context, path string, query url.Values) (json.RawMessage, error) {
	return c.do(ctx, http.MethodGet, path, query, nil)
}

// Post performs one POST against path (relative to /api/v1/cmdb).
func (c *Client) Post(ctx context.Context, path string, body any) (json.RawMessage, error) {
	return c.do(ctx, http.MethodPost, path, nil, body)
}

func (c *Client) do(ctx context.Context, method, path string, query url.Values, body any) (json.RawMessage, error) {
	if c == nil {
		return nil, errors.New("cmdb: client not configured")
	}
	tenant, ok := tenantctx.From(ctx)
	if !ok {
		return nil, ErrNoCaller
	}
	token, err := c.minter(tenant)
	if err != nil {
		return nil, fmt.Errorf("cmdb: mint caller token: %w", err)
	}

	endpoint := c.baseURL + apiPrefix + path
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}

	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("cmdb: encode request body: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, fmt.Errorf("cmdb: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("cmdb: request failed: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("cmdb: read response: %w", err)
	}
	if resp.StatusCode >= http.StatusBadRequest {
		return nil, &APIError{Status: resp.StatusCode, Body: excerpt(data)}
	}
	if !json.Valid(data) {
		return nil, errors.New("cmdb: response is not valid JSON")
	}
	return json.RawMessage(data), nil
}

func excerpt(data []byte) string {
	s := strings.TrimSpace(string(data))
	if len(s) > maxErrorBody {
		s = s[:maxErrorBody] + "…"
	}
	return s
}
