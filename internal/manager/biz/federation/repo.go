package federation

import (
	"context"
	"encoding/json"
	"errors"

	model "github.com/ongridio/ongrid/internal/manager/model/federation"
)

// ErrUpstream marks a failure of the external system or an unusable stored
// credential. The HTTP layer maps it to 502; it is never presented as an
// empty result.
var ErrUpstream = errors.New("federation: upstream failure")

// ErrCredentialUndecryptable means the stored credential cannot be decrypted
// (typically after a secret-key rotation). Callers must ask the administrator
// to re-save the connection rather than treating it as an empty credential.
var ErrCredentialUndecryptable = errors.New("federation: stored credential cannot be decrypted; re-save the connection")

// Credentials is decrypted connection material. It never appears in a DTO.
type Credentials struct {
	Token    string
	Username string
	Password string
}

// QueryRequest is one upstream page request.
type QueryRequest struct {
	Table     string
	StartDate string
	EndDate   string
	Days      int
	Page      int
	PageSize  int
	Filters   []string
	OrFilters []string
}

// QueryPage is the normalized upstream result.
type QueryPage struct {
	Table     string
	TimeRange string
	Total     int
	Page      int
	PageSize  int
	Pages     int
	Items     []json.RawMessage
	Filters   json.RawMessage
}

// ProbeConfig describes an unsaved or saved connection for a health probe.
type ProbeConfig struct {
	BaseURL        string
	APIPath        string
	Method         string
	FixedParams    map[string][]string
	AuthType       string
	Credentials    Credentials
	TimeoutSeconds int
	MaxPageSize    int
	DefaultTable   string
}

// Repository is the persistence seam consumed by the use case. The concrete
// implementation lives in internal/manager/data/federation/store.
type Repository interface {
	ListConnections(ctx context.Context, kind string) ([]model.Connection, error)
	GetConnection(ctx context.Context, id uint64) (*model.Connection, error)
	CreateConnection(ctx context.Context, conn *model.Connection) error
	UpdateConnection(ctx context.Context, conn *model.Connection) error
	DeleteConnection(ctx context.Context, id uint64, cascade bool) error
	ClearDefaultConnection(ctx context.Context, kind string, exceptID uint64) error

	ListMappings(ctx context.Context, kind string, ciTypeID uint64) ([]model.CIMapping, error)
	GetMapping(ctx context.Context, id uint64) (*model.CIMapping, error)
	CreateMapping(ctx context.Context, mapping *model.CIMapping) error
	UpdateMapping(ctx context.Context, mapping *model.CIMapping) error
	DeleteMapping(ctx context.Context, id uint64) error

	ListFilters(ctx context.Context, kind string) ([]model.CenterFilter, error)
	GetFilter(ctx context.Context, kind, key string) (*model.CenterFilter, error)
	SaveFilter(ctx context.Context, filter *model.CenterFilter) error
	DeleteFilter(ctx context.Context, kind, key string) error
	CountBadgeFilters(ctx context.Context, kind, exceptKey string) (int64, error)

	ListColumns(ctx context.Context, kind string) ([]model.DisplayColumn, error)
	ReplaceColumns(ctx context.Context, kind string, columns []model.DisplayColumn) error
}

// SourceQuerier performs the read-only upstream calls. Implementations must
// use conn.AuthCipher, never a plaintext credential.
type SourceQuerier interface {
	Query(ctx context.Context, conn *model.Connection, req QueryRequest) (*QueryPage, error)
	Probe(ctx context.Context, cfg ProbeConfig) error
}
