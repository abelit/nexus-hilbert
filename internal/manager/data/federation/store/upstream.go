package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	biz "github.com/ongridio/ongrid/internal/manager/biz/federation"
	model "github.com/ongridio/ongrid/internal/manager/model/federation"
	"github.com/ongridio/ongrid/internal/pkg/fedclient"
	"github.com/ongridio/ongrid/internal/pkg/secretbox"
)

// Upstream adapts a stored connection to fedclient. It is the only place that
// decrypts a credential; callers never see plaintext.
type Upstream struct{}

func NewUpstream() *Upstream { return &Upstream{} }

var _ biz.SourceQuerier = (*Upstream)(nil)

func (u *Upstream) Query(ctx context.Context, conn *model.Connection, req biz.QueryRequest) (*biz.QueryPage, error) {
	client, err := clientForConnection(conn)
	if err != nil {
		return nil, err
	}
	page, err := client.Query(ctx, fedclient.Query{
		Table:     req.Table,
		StartDate: req.StartDate,
		EndDate:   req.EndDate,
		Days:      req.Days,
		Filters:   req.Filters,
		OrFilters: req.OrFilters,
		Page:      req.Page,
		PageSize:  req.PageSize,
	})
	if err != nil {
		return nil, wrapUpstream(err)
	}
	return &biz.QueryPage{
		Table:     page.Table,
		TimeRange: page.TimeRange,
		Total:     page.Total,
		Page:      page.Page,
		PageSize:  page.PageSize,
		Pages:     page.Pages,
		Items:     page.Items,
		Filters:   page.Filters,
	}, nil
}

func (u *Upstream) Probe(ctx context.Context, cfg biz.ProbeConfig) error {
	client, err := fedclient.New(fedclient.Config{
		BaseURL:      cfg.BaseURL,
		APIPath:      cfg.APIPath,
		Method:       normalizeMethod(cfg.Method),
		FixedParams:  cfg.FixedParams,
		AuthType:     cfg.AuthType,
		Auth:         fedclient.AuthData{Token: cfg.Credentials.Token, Username: cfg.Credentials.Username, Password: cfg.Credentials.Password},
		Timeout:      timeout(cfg.TimeoutSeconds),
		PageSizeCap:  cfg.MaxPageSize,
		DefaultTable: cfg.DefaultTable,
	})
	if err != nil {
		return fmt.Errorf("%w: %v", biz.ErrUpstream, err)
	}
	if err := client.Probe(ctx); err != nil {
		return wrapUpstream(err)
	}
	return nil
}

func clientForConnection(conn *model.Connection) (*fedclient.Client, error) {
	fixed, err := parseFixedParams(conn.FixedParamsJSON)
	if err != nil {
		return nil, fmt.Errorf("%w: connection %d has invalid fixed params: %v", biz.ErrUpstream, conn.ID, err)
	}
	credentials, err := decryptCredentials(conn)
	if err != nil {
		return nil, err
	}
	profile, ok := biz.Profile(conn.Kind)
	maxPageSize := 500
	if ok {
		maxPageSize = profile.MaxPageSize
	}
	client, err := fedclient.New(fedclient.Config{
		BaseURL:       conn.BaseURL,
		APIPath:       conn.APIPath,
		Method:        normalizeMethod(conn.Method),
		FixedParams:   fixed,
		AuthType:      conn.AuthType,
		Auth:          credentials,
		Timeout:       timeout(conn.TimeoutSeconds),
		PageSizeCap:   maxPageSize,
		DefaultTable:  profile.DefaultTable,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: connection %d: %v", biz.ErrUpstream, conn.ID, err)
	}
	return client, nil
}

func decryptCredentials(conn *model.Connection) (fedclient.AuthData, error) {
	if conn.AuthCipher == "" {
		return fedclient.AuthData{}, nil
	}
	plain, err := secretbox.Decrypt(conn.AuthCipher)
	if err != nil {
		return fedclient.AuthData{}, fmt.Errorf("%w: connection %d: %v", biz.ErrCredentialUndecryptable, conn.ID, err)
	}
	var stored struct {
		Token    string `json:"token"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.Unmarshal([]byte(plain), &stored); err != nil {
		return fedclient.AuthData{}, fmt.Errorf("%w: connection %d: credential is not valid JSON", biz.ErrCredentialUndecryptable, conn.ID)
	}
	return fedclient.AuthData{Token: stored.Token, Username: stored.Username, Password: stored.Password}, nil
}

func parseFixedParams(raw string) (map[string][]string, error) {
	if raw == "" {
		return nil, nil
	}
	var params map[string][]string
	if err := json.Unmarshal([]byte(raw), &params); err != nil {
		return nil, err
	}
	if len(params) == 0 {
		return nil, nil
	}
	return params, nil
}

func normalizeMethod(method string) string {
	if method == "" {
		return http.MethodGet
	}
	return method
}

func timeout(seconds int) time.Duration {
	if seconds <= 0 {
		return 15 * time.Second
	}
	if seconds > 60 {
		seconds = 60
	}
	return time.Duration(seconds) * time.Second
}

func wrapUpstream(err error) error {
	var upstream *fedclient.UpstreamError
	if errors.As(err, &upstream) {
		return fmt.Errorf("%w: %s", biz.ErrUpstream, upstream.Error())
	}
	return fmt.Errorf("%w: %v", biz.ErrUpstream, err)
}
