// Package server composes the CMDB HTTP handlers.
package server

import (
	"github.com/go-chi/chi/v5"

	"github.com/ongridio/ongrid/internal/cmdb/server/ci"
	"github.com/ongridio/ongrid/internal/cmdb/server/citype"
	"github.com/ongridio/ongrid/internal/cmdb/server/discovery"
	"github.com/ongridio/ongrid/internal/cmdb/server/meta"
	"github.com/ongridio/ongrid/internal/cmdb/server/relationtype"
)

// Handlers is the set of CMDB HTTP handlers the process mounts.
type Handlers struct {
	Meta         *meta.Handler
	RelationType *relationtype.Handler
	Discovery    *discovery.Handler
	CIType       *citype.Handler
	CI           *ci.Handler
}

// RegisterAll mounts every CMDB handler on r.
//
// THE ORDER MATCHES cmd/ongrid's historical wiring. The paths are disjoint, so
// order is not load-bearing today; keeping it stable makes a route-set diff
// readable. A nil handler is skipped so a test can mount one subsystem without
// constructing the rest.
func RegisterAll(r chi.Router, h Handlers) {
	if r == nil {
		return
	}
	if h.Meta != nil {
		h.Meta.Register(r)
	}
	if h.RelationType != nil {
		h.RelationType.Register(r)
	}
	if h.Discovery != nil {
		h.Discovery.Register(r)
	}
	if h.CIType != nil {
		h.CIType.Register(r)
	}
	if h.CI != nil {
		h.CI.Register(r)
	}
}
