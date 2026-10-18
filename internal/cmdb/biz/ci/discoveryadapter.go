package ci

import (
	"context"
	"fmt"
	"strings"

	discoverybiz "github.com/ongridio/ongrid/internal/cmdb/biz/discovery"
	model "github.com/ongridio/ongrid/internal/cmdb/model"
)

// DiscoveryQueries adapts the instance side to the discovery module's
// consumer-declared port.
//
// IT IS TWO QUESTIONS, and both are the instance module's to answer because both
// are about instances: WHERE an agent runs, and WHETHER an expression selects a
// given instance. The discovery module holds a target's query expression as
// text; deciding what it means needs the attribute dictionary and the compiler,
// which live here.
type DiscoveryQueries struct {
	uc *Usecase
}

// NewDiscoveryQueries builds the adapter.
func NewDiscoveryQueries(uc *Usecase) *DiscoveryQueries {
	return &DiscoveryQueries{uc: uc}
}

var _ discoverybiz.InstanceQueries = (*DiscoveryQueries)(nil)

// The attribute a deployment records an agent's id under.
//
// IT IS NOT A BUILT-IN ATTRIBUTE, which is why the lookup has to tolerate its
// absence: a deployment that does not model agent placement simply has no
// instance to find, and that is an answer.
const (
	agentIDAttribute   = "oneagent_id"
	agentNameAttribute = "oneagent_name"
)

// LocateAgentInstance returns the instance an agent identified itself as running
// on, or zero.
func (q *DiscoveryQueries) LocateAgentInstance(ctx context.Context, oneagentID, oneagentName string) (model.ID, error) {
	agentID := strings.TrimSpace(oneagentID)
	if agentID == "" {
		return 0, nil
	}
	hits, err := q.uc.FindInstancesByAttribute(ctx, agentIDAttribute, []any{agentID}, agentInstanceLookupLimit)
	if err != nil {
		return 0, err
	}
	name := strings.TrimSpace(oneagentName)
	for _, hit := range hits {
		if name == "" {
			// AN AGENT THAT DOES NOT GIVE ITS NAME gets the first instance that
			// claims its id. Identical to cantor's, which only compared names when
			// it had one.
			return hit.ID, nil
		}
		// THE INSTANCE'S OWN NAME, or its `oneagent_name` if it carries one —
		// either identifies it, and cantor accepted both.
		if valueMatchesName(hit, name) {
			return hit.ID, nil
		}
	}
	return 0, nil
}

// agentInstanceLookupLimit bounds the placement lookup.
//
// AN AGENT ID BELONGS TO ONE MACHINE, and a deployment whose ids are unique in
// practice will match on the first or second hit. The bound is there because the
// attribute is a deployment's own and nothing in the schema makes it unique — an
// operator who set the same id on every host would otherwise have this endpoint
// load the estate on every poll.
const agentInstanceLookupLimit = 200

// valueMatchesName reports whether a located instance carries the agent's name.
func valueMatchesName(hit SearchHit, name string) bool {
	if unique := strings.TrimSpace(hit.UniqueAttr); unique != "" {
		if strings.TrimSpace(hit.UniqueAlias) != "" && hit.Values[hit.UniqueAlias] != nil {
			if equalText(hit.Values[hit.UniqueAlias], name) {
				return true
			}
		}
		if equalText(hit.Values[unique], name) {
			return true
		}
	}
	return equalText(hit.Values[agentNameAttribute], name)
}

// MatchInstance reports whether an expression selects one instance.
func (q *DiscoveryQueries) MatchInstance(ctx context.Context, expr string, ciID model.ID) (bool, error) {
	return q.uc.InstanceMatches(ctx, expr, ciID)
}

// equalText reports whether a rendered value is the given name.
func equalText(raw any, want string) bool {
	switch v := raw.(type) {
	case nil:
		return false
	case string:
		return strings.TrimSpace(v) == want
	case []any:
		// A MULTI-VALUED ATTRIBUTE ARRIVES AS A LIST, and "does this instance
		// carry that name" is then a membership test rather than an equality —
		// which is the same reading that makes an `IN` match a value row rather
		// than a cell.
		for _, item := range v {
			if text, ok := item.(string); ok && strings.TrimSpace(text) == want {
				return true
			}
		}
		return false
	}
	return strings.TrimSpace(fmt.Sprint(raw)) == want
}
