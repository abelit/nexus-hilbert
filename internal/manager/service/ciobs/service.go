// Package ciobs is the application-service entry for CI monitoring links.
package ciobs

import biz "github.com/ongridio/ongrid/internal/manager/biz/ciobs"

type Service struct {
	*biz.Usecase
}

func New(uc *biz.Usecase) *Service { return &Service{Usecase: uc} }
