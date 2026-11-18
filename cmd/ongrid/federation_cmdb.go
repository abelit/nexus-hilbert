package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"

	federationbiz "github.com/ongridio/ongrid/internal/manager/biz/federation"
	cmdbclient "github.com/ongridio/ongrid/internal/manager/biz/aiops/tools/cmdb"
)

// cmdbFederationReader adapts the caller-authenticated CMDB HTTP client to the
// federation biz interface. It lives in the composition root because the
// manager biz package may not import internal/cmdb.
//
// Every call carries the invoking operator's JWT. A background context has no
// caller and the client fails closed; that is the intended boundary (ADR-037).
type cmdbFederationReader struct {
	client *cmdbclient.Client
}

func (r cmdbFederationReader) GetInstance(ctx context.Context, id uint64) (*federationbiz.CMDBInstance, error) {
	if r.client == nil {
		return nil, federationbiz.ErrCMDBUnavailable
	}
	raw, err := r.client.Get(ctx, "/instances/"+strconv.FormatUint(id, 10), nil)
	if err != nil {
		return nil, err
	}
	var dto struct {
		ID     uint64         `json:"ci_id"`
		TypeID uint64         `json:"type_id"`
		Values map[string]any `json:"values"`
	}
	if err := json.Unmarshal(raw, &dto); err != nil {
		return nil, fmt.Errorf("cmdb: decode instance %d: %w", id, err)
	}
	return &federationbiz.CMDBInstance{ID: dto.ID, TypeID: dto.TypeID, Values: dto.Values}, nil
}

func (r cmdbFederationReader) ListCITypes(ctx context.Context) ([]federationbiz.CMDBType, error) {
	if r.client == nil {
		return nil, federationbiz.ErrCMDBUnavailable
	}
	raw, err := r.client.Get(ctx, "/ci-types", url.Values{"count": {"500"}})
	if err != nil {
		return nil, err
	}
	var dto struct {
		Items []struct {
			ID    uint64 `json:"id"`
			Name  string `json:"name"`
			Alias string `json:"alias"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &dto); err != nil {
		return nil, fmt.Errorf("cmdb: decode ci types: %w", err)
	}
	out := make([]federationbiz.CMDBType, 0, len(dto.Items))
	for _, item := range dto.Items {
		out = append(out, federationbiz.CMDBType{ID: item.ID, Name: item.Name, Alias: item.Alias})
	}
	return out, nil
}
