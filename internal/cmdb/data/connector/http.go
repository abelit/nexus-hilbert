// Package connector implements the topocortex HTTP target for the CMDB
// ontology projection. It is deliberately small: the API contract is in
// docs/api_spec.md, and the apply ordering/preflight lives in biz/connector.
package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	bizconnector "github.com/ongridio/ongrid/internal/cmdb/biz/connector"
)

const maxResponseBytes = 1 << 20

// Client is the topocortex ontology API target.
type Client struct {
	baseURL string
	http    *http.Client
}

var _ bizconnector.Target = (*Client)(nil)

// New builds a client around a topocortex service root, e.g.
// http://nexus-topocortex:8080. A nil http.Client gets a 30-second timeout.
func New(baseURL string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	return &Client{baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"), http: httpClient}
}

// EnsureRelationDeclaration creates the declaration when it is absent and
// updates its cardinality/propagation when it exists. It returns created=true
// only for the POST path.
func (c *Client) EnsureRelationDeclaration(ctx context.Context, decl bizconnector.Declaration) (bool, error) {
	if err := c.ready(); err != nil {
		return false, err
	}
	path := fmt.Sprintf("/api/v1/ontology/relations/%s/%s/%s",
		url.PathEscape(decl.RelationType),
		url.PathEscape(decl.SourceClass),
		url.PathEscape(decl.TargetClass))

	status, body, err := c.do(ctx, http.MethodGet, path, nil)
	if err != nil {
		return false, err
	}
	switch status {
	case http.StatusOK:
		patch := map[string]any{"propagates": decl.Propagates}
		if decl.Cardinality != "" {
			patch["cardinality"] = decl.Cardinality
		}
		if decl.Propagates && decl.Weight > 0 {
			patch["weight"] = decl.Weight
		}
		if err := c.doJSON(ctx, http.MethodPatch, path, patch, http.StatusOK); err != nil {
			return false, err
		}
		return false, nil
	case http.StatusNotFound:
		create := map[string]any{
			"relation_type":  decl.RelationType,
			"source_class":   decl.SourceClass,
			"target_class":   decl.TargetClass,
			"propagates":     decl.Propagates,
			"allow_new_type": true,
		}
		if decl.Cardinality != "" {
			create["cardinality"] = decl.Cardinality
		}
		if decl.Propagates && decl.Weight > 0 {
			create["weight"] = decl.Weight
		}
		if err := c.doJSON(ctx, http.MethodPost, "/api/v1/ontology/relations", create,
			http.StatusOK, http.StatusCreated); err != nil {
			return false, err
		}
		return true, nil
	default:
		return false, responseError(http.MethodGet, path, status, body)
	}
}

// EnsureRelationType patches the type contract after at least one declaration
// exists. It never creates a type on its own: topocortex creates the type as a
// side effect of the declaration.
func (c *Client) EnsureRelationType(ctx context.Context, typ bizconnector.RelationType) error {
	if err := c.ready(); err != nil {
		return err
	}
	traits := typ.Traits
	if traits == nil {
		traits = []string{}
	}
	subProperties := typ.SubPropertyOf
	if subProperties == nil {
		subProperties = []string{}
	}
	body := map[string]any{
		"category":        typ.Category,
		"traits":          traits,
		"transitive":      typ.Transitive,
		"sub_property_of": subProperties,
	}
	path := "/api/v1/ontology/relation-types/" + url.PathEscape(typ.Name)
	return c.doJSON(ctx, http.MethodPatch, path, body, http.StatusOK)
}

func (c *Client) ready() error {
	if c == nil || c.baseURL == "" {
		return fmt.Errorf("topocortex connector: base URL is empty")
	}
	return nil
}

func (c *Client) doJSON(ctx context.Context, method, path string, payload any, accepted ...int) error {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("topocortex connector: encode %s %s: %w", method, path, err)
		}
		body = bytes.NewReader(encoded)
	}
	status, responseBody, err := c.do(ctx, method, path, body)
	if err != nil {
		return err
	}
	for _, want := range accepted {
		if status == want {
			return nil
		}
	}
	return responseError(method, path, status, responseBody)
}

func (c *Client) do(ctx context.Context, method, path string, body io.Reader) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return 0, nil, fmt.Errorf("topocortex connector: build %s %s: %w", method, path, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("topocortex connector: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return 0, nil, fmt.Errorf("topocortex connector: read %s %s: %w", method, path, err)
	}
	return resp.StatusCode, responseBody, nil
}

func responseError(method, path string, status int, body []byte) error {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return fmt.Errorf("topocortex connector: %s %s: status %d", method, path, status)
	}
	return fmt.Errorf("topocortex connector: %s %s: status %d: %s", method, path, status, text)
}
