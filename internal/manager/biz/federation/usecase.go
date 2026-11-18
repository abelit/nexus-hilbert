package federation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	model "github.com/ongridio/ongrid/internal/manager/model/federation"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// ErrWeakSecret is returned when a credential would be stored under a weak
// secret-box key (the development fallback). Refusing is safer than storing
// something that only looks encrypted.
var ErrWeakSecret = errors.New("federation: refusing to store a credential without a strong ONGRID_SECRET_KEY")

// Crypto is the at-rest encryption seam. cmd/ongrid injects secretbox.
type Crypto interface {
	Encrypt(plain string) (string, error)
	Decrypt(cipher string) (string, error)
	Weak() bool
}

// ConnectionInput is the write-side shape. Pointer fields distinguish an
// absent value (keep the default / stored value) from an explicit zero.
type ConnectionInput struct {
	Kind            string
	Name            string
	BaseURL         string
	APIPath         string
	Method          string
	FixedParams     map[string][]string
	AuthType        string
	Auth            *Credentials
	DefaultDays     int
	DefaultPageSize int
	TimeoutSeconds  int
	IsDefault       *bool
	Enabled         *bool
	Remark          string
}

// ConnectionView is the read-side shape. It never carries plaintext or
// ciphertext credentials.
type ConnectionView struct {
	ID              uint64              `json:"id"`
	Kind            string              `json:"kind"`
	Name            string              `json:"name"`
	BaseURL         string              `json:"base_url"`
	APIPath         string              `json:"api_path"`
	Method          string              `json:"method"`
	FixedParams     map[string][]string `json:"fixed_params,omitempty"`
	AuthType        string              `json:"auth_type"`
	TokenSet        bool                `json:"token_set"`
	Username        string              `json:"username,omitempty"`
	PasswordSet     bool                `json:"password_set"`
	DefaultDays     int                 `json:"default_days"`
	DefaultPageSize int                 `json:"default_page_size"`
	TimeoutSeconds  int                 `json:"timeout_seconds"`
	IsDefault       bool                `json:"is_default"`
	Enabled         bool                `json:"enabled"`
	Remark          string              `json:"remark,omitempty"`
	CreatedAt       time.Time           `json:"created_at"`
	UpdatedAt       time.Time           `json:"updated_at"`
}

type HealthRow struct {
	ID    uint64 `json:"id"`
	Name  string `json:"name"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

type ListRequest struct {
	ConnectionID uint64
	Days         int
	StartDate    string
	EndDate      string
	Status       string
	Severity     string
	Keyword      string
	Page         int
	PageSize     int
}

type ListResult struct {
	Kind       string            `json:"kind"`
	Configured bool              `json:"configured"`
	Reason     string            `json:"reason,omitempty"`
	Table      string            `json:"table,omitempty"`
	TimeRange  string            `json:"time_range,omitempty"`
	Total      int               `json:"total"`
	Page       int               `json:"page"`
	PageSize   int               `json:"page_size"`
	Pages      int               `json:"pages"`
	Items      []json.RawMessage `json:"items"`
	Filters    json.RawMessage   `json:"filters,omitempty"`
	Scope      string            `json:"scope,omitempty"`
	Identity   string            `json:"identity,omitempty"`
}

type Usecase struct {
	repo       Repository
	querier    SourceQuerier
	crypto     Crypto
	identities ViewerIdentityResolver
	cmdb       CMDBReader
	cache      *ttlCache
	log        *slog.Logger
}

func NewUsecase(repo Repository, querier SourceQuerier, crypto Crypto, log *slog.Logger) *Usecase {
	if log == nil {
		log = slog.Default()
	}
	return &Usecase{repo: repo, querier: querier, crypto: crypto, cache: newTTLCache(), log: log}
}

func (u *Usecase) CreateConnection(ctx context.Context, in ConnectionInput, callerID uint64) (*ConnectionView, error) {
	normalized, _, err := normalizeConnection(in, nil)
	if err != nil {
		return nil, err
	}
	cipher, err := u.seal(normalized, nil)
	if err != nil {
		return nil, err
	}
	conn := &model.Connection{
		Kind:            normalized.Kind,
		Name:            normalized.Name,
		BaseURL:         normalized.BaseURL,
		APIPath:         normalized.APIPath,
		Method:          normalized.Method,
		FixedParamsJSON: normalized.fixedJSON,
		AuthType:        normalized.AuthType,
		AuthCipher:      cipher,
		DefaultDays:     normalized.DefaultDays,
		DefaultPageSize: normalized.DefaultPageSize,
		TimeoutSeconds:  normalized.TimeoutSeconds,
		IsDefault:       boolValue(normalized.IsDefault, false),
		Enabled:         boolValue(normalized.Enabled, true),
		Remark:          normalized.Remark,
		CreatedBy:       callerID,
	}
	if err := u.repo.CreateConnection(ctx, conn); err != nil {
		return nil, err
	}
	if conn.IsDefault {
		if err := u.repo.ClearDefaultConnection(ctx, conn.Kind, conn.ID); err != nil {
			return nil, err
		}
	}
	return u.view(conn), nil
}

func (u *Usecase) UpdateConnection(ctx context.Context, id uint64, in ConnectionInput) (*ConnectionView, error) {
	existing, err := u.repo.GetConnection(ctx, id)
	if err != nil {
		return nil, err
	}
	normalized, _, err := normalizeConnection(in, existing)
	if err != nil {
		return nil, err
	}
	cipher, err := u.seal(normalized, existing)
	if err != nil {
		return nil, err
	}
	existing.Name = normalized.Name
	existing.BaseURL = normalized.BaseURL
	existing.APIPath = normalized.APIPath
	existing.Method = normalized.Method
	existing.FixedParamsJSON = normalized.fixedJSON
	existing.AuthType = normalized.AuthType
	existing.AuthCipher = cipher
	existing.DefaultDays = normalized.DefaultDays
	existing.DefaultPageSize = normalized.DefaultPageSize
	existing.TimeoutSeconds = normalized.TimeoutSeconds
	existing.IsDefault = boolValue(normalized.IsDefault, existing.IsDefault)
	existing.Enabled = boolValue(normalized.Enabled, existing.Enabled)
	existing.Remark = normalized.Remark

	if err := u.repo.UpdateConnection(ctx, existing); err != nil {
		return nil, err
	}
	if existing.IsDefault {
		if err := u.repo.ClearDefaultConnection(ctx, existing.Kind, existing.ID); err != nil {
			return nil, err
		}
	}
	return u.view(existing), nil
}

func (u *Usecase) DeleteConnection(ctx context.Context, id uint64, cascade bool) error {
	return u.repo.DeleteConnection(ctx, id, cascade)
}

func (u *Usecase) ListConnections(ctx context.Context, kind string) ([]ConnectionView, error) {
	if !ValidKind(kind) {
		return nil, fmt.Errorf("%w: kind %q", errs.ErrInvalid, kind)
	}
	rows, err := u.repo.ListConnections(ctx, kind)
	if err != nil {
		return nil, err
	}
	out := make([]ConnectionView, 0, len(rows))
	for i := range rows {
		out = append(out, *u.view(&rows[i]))
	}
	return out, nil
}

func (u *Usecase) GetConnection(ctx context.Context, id uint64) (*ConnectionView, error) {
	row, err := u.repo.GetConnection(ctx, id)
	if err != nil {
		return nil, err
	}
	return u.view(row), nil
}

// RevealCredentials returns the plaintext for an administrator's edit form.
func (u *Usecase) RevealCredentials(ctx context.Context, id uint64) (*Credentials, error) {
	row, err := u.repo.GetConnection(ctx, id)
	if err != nil {
		return nil, err
	}
	creds, err := u.open(row.AuthCipher, row.ID)
	if err != nil {
		return nil, err
	}
	return &creds, nil
}

func (u *Usecase) TestConnection(ctx context.Context, in ConnectionInput) error {
	normalized, profile, err := normalizeConnection(in, nil)
	if err != nil {
		return err
	}
	creds := Credentials{}
	if normalized.Auth != nil {
		creds = *normalized.Auth
	}
	return u.querier.Probe(ctx, ProbeConfig{
		Kind:           normalized.Kind,
		BaseURL:        normalized.BaseURL,
		APIPath:        normalized.APIPath,
		Method:         normalized.Method,
		FixedParams:    normalized.FixedParams,
		AuthType:       normalized.AuthType,
		Credentials:    creds,
		TimeoutSeconds: normalized.TimeoutSeconds,
		MaxPageSize:    profile.MaxPageSize,
		DefaultTable:   profile.DefaultTable,
	})
}

func (u *Usecase) TestSavedConnection(ctx context.Context, id uint64) error {
	row, err := u.repo.GetConnection(ctx, id)
	if err != nil {
		return err
	}
	creds, err := u.open(row.AuthCipher, row.ID)
	if err != nil {
		return err
	}
	fixed, _ := parseFixed(row.FixedParamsJSON)
	profile, _ := Profile(row.Kind)
	return u.querier.Probe(ctx, ProbeConfig{
		Kind:           row.Kind,
		BaseURL:        row.BaseURL,
		APIPath:        row.APIPath,
		Method:         row.Method,
		FixedParams:    fixed,
		AuthType:       row.AuthType,
		Credentials:    creds,
		TimeoutSeconds: row.TimeoutSeconds,
		MaxPageSize:    profile.MaxPageSize,
		DefaultTable:   profile.DefaultTable,
	})
}

// ConnectionHealth probes every enabled connection for kind. A probe failure
// is a row, not an endpoint failure.
func (u *Usecase) ConnectionHealth(ctx context.Context, kind string) ([]HealthRow, error) {
	if !ValidKind(kind) {
		return nil, fmt.Errorf("%w: kind %q", errs.ErrInvalid, kind)
	}
	rows, err := u.repo.ListConnections(ctx, kind)
	if err != nil {
		return nil, err
	}
	out := make([]HealthRow, 0, len(rows))
	for i := range rows {
		row := &rows[i]
		if !row.Enabled {
			// Disabled is a configuration choice, not an unhealthy upstream.
			// The connections table renders "—" for a missing health row.
			continue
		}
		health := HealthRow{ID: row.ID, Name: row.Name}
		probeCtx, cancel := context.WithTimeout(ctx, probeTimeout(row.TimeoutSeconds))
		err := u.TestSavedConnection(probeCtx, row.ID)
		cancel()
		if err != nil {
			health.Error = err.Error()
		} else {
			health.OK = true
		}
		out = append(out, health)
	}
	return out, nil
}

// ListItems runs one read-only fleet query. It never queries without a
// configured connection and never turns an upstream failure into an empty
// page.
func (u *Usecase) ListItems(ctx context.Context, kind string, req ListRequest) (*ListResult, error) {
	profile, ok := Profile(kind)
	if !ok {
		return nil, fmt.Errorf("%w: kind %q", errs.ErrInvalid, kind)
	}
	conn, err := u.pickConnection(ctx, kind, req.ConnectionID)
	if err != nil {
		return nil, err
	}
	if conn == nil {
		return &ListResult{Kind: kind, Configured: false, Reason: "not_configured", Items: []json.RawMessage{}}, nil
	}

	page, size := normalizeListPage(req.Page, req.PageSize, profile)
	days := req.Days
	if days < 1 {
		days = profile.DefaultDays
	}
	filters := buildListFilters(profile, req)

	// Fleet queries are shared across viewers, so a short TTL absorbs
	// repeated page loads and badge polls. The per-viewer lens is a
	// different method and is never cached.
	cacheKey := fmt.Sprintf("list|%s|%d|%s|%s|%d|%d|%d|%s|%s|%s",
		kind, conn.ID, req.StartDate, req.EndDate, days, page, size, req.Status, req.Severity, req.Keyword)
	if cached, ok := u.cache.get(cacheKey); ok {
		if result, ok := cached.(*ListResult); ok {
			return result, nil
		}
	}

	got, err := u.querier.Query(ctx, conn, QueryRequest{
		Table:     profile.DefaultTable,
		StartDate: req.StartDate,
		EndDate:   req.EndDate,
		Days:      days,
		Page:      page,
		PageSize:  size,
		Filters:   filters,
	})
	if err != nil {
		return nil, err
	}
	result := &ListResult{
		Kind:       kind,
		Configured: true,
		Table:      got.Table,
		TimeRange:  got.TimeRange,
		Total:      got.Total,
		Page:       got.Page,
		PageSize:   got.PageSize,
		Pages:      got.Pages,
		Items:      got.Items,
		Filters:    got.Filters,
	}
	u.cache.set(cacheKey, result, 15*time.Second)
	return result, nil
}

func (u *Usecase) pickConnection(ctx context.Context, kind string, id uint64) (*model.Connection, error) {
	if id > 0 {
		conn, err := u.repo.GetConnection(ctx, id)
		if err != nil {
			return nil, err
		}
		if conn.Kind != kind || !conn.Enabled {
			return nil, fmt.Errorf("%w: connection %d is not an enabled %s source", errs.ErrNotFound, id, kind)
		}
		return conn, nil
	}
	rows, err := u.repo.ListConnections(ctx, kind)
	if err != nil {
		return nil, err
	}
	var first *model.Connection
	for i := range rows {
		if !rows[i].Enabled {
			continue
		}
		if rows[i].IsDefault {
			return &rows[i], nil
		}
		if first == nil {
			first = &rows[i]
		}
	}
	return first, nil
}

func buildListFilters(profile SourceProfile, req ListRequest) []string {
	filters := make([]string, 0, 3)
	if req.Status != "" && profile.StatusField != "" {
		filters = append(filters, Expr(profile.StatusField, OpEq, req.Status))
	}
	if req.Severity != "" && profile.SeverityField != "" {
		filters = append(filters, Expr(profile.SeverityField, OpEq, req.Severity))
	}
	if req.Keyword != "" && profile.KeywordField != "" {
		filters = append(filters, Expr(profile.KeywordField, OpRegex, req.Keyword))
	}
	return filters
}

func normalizeListPage(page, size int, profile SourceProfile) (int, int) {
	if page < 1 {
		page = 1
	}
	if size < 1 {
		size = profile.DefaultPageSize
	}
	if size > profile.MaxPageSize {
		size = profile.MaxPageSize
	}
	return page, size
}

type normalizedConnection struct {
	ConnectionInput
	fixedJSON string
}

func normalizeConnection(in ConnectionInput, existing *model.Connection) (normalizedConnection, SourceProfile, error) {
	kind := strings.TrimSpace(in.Kind)
	if existing != nil && kind != "" && kind != existing.Kind {
		// Changing kind would orphan the connection's CI mappings, which are
		// keyed by (kind, connection_id). Create a new connection instead.
		return normalizedConnection{}, SourceProfile{}, fmt.Errorf("%w: connection kind cannot change", errs.ErrInvalid)
	}
	if kind == "" && existing != nil {
		kind = existing.Kind
	}
	profile, ok := Profile(kind)
	if !ok {
		return normalizedConnection{}, SourceProfile{}, fmt.Errorf("%w: kind %q", errs.ErrInvalid, kind)
	}

	name := strings.TrimSpace(in.Name)
	if name == "" || len(name) > 128 {
		return normalizedConnection{}, SourceProfile{}, fmt.Errorf("%w: connection name is required (max 128)", errs.ErrInvalid)
	}

	base, err := normalizeBaseURL(in.BaseURL)
	if err != nil {
		return normalizedConnection{}, SourceProfile{}, err
	}
	apiPath := strings.TrimSpace(in.APIPath)
	if !strings.HasPrefix(apiPath, "/") || len(apiPath) > 512 {
		return normalizedConnection{}, SourceProfile{}, fmt.Errorf("%w: api path must start with /", errs.ErrInvalid)
	}
	if strings.ContainsAny(apiPath, "?# \t\r\n") {
		return normalizedConnection{}, SourceProfile{}, fmt.Errorf("%w: api path must be a plain path (no query, fragment or whitespace)", errs.ErrInvalid)
	}
	method := strings.ToUpper(strings.TrimSpace(in.Method))
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet && method != http.MethodPost {
		return normalizedConnection{}, SourceProfile{}, fmt.Errorf("%w: method %q", errs.ErrInvalid, method)
	}
	authType := strings.ToLower(strings.TrimSpace(in.AuthType))
	if authType == "" {
		// An update that omits auth_type must keep the stored scheme, not
		// silently become "none" and clear the credential.
		if existing != nil && existing.AuthType != "" {
			authType = existing.AuthType
		} else {
			authType = "none"
		}
	}
	hasStoredCredential := existing != nil && existing.AuthCipher != ""
	switch authType {
	case "none":
		if in.Auth != nil && (in.Auth.Token != "" || in.Auth.Username != "" || in.Auth.Password != "") {
			return normalizedConnection{}, SourceProfile{}, fmt.Errorf("%w: auth_type none cannot carry credentials", errs.ErrInvalid)
		}
	case "bearer":
		if in.Auth != nil && strings.TrimSpace(in.Auth.Token) == "" {
			return normalizedConnection{}, SourceProfile{}, fmt.Errorf("%w: bearer auth requires a token", errs.ErrInvalid)
		}
		if in.Auth == nil && !hasStoredCredential {
			return normalizedConnection{}, SourceProfile{}, fmt.Errorf("%w: bearer auth requires a token", errs.ErrInvalid)
		}
	case "basic":
		if in.Auth != nil && strings.TrimSpace(in.Auth.Username) == "" && strings.TrimSpace(in.Auth.Password) == "" {
			return normalizedConnection{}, SourceProfile{}, fmt.Errorf("%w: basic auth requires a username or password", errs.ErrInvalid)
		}
		if in.Auth == nil && !hasStoredCredential {
			return normalizedConnection{}, SourceProfile{}, fmt.Errorf("%w: basic auth requires a username or password", errs.ErrInvalid)
		}
	default:
		return normalizedConnection{}, SourceProfile{}, fmt.Errorf("%w: auth_type %q", errs.ErrInvalid, authType)
	}

	fixedJSON, err := marshalFixed(in.FixedParams)
	if err != nil {
		return normalizedConnection{}, SourceProfile{}, err
	}

	days := in.DefaultDays
	if days < 1 {
		days = profile.DefaultDays
	}
	if days > 366 {
		days = 366
	}
	pageSize := in.DefaultPageSize
	if pageSize < 1 {
		pageSize = profile.DefaultPageSize
	}
	if pageSize > profile.MaxPageSize {
		pageSize = profile.MaxPageSize
	}
	timeout := in.TimeoutSeconds
	if timeout < 1 {
		timeout = 15
	}
	if timeout > 60 {
		timeout = 60
	}

	return normalizedConnection{
		ConnectionInput: ConnectionInput{
			Kind:            kind,
			Name:            name,
			BaseURL:         base,
			APIPath:         apiPath,
			Method:          method,
			FixedParams:     in.FixedParams,
			AuthType:        authType,
			Auth:            in.Auth,
			DefaultDays:     days,
			DefaultPageSize: pageSize,
			TimeoutSeconds:  timeout,
			IsDefault:       in.IsDefault,
			Enabled:         in.Enabled,
			Remark:          strings.TrimSpace(in.Remark),
		},
		fixedJSON: fixedJSON,
	}, profile, nil
}

func normalizeBaseURL(raw string) (string, error) {
	base := strings.TrimSpace(raw)
	if base == "" {
		return "", fmt.Errorf("%w: base url is required", errs.ErrInvalid)
	}
	parsed, err := url.Parse(base)
	if err != nil {
		return "", fmt.Errorf("%w: base url: %v", errs.ErrInvalid, err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("%w: base url must be http or https", errs.ErrInvalid)
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("%w: base url has no host", errs.ErrInvalid)
	}
	if parsed.User != nil {
		return "", fmt.Errorf("%w: base url must not carry credentials", errs.ErrInvalid)
	}
	if parsed.Opaque != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("%w: base url must be scheme + host + optional path only", errs.ErrInvalid)
	}
	return strings.TrimRight(base, "/"), nil
}

func marshalFixed(params map[string][]string) (string, error) {
	if len(params) == 0 {
		return "{}", nil
	}
	for key, values := range params {
		if strings.TrimSpace(key) == "" {
			return "", fmt.Errorf("%w: fixed parameter key is required", errs.ErrInvalid)
		}
		if len(values) == 0 {
			return "", fmt.Errorf("%w: fixed parameter %q has no value", errs.ErrInvalid, key)
		}
		for _, value := range values {
			if strings.TrimSpace(value) == "" {
				return "", fmt.Errorf("%w: fixed parameter %q has an empty value", errs.ErrInvalid, key)
			}
		}
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return "", fmt.Errorf("%w: fixed parameters: %v", errs.ErrInvalid, err)
	}
	return string(raw), nil
}

func parseFixed(raw string) (map[string][]string, error) {
	if raw == "" || raw == "{}" {
		return nil, nil
	}
	var out map[string][]string
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (u *Usecase) seal(normalized normalizedConnection, existing *model.Connection) (string, error) {
	// Switching to auth_type none clears any dormant credential: keeping it
	// would leave a secret in the row that no request can ever use.
	if normalized.AuthType == "none" {
		return "", nil
	}
	if normalized.Auth == nil {
		if existing != nil {
			return existing.AuthCipher, nil
		}
		return "", nil
	}
	if normalized.Auth.Token == "" && normalized.Auth.Username == "" && normalized.Auth.Password == "" {
		return "", nil
	}
	if u.crypto == nil || u.crypto.Weak() {
		return "", ErrWeakSecret
	}
	raw, err := json.Marshal(map[string]string{
		"token":    normalized.Auth.Token,
		"username": normalized.Auth.Username,
		"password": normalized.Auth.Password,
	})
	if err != nil {
		return "", err
	}
	return u.crypto.Encrypt(string(raw))
}

func (u *Usecase) open(cipher string, id uint64) (Credentials, error) {
	if cipher == "" {
		return Credentials{}, nil
	}
	if u.crypto == nil {
		return Credentials{}, fmt.Errorf("%w: connection %d", ErrCredentialUndecryptable, id)
	}
	plain, err := u.crypto.Decrypt(cipher)
	if err != nil {
		return Credentials{}, fmt.Errorf("%w: connection %d: %v", ErrCredentialUndecryptable, id, err)
	}
	var stored struct {
		Token    string `json:"token"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.Unmarshal([]byte(plain), &stored); err != nil {
		return Credentials{}, fmt.Errorf("%w: connection %d: invalid credential JSON", ErrCredentialUndecryptable, id)
	}
	return Credentials{Token: stored.Token, Username: stored.Username, Password: stored.Password}, nil
}

func (u *Usecase) view(row *model.Connection) *ConnectionView {
	fixed, _ := parseFixed(row.FixedParamsJSON)
	creds, err := u.open(row.AuthCipher, row.ID)
	tokenSet := creds.Token != ""
	passwordSet := creds.Password != ""
	if err != nil {
		// A row that cannot be decrypted still reports that a credential is
		// present; the health check and the edit form surface the real error.
		tokenSet = row.AuthCipher != ""
		passwordSet = row.AuthCipher != ""
	}
	return &ConnectionView{
		ID:              row.ID,
		Kind:            row.Kind,
		Name:            row.Name,
		BaseURL:         row.BaseURL,
		APIPath:         row.APIPath,
		Method:          row.Method,
		FixedParams:     fixed,
		AuthType:        row.AuthType,
		TokenSet:        tokenSet,
		Username:        creds.Username,
		PasswordSet:     passwordSet,
		DefaultDays:     row.DefaultDays,
		DefaultPageSize: row.DefaultPageSize,
		TimeoutSeconds:  row.TimeoutSeconds,
		IsDefault:       row.IsDefault,
		Enabled:         row.Enabled,
		Remark:          row.Remark,
		CreatedAt:       row.CreatedAt,
		UpdatedAt:       row.UpdatedAt,
	}
}

func boolValue(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

func probeTimeout(seconds int) time.Duration {
	if seconds < 1 {
		seconds = 15
	}
	if seconds > 60 {
		seconds = 60
	}
	return time.Duration(seconds) * time.Second
}
