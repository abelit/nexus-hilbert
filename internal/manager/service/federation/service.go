// Package federation is the application-service entry for the federated
// external sources. It is a thin seam over the biz use case: transport DTOs
// and routing live in server/federation.
package federation

import biz "github.com/ongridio/ongrid/internal/manager/biz/federation"

type Service struct {
	*biz.Usecase
}

func New(uc *biz.Usecase) *Service { return &Service{Usecase: uc} }
