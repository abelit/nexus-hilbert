package ci

import (
	"strings"
	"testing"
)

// The classification rule is the one place the planner and the apply agree on.
// The first failing gate names the reason; the rule never returns
// application_service for a legacy service.
func TestClassifyServiceLayer(t *testing.T) {
	good := func() ServiceLayerEvidence {
		return ServiceLayerEvidence{
			ApplicationTargets: 1,
			BelongsToProduct:   1,
			CoveredBySLA:       1,
			ManagedByMembers:   1,
			AssetUseType:       "business",
			Environment:        "prod",
			Level:              "important",
		}
	}
	cases := []struct {
		name       string
		identifier string
		duplicate  bool
		mutate     func(*ServiceLayerEvidence)
		wantTarget string
		wantReason string
	}{
		{name: "all gates pass", identifier: "svc-a", wantTarget: "business_service", wantReason: "production"},
		{name: "missing identifier", identifier: "", wantReason: "missing the model's unique identifier"},
		{name: "duplicate identifier", identifier: "svc-a", duplicate: true, wantReason: "duplicate unique identifier"},
		{
			name: "ledger support service", identifier: "svc-a",
			mutate:     func(ev *ServiceLayerEvidence) { ev.AssetUseType = "ledger" },
			wantReason: "asset_use_type=ledger",
		},
		{
			name: "missing asset use type", identifier: "svc-a",
			mutate:     func(ev *ServiceLayerEvidence) { ev.AssetUseType = "" },
			wantReason: "asset_use_type=unknown",
		},
		{
			name: "outbound service connection", identifier: "svc-a",
			mutate:     func(ev *ServiceLayerEvidence) { ev.ConnectsToOutbound = 1 },
			wantReason: "CONNECTS_TO (out 1 / in 0)",
		},
		{
			name: "inbound service connection", identifier: "svc-a",
			mutate:     func(ev *ServiceLayerEvidence) { ev.ConnectsToInbound = 1 },
			wantReason: "CONNECTS_TO (out 0 / in 1)",
		},
		{
			name: "test environment", identifier: "svc-a",
			mutate:     func(ev *ServiceLayerEvidence) { ev.Environment = "test" },
			wantReason: "environment=test",
		},
		{
			name: "missing environment", identifier: "svc-a",
			mutate:     func(ev *ServiceLayerEvidence) { ev.Environment = "" },
			wantReason: "environment=unknown",
		},
		{
			name: "experimental level", identifier: "svc-a",
			mutate:     func(ev *ServiceLayerEvidence) { ev.Level = "experimental" },
			wantReason: "level=experimental",
		},
		{
			name: "no application target", identifier: "svc-a",
			mutate:     func(ev *ServiceLayerEvidence) { ev.ApplicationTargets = 0 },
			wantReason: "0 application targets",
		},
		{
			name: "several application targets", identifier: "svc-a",
			mutate:     func(ev *ServiceLayerEvidence) { ev.ApplicationTargets = 2 },
			wantReason: "2 application targets",
		},
		{
			name: "missing product anchor", identifier: "svc-a",
			mutate:     func(ev *ServiceLayerEvidence) { ev.BelongsToProduct = 0 },
			wantReason: "product HAS_BELONGING",
		},
		{
			name: "missing SLA anchor", identifier: "svc-a",
			mutate:     func(ev *ServiceLayerEvidence) { ev.CoveredBySLA = 0 },
			wantReason: "SLA COVERS",
		},
		{
			name: "missing member anchor", identifier: "svc-a",
			mutate:     func(ev *ServiceLayerEvidence) { ev.ManagedByMembers = 0 },
			wantReason: "members manage",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ev := good()
			if tc.mutate != nil {
				tc.mutate(&ev)
			}
			target, reason := ClassifyServiceLayer(ServiceLayerFacts{
				Identifier: tc.identifier, Duplicate: tc.duplicate, Evidence: ev,
			})
			if target != tc.wantTarget {
				t.Fatalf("target = %q, want %q (reason %q)", target, tc.wantTarget, reason)
			}
			if !strings.Contains(reason, tc.wantReason) {
				t.Fatalf("reason = %q, want it to mention %q", reason, tc.wantReason)
			}
			if target == "application_service" {
				t.Fatalf("a legacy service was auto-classified as application_service")
			}
		})
	}
}
