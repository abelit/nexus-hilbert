package ciobs

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	model "github.com/ongridio/ongrid/internal/manager/model/ciobs"
	"github.com/ongridio/ongrid/internal/pkg/errs"
	pkggrafana "github.com/ongridio/ongrid/internal/pkg/grafana"
	"github.com/ongridio/ongrid/internal/pkg/promauth"
	"github.com/ongridio/ongrid/internal/pkg/promquery"
)

var ErrWeakSecret = errors.New("ciobs: refusing to store a credential without a strong ONGRID_SECRET_KEY")

// Crypto is the at-rest encryption seam; cmd/ongrid injects secretbox.
type Crypto interface {
	Encrypt(plain string) (string, error)
	Decrypt(cipher string) (string, error)
	Weak() bool
}

// GlobalProbe checks the platform's INTERNAL Grafana/Prometheus integration.
type GlobalProbe interface {
	ProbeGrafana(ctx context.Context) error
	ProbeProm(ctx context.Context) error
}

type Credentials struct {
	Token    string
	Username string
	Password string
}

type ConnectionInput struct {
	Provider    string       `json:"provider"`
	Name        string       `json:"name"`
	BaseURL     string       `json:"base_url"`
	AuthType    string       `json:"auth_type"`
	Auth        *Credentials `json:"auth_data"`
	TLSInsecure *bool        `json:"tls_insecure"`
	Enabled     *bool        `json:"enabled"`
	Remark      string       `json:"remark"`
}

type ConnectionView struct {
	ID          uint64 `json:"id"`
	Provider    string `json:"provider"`
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	BaseURL     string `json:"base_url,omitempty"`
	AuthType    string `json:"auth_type"`
	TokenSet    bool   `json:"token_set"`
	Username    string `json:"username,omitempty"`
	PasswordSet bool   `json:"password_set"`
	TLSInsecure bool   `json:"tls_insecure"`
	Enabled     bool   `json:"enabled"`
	Remark      string `json:"remark,omitempty"`
}

type ConnectionHealth struct {
	ID    uint64 `json:"id"`
	Name  string `json:"name"`
	Kind  string `json:"kind"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

func internalConnectionView(provider string) ConnectionView {
	name := "平台 Prometheus"
	if provider == model.ProviderGrafana {
		name = "平台 Grafana"
	}
	return ConnectionView{
		ID: 0, Provider: provider, Kind: model.ConnectionKindInternal,
		Name: name, AuthType: "none", Enabled: true,
	}
}

func (u *Usecase) ListConnections(ctx context.Context, provider string) ([]ConnectionView, error) {
	if !validProvider(provider) {
		return nil, fmt.Errorf("%w: provider %q", errs.ErrInvalid, provider)
	}
	rows, err := u.repo.ListConnections(ctx, provider)
	if err != nil {
		return nil, err
	}
	out := []ConnectionView{internalConnectionView(provider)}
	for i := range rows {
		out = append(out, u.connectionView(&rows[i]))
	}
	return out, nil
}

func (u *Usecase) SaveConnection(ctx context.Context, provider string, in ConnectionInput, id uint64) (*ConnectionView, error) {
	if !validProvider(provider) {
		return nil, fmt.Errorf("%w: provider %q", errs.ErrInvalid, provider)
	}
	normalized, err := normalizeConnection(provider, in, nil)
	if err != nil {
		return nil, err
	}
	var existing *model.Connection
	if id > 0 {
		existing, err = u.repo.GetConnection(ctx, id)
		if err != nil {
			return nil, err
		}
		if existing.Provider != provider {
			return nil, fmt.Errorf("%w: connection provider cannot change", errs.ErrInvalid)
		}
		normalized, err = normalizeConnection(provider, in, existing)
		if err != nil {
			return nil, err
		}
	}
	cipher, err := u.seal(normalized, existing)
	if err != nil {
		return nil, err
	}
	row := &model.Connection{
		ID: id, Provider: provider, Name: normalized.Name, BaseURL: normalized.BaseURL,
		AuthType: normalized.AuthType, AuthCipher: cipher,
		TLSInsecure: boolValue(normalized.TLSInsecure, false),
		Enabled:     boolValue(normalized.Enabled, true),
		Remark:      normalized.Remark,
	}
	if existing != nil {
		if normalized.Enabled == nil {
			row.Enabled = existing.Enabled
		}
		if normalized.TLSInsecure == nil {
			row.TLSInsecure = existing.TLSInsecure
		}
		row.ID = existing.ID
		if err := u.repo.UpdateConnection(ctx, row); err != nil {
			return nil, err
		}
	} else if err := u.repo.CreateConnection(ctx, row); err != nil {
		return nil, err
	}
	view := u.connectionView(row)
	return &view, nil
}

func (u *Usecase) DeleteConnection(ctx context.Context, id uint64) error {
	if id == 0 {
		return fmt.Errorf("%w: the internal connection cannot be deleted", errs.ErrInvalid)
	}
	return u.repo.DeleteConnection(ctx, id)
}

func (u *Usecase) TestConnection(ctx context.Context, provider string, in ConnectionInput) error {
	if !validProvider(provider) {
		return fmt.Errorf("%w: provider %q", errs.ErrInvalid, provider)
	}
	normalized, err := normalizeConnection(provider, in, nil)
	if err != nil {
		return err
	}
	creds := Credentials{}
	if normalized.Auth != nil {
		creds = *normalized.Auth
	}
	return u.probe(ctx, provider, normalized.BaseURL, normalized.AuthType, creds, boolValue(normalized.TLSInsecure, false))
}

func (u *Usecase) TestSavedConnection(ctx context.Context, id uint64) error {
	conn, err := u.repo.GetConnection(ctx, id)
	if err != nil {
		return err
	}
	creds, err := u.open(conn.AuthCipher, conn.ID)
	if err != nil {
		return err
	}
	return u.probe(ctx, conn.Provider, conn.BaseURL, conn.AuthType, creds, conn.TLSInsecure)
}

func (u *Usecase) ConnectionsHealth(ctx context.Context, provider string) ([]ConnectionHealth, error) {
	if !validProvider(provider) {
		return nil, fmt.Errorf("%w: provider %q", errs.ErrInvalid, provider)
	}
	out := []ConnectionHealth{{ID: 0, Name: internalConnectionView(provider).Name, Kind: model.ConnectionKindInternal}}
	if u.globalProbe == nil {
		out[0].Error = "not configured"
	} else if err := u.probeGlobal(ctx, provider); err != nil {
		// The internal row is a read-only projection of Settings → Integrations,
		// so a failure here is fixed there, not on this page.
		out[0].Error = err.Error() + " — fix the global integration in Settings → Integrations"
	} else {
		out[0].OK = true
	}
	rows, err := u.repo.ListConnections(ctx, provider)
	if err != nil {
		return nil, err
	}
	for i := range rows {
		row := &rows[i]
		if !row.Enabled {
			continue
		}
		health := ConnectionHealth{ID: row.ID, Name: row.Name, Kind: model.ConnectionKindExternal}
		probeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		health.Error = errString(u.TestSavedConnection(probeCtx, row.ID))
		cancel()
		if health.Error == "" {
			health.OK = true
		}
		out = append(out, health)
	}
	return out, nil
}

func (u *Usecase) resolveConnection(ctx context.Context, provider string, id uint64) (*model.Connection, error) {
	if id == 0 {
		return nil, nil
	}
	conn, err := u.repo.GetConnection(ctx, id)
	if err != nil {
		return nil, err
	}
	if conn.Provider != provider {
		return nil, fmt.Errorf("%w: connection %d is not a %s connection", errs.ErrInvalid, id, provider)
	}
	if !conn.Enabled {
		return nil, fmt.Errorf("%w: connection %d is disabled", errs.ErrConflict, id)
	}
	return conn, nil
}

func (u *Usecase) promAlertsForConnection(ctx context.Context, conn *model.Connection) ([]promquery.Alert, error) {
	if conn == nil {
		if u.prom == nil {
			return nil, errors.New("prometheus is not configured")
		}
		return u.prom.Alerts(ctx)
	}
	creds, err := u.open(conn.AuthCipher, conn.ID)
	if err != nil {
		return nil, err
	}
	hc, err := promHTTPClient(creds, conn.TLSInsecure)
	if err != nil {
		return nil, err
	}
	return promquery.NewWithHTTPClient(conn.BaseURL, hc, u.log).Alerts(ctx)
}

func (u *Usecase) probe(ctx context.Context, provider, baseURL, authType string, creds Credentials, tlsInsecure bool) error {
	if provider == model.ProviderGrafana {
		hc := insecureHTTPClient(tlsInsecure)
		var client *pkggrafana.Client
		if authType == "basic" {
			client = pkggrafana.NewWithBasicAuth(baseURL, creds.Username, creds.Password, hc)
		} else {
			client = pkggrafana.New(baseURL, creds.Token, hc)
		}
		return client.Health(ctx)
	}
	hc, err := promHTTPClient(creds, tlsInsecure)
	if err != nil {
		return err
	}
	_, err = promquery.NewWithHTTPClient(baseURL, hc, u.log).Alerts(ctx)
	return err
}

func (u *Usecase) probeGlobal(ctx context.Context, provider string) error {
	if provider == model.ProviderGrafana {
		return u.globalProbe.ProbeGrafana(ctx)
	}
	return u.globalProbe.ProbeProm(ctx)
}

type normalizedConnection struct {
	ConnectionInput
}

func normalizeConnection(provider string, in ConnectionInput, existing *model.Connection) (normalizedConnection, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" || len(name) > 128 {
		return normalizedConnection{}, fmt.Errorf("%w: connection name is required (max 128)", errs.ErrInvalid)
	}
	base, err := normalizeBaseURL(in.BaseURL)
	if err != nil {
		return normalizedConnection{}, err
	}
	authType := strings.ToLower(strings.TrimSpace(in.AuthType))
	if authType == "" {
		if existing != nil && existing.AuthType != "" {
			authType = existing.AuthType
		} else {
			authType = "none"
		}
	}
	hasStored := existing != nil && existing.AuthCipher != ""
	switch authType {
	case "none":
		if in.Auth != nil && (in.Auth.Token != "" || in.Auth.Username != "" || in.Auth.Password != "") {
			return normalizedConnection{}, fmt.Errorf("%w: auth_type none cannot carry credentials", errs.ErrInvalid)
		}
	case "bearer":
		if in.Auth != nil && strings.TrimSpace(in.Auth.Token) == "" {
			return normalizedConnection{}, fmt.Errorf("%w: bearer auth requires a token", errs.ErrInvalid)
		}
		if in.Auth == nil && !hasStored {
			return normalizedConnection{}, fmt.Errorf("%w: bearer auth requires a token", errs.ErrInvalid)
		}
	case "basic":
		if in.Auth != nil && strings.TrimSpace(in.Auth.Username) == "" && strings.TrimSpace(in.Auth.Password) == "" {
			return normalizedConnection{}, fmt.Errorf("%w: basic auth requires a username or password", errs.ErrInvalid)
		}
		if in.Auth == nil && !hasStored {
			return normalizedConnection{}, fmt.Errorf("%w: basic auth requires a username or password", errs.ErrInvalid)
		}
	default:
		return normalizedConnection{}, fmt.Errorf("%w: auth_type %q", errs.ErrInvalid, authType)
	}
	_ = provider
	return normalizedConnection{ConnectionInput: ConnectionInput{
		Provider: provider, Name: name, BaseURL: base, AuthType: authType,
		Auth: in.Auth, TLSInsecure: in.TLSInsecure, Enabled: in.Enabled,
		Remark: strings.TrimSpace(in.Remark),
	}}, nil
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

func (u *Usecase) seal(in normalizedConnection, existing *model.Connection) (string, error) {
	if in.AuthType == "none" {
		return "", nil
	}
	if in.Auth == nil {
		if existing != nil {
			return existing.AuthCipher, nil
		}
		return "", nil
	}
	if in.Auth.Token == "" && in.Auth.Username == "" && in.Auth.Password == "" {
		return "", nil
	}
	if u.crypto == nil || u.crypto.Weak() {
		return "", ErrWeakSecret
	}
	raw, err := json.Marshal(map[string]string{
		"token": in.Auth.Token, "username": in.Auth.Username, "password": in.Auth.Password,
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
		return Credentials{}, fmt.Errorf("ciobs: connection %d credential is not decryptable", id)
	}
	plain, err := u.crypto.Decrypt(cipher)
	if err != nil {
		return Credentials{}, fmt.Errorf("ciobs: connection %d credential is not decryptable: %w", id, err)
	}
	var stored struct {
		Token    string `json:"token"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.Unmarshal([]byte(plain), &stored); err != nil {
		return Credentials{}, fmt.Errorf("ciobs: connection %d credential is invalid JSON", id)
	}
	return Credentials{Token: stored.Token, Username: stored.Username, Password: stored.Password}, nil
}

func (u *Usecase) connectionView(row *model.Connection) ConnectionView {
	creds, err := u.open(row.AuthCipher, row.ID)
	tokenSet := creds.Token != ""
	passwordSet := creds.Password != ""
	if err != nil {
		tokenSet = row.AuthCipher != ""
		passwordSet = row.AuthCipher != ""
	}
	return ConnectionView{
		ID: row.ID, Provider: row.Provider, Kind: model.ConnectionKindExternal,
		Name: row.Name, BaseURL: row.BaseURL, AuthType: row.AuthType,
		TokenSet: tokenSet, Username: creds.Username, PasswordSet: passwordSet,
		TLSInsecure: row.TLSInsecure, Enabled: row.Enabled, Remark: row.Remark,
	}
}

func insecureHTTPClient(tlsInsecure bool) *http.Client {
	transport := &http.Transport{}
	if tlsInsecure {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // explicit admin choice
	}
	return &http.Client{Transport: transport, Timeout: 15 * time.Second}
}

func promHTTPClient(creds Credentials, tlsInsecure bool) (*http.Client, error) {
	return promauth.BuildClient(
		promauth.TLSConfig{Insecure: tlsInsecure},
		promauth.NewStaticResolver(promauth.Config{
			BearerToken:   creds.Token,
			BasicUser:     creds.Username,
			BasicPassword: creds.Password,
		}),
		15*time.Second,
	)
}

func boolValue(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
