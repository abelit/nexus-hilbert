// Package fedclient is the transport for the "federated sources" feature:
// read-only queries against an external alert/ITSM database exposed over HTTP.
//
// It is deliberately BC-agnostic and depends only on the standard library, so
// it can be unit-tested without a manager stack and reused by any bounded
// context. It owns URL composition, auth headers, the {status,message,data}
// envelope, page caps, response-size limits and credential scrubbing. It does
// not own storage, configuration validation or item interpretation.
package fedclient

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	defaultTimeout     = 15 * time.Second
	minTimeout         = time.Second
	maxTimeout         = 60 * time.Second
	defaultPageSizeCap = 500
	maxResponseBytes   = 8 << 20
	minSecretLen       = 3
)

// AuthData is the credential material decrypted from a connection. It is
// never logged or returned in a response.
type AuthData struct {
	Token    string
	Username string
	Password string
}

// Config is one connection's transport configuration. The caller validates
// and stores it; New validates the parts that would otherwise produce an
// unusable URL or an unsupported request.
type Config struct {
	BaseURL      string
	APIPath      string
	Method       string // GET (default) or POST
	FixedParams  map[string][]string
	AuthType     string // none | bearer | basic
	Auth         AuthData
	Timeout      time.Duration
	PageSizeCap  int
	DefaultTable string
}

// Query is one page request. Dates and Days are mutually exclusive in the
// upstream vocabulary; when either date bound is present, Days is not sent.
type Query struct {
	Table     string
	StartDate string
	EndDate   string
	Days      int
	Filters   []string
	OrFilters []string
	Page      int
	PageSize  int
}

// Page is the normalized upstream data block. Items stay raw because the
// upstream documents are freeform and differ by deployment.
type Page struct {
	Table     string            `json:"table,omitempty"`
	TimeRange string            `json:"time_range,omitempty"`
	Total     int               `json:"total"`
	Page      int               `json:"page"`
	PageSize  int               `json:"page_size"`
	Pages     int               `json:"pages"`
	Items     []json.RawMessage `json:"items"`
	Filters   json.RawMessage   `json:"filters,omitempty"`
}

// UpstreamError is a non-2xx reply or a non-success envelope. Message is
// already scrubbed of credential material.
type UpstreamError struct {
	Status  int
	Message string
}

func (e *UpstreamError) Error() string {
	if e.Status > 0 {
		return fmt.Sprintf("upstream status %d: %s", e.Status, e.Message)
	}
	return "upstream: " + e.Message
}

// Client is safe for concurrent use.
type Client struct {
	baseURL      string
	apiPath      string
	method       string
	fixed        map[string][]string
	authType     string
	auth         AuthData
	pageSizeCap  int
	defaultTable string
	http         *http.Client
	timeout      time.Duration
}

// New validates the endpoint and builds a client. BaseURL and APIPath are
// required: a host without a path is not an endpoint, and a path without a
// host is not reachable.
func New(cfg Config) (*Client, error) {
	base := strings.TrimSpace(cfg.BaseURL)
	if base == "" {
		return nil, errors.New("fedclient: base url is required")
	}
	parsed, err := url.Parse(base)
	if err != nil {
		return nil, fmt.Errorf("fedclient: base url: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("fedclient: base url must be http or https")
	}
	if parsed.Host == "" {
		return nil, errors.New("fedclient: base url has no host")
	}
	if parsed.User != nil {
		return nil, errors.New("fedclient: base url must not carry credentials")
	}

	apiPath := strings.TrimSpace(cfg.APIPath)
	if apiPath == "" {
		return nil, errors.New("fedclient: api path is required")
	}
	if !strings.HasPrefix(apiPath, "/") {
		return nil, errors.New("fedclient: api path must start with /")
	}

	method := strings.ToUpper(strings.TrimSpace(cfg.Method))
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet && method != http.MethodPost {
		return nil, fmt.Errorf("fedclient: unsupported method %q", method)
	}

	authType := strings.ToLower(strings.TrimSpace(cfg.AuthType))
	if authType == "" {
		authType = "none"
	}
	switch authType {
	case "none", "bearer", "basic":
	default:
		return nil, fmt.Errorf("fedclient: unsupported auth type %q", authType)
	}

	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	if timeout < minTimeout {
		timeout = minTimeout
	}
	if timeout > maxTimeout {
		timeout = maxTimeout
	}

	cap := cfg.PageSizeCap
	if cap <= 0 {
		cap = defaultPageSizeCap
	}

	table := strings.TrimSpace(cfg.DefaultTable)
	if table == "" {
		table = "alert_instances"
	}

	return &Client{
		baseURL:      strings.TrimRight(base, "/"),
		apiPath:      apiPath,
		method:       method,
		fixed:        cloneParams(cfg.FixedParams),
		authType:     authType,
		auth:         cfg.Auth,
		pageSizeCap:  cap,
		defaultTable: table,
		http:         &http.Client{Timeout: timeout},
		timeout:      timeout,
	}, nil
}

// Query fetches one page. The returned Page echoes the effective page and
// page_size, so callers can paginate honestly.
func (c *Client) Query(ctx context.Context, q Query) (*Page, error) {
	page, size := normalizePage(q.Page, q.PageSize, c.pageSizeCap)
	pairs := c.buildPairs(q, page, size)
	data, err := c.do(ctx, c.method, pairs)
	if err != nil {
		return nil, err
	}
	return decodePage(data, page, size)
}

// Probe asks one cheap GET question. It never uses the configured method: a
// probe must not write to a POST-capable endpoint, and a POST-only endpoint
// reporting unhealthy is honest and visible.
func (c *Client) Probe(ctx context.Context) error {
	pairs := c.buildPairs(Query{Days: 1}, 1, 1)
	if _, err := c.do(ctx, http.MethodGet, pairs); err != nil {
		return err
	}
	return nil
}

func normalizePage(page, size, cap int) (int, int) {
	if page < 1 {
		page = 1
	}
	if size < 1 {
		size = 50
	}
	if size > cap {
		size = cap
	}
	return page, size
}

func (c *Client) buildPairs(q Query, page, size int) map[string][]string {
	pairs := map[string][]string{}
	add := func(key, value string) {
		if value != "" {
			pairs[key] = append(pairs[key], value)
		}
	}

	table := q.Table
	if table == "" {
		table = c.defaultTable
	}
	add("table", table)
	add("page", fmt.Sprint(page))
	add("page_size", fmt.Sprint(size))

	if q.StartDate != "" || q.EndDate != "" {
		add("start_date", q.StartDate)
		add("end_date", q.EndDate)
	} else {
		days := q.Days
		if days < 1 {
			days = 7
		}
		add("days", fmt.Sprint(days))
	}
	for _, f := range q.Filters {
		if f != "" {
			pairs["filter"] = append(pairs["filter"], f)
		}
	}
	for _, f := range q.OrFilters {
		if f != "" {
			pairs["or_filter"] = append(pairs["or_filter"], f)
		}
	}

	// Fixed parameters are the operator's hard constraint: they are always
	// sent and they win over a dynamic parameter of the same name.
	for key, values := range c.fixed {
		pairs[key] = append([]string(nil), values...)
	}
	return pairs
}

func (c *Client) do(ctx context.Context, method string, pairs map[string][]string) (json.RawMessage, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, c.timeout)
		defer cancel()
	}

	endpoint := c.baseURL + c.apiPath
	var body io.Reader
	var rawURL string
	if method == http.MethodPost {
		encoded, err := json.Marshal(jsonBody(pairs))
		if err != nil {
			return nil, fmt.Errorf("fedclient: encode body: %w", err)
		}
		body = bytes.NewReader(encoded)
		rawURL = endpoint
	} else {
		values := url.Values{}
		for key, list := range pairs {
			for _, value := range list {
				values.Add(key, value)
			}
		}
		rawURL = endpoint + "?" + values.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, method, rawURL, body)
	if err != nil {
		return nil, fmt.Errorf("fedclient: build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if method == http.MethodPost {
		req.Header.Set("Content-Type", "application/json")
	}
	switch c.authType {
	case "bearer":
		if c.auth.Token != "" {
			req.Header.Set("Authorization", "Bearer "+cleanSecret(c.auth.Token))
		}
	case "basic":
		if c.auth.Username != "" || c.auth.Password != "" {
			blob := base64.StdEncoding.EncodeToString([]byte(cleanSecret(c.auth.Username) + ":" + cleanSecret(c.auth.Password)))
			req.Header.Set("Authorization", "Basic "+blob)
		}
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &UpstreamError{Message: Scrub(err.Error(), c.auth)}
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return nil, &UpstreamError{Status: resp.StatusCode, Message: Scrub(err.Error(), c.auth)}
	}
	if len(raw) > maxResponseBytes {
		return nil, &UpstreamError{Status: resp.StatusCode, Message: "response exceeds 8 MiB"}
	}
	if resp.StatusCode >= http.StatusBadRequest {
		return nil, &UpstreamError{
			Status:  resp.StatusCode,
			Message: Scrub(excerpt(raw), c.auth),
		}
	}

	var envelope struct {
		Status  string          `json:"status"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, &UpstreamError{Status: resp.StatusCode, Message: "response is not valid JSON"}
	}
	if envelope.Status != "success" {
		msg := strings.TrimSpace(envelope.Message)
		if msg == "" {
			msg = "upstream returned status " + envelope.Status
		}
		return nil, &UpstreamError{Status: resp.StatusCode, Message: Scrub(msg, c.auth)}
	}
	if len(envelope.Data) == 0 || bytes.Equal(envelope.Data, []byte("null")) {
		return json.RawMessage(`{}`), nil
	}
	return envelope.Data, nil
}

func decodePage(data json.RawMessage, page, size int) (*Page, error) {
	var wire struct {
		Table      string            `json:"table"`
		TimeRange  string            `json:"time_range"`
		Total      int               `json:"total"`
		Page       int               `json:"page"`
		PageSize   int               `json:"page_size"`
		Pages      int               `json:"pages"`
		TotalPages int               `json:"total_pages"`
		Items      []json.RawMessage `json:"items"`
		Filters    json.RawMessage   `json:"filters"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return nil, &UpstreamError{Message: "upstream data is not an object"}
	}
	out := &Page{
		Table:     wire.Table,
		TimeRange: wire.TimeRange,
		Total:     wire.Total,
		Page:      wire.Page,
		PageSize:  wire.PageSize,
		Pages:     wire.Pages,
		Items:     wire.Items,
		Filters:   wire.Filters,
	}
	if out.Page < 1 {
		out.Page = page
	}
	if out.PageSize < 1 {
		out.PageSize = size
	}
	if out.Pages < 0 {
		out.Pages = 0
	}
	if out.Pages == 0 && wire.TotalPages > 0 {
		out.Pages = wire.TotalPages
	}
	if out.Items == nil {
		out.Items = []json.RawMessage{}
	}
	return out, nil
}

// Scrub removes credential material from a message that may reach a caller.
// Raw and control-stripped forms are both replaced, plus the Basic auth blob
// (the same secret in another encoding).
func Scrub(text string, auth AuthData) string {
	out := text
	for _, secret := range []string{auth.Token, auth.Password} {
		if len(secret) < minSecretLen {
			continue
		}
		out = strings.ReplaceAll(out, secret, "******")
		cleaned := cleanSecret(secret)
		if cleaned != secret && len(cleaned) >= minSecretLen {
			out = strings.ReplaceAll(out, cleaned, "******")
		}
	}
	if auth.Username != "" || auth.Password != "" {
		blob := base64.StdEncoding.EncodeToString([]byte(cleanSecret(auth.Username) + ":" + cleanSecret(auth.Password)))
		if len(blob) >= minSecretLen {
			out = strings.ReplaceAll(out, blob, "******")
		}
	}
	return out
}

func cleanSecret(value string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, value))
}

func cloneParams(in map[string][]string) map[string][]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string][]string, len(in))
	for key, values := range in {
		out[key] = append([]string(nil), values...)
	}
	return out
}

func jsonBody(pairs map[string][]string) map[string]any {
	out := make(map[string]any, len(pairs))
	for key, values := range pairs {
		switch len(values) {
		case 0:
			continue
		case 1:
			out[key] = values[0]
		default:
			out[key] = append([]string(nil), values...)
		}
	}
	return out
}

func excerpt(raw []byte) string {
	const limit = 300
	text := strings.TrimSpace(string(raw))
	if text == "" {
		return "upstream returned an empty error body"
	}
	if len(text) > limit {
		text = text[:limit] + "…"
	}
	return text
}
