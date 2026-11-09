package ci

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// The CALLS ingestion contract (RFC-011 M2).
//
// THE PRODUCER RESOLVES ITS OWN NAMES TO CI IDS. The CMDB does not guess which
// instance an APM service name means; the connector matches names to the
// application layer and submits explicit pairs. Every accepted edge carries the
// collector provenance, the observation time, and the protocol/endpoint
// attributes the AIOps call graph filters on.
//
// A PAIR THAT ALREADY CARRIES A DIFFERENT RELATION IS NOT RETYPED. An explicit
// dependency a person recorded must not be overwritten by a collector that
// happens to observe traffic between the same two services; the edge is
// reported and the operator decides.

// CallEdgeInput is one observed call.
type CallEdgeInput struct {
	SourceCIID model.ID `json:"source_ci_id"`
	TargetCIID model.ID `json:"target_ci_id"`

	Protocol     string   `json:"protocol,omitempty"`
	Endpoint     string   `json:"endpoint,omitempty"`
	Method       string   `json:"method,omitempty"`
	Sync         *bool    `json:"sync,omitempty"`
	QPS          *float64 `json:"qps,omitempty"`
	LatencyP95Ms *float64 `json:"latency_p95_ms,omitempty"`
	ErrorRate    *float64 `json:"error_rate,omitempty"`

	ObservedAt     string   `json:"observed_at"`
	Confidence     *float64 `json:"confidence,omitempty"`
	EvidenceSource string   `json:"evidence_source,omitempty"`
}

type CallEdgeIngestInput struct {
	DryRun bool

	// DefaultEvidenceSource is used when an edge does not name one; it must
	// start with "collector:".
	DefaultEvidenceSource string

	Edges []CallEdgeInput
}

type CallEdgeIngestReport struct {
	DryRun   bool                 `json:"dry_run"`
	Created  []CallEdgeAppliedRow `json:"created,omitempty"`
	Existing []CallEdgeAppliedRow `json:"existing,omitempty"`
	Skipped  []CallEdgeSkippedRow `json:"skipped,omitempty"`
	Total    int                  `json:"total"`
}

type CallEdgeAppliedRow struct {
	SourceCIID     model.ID `json:"source_ci_id"`
	TargetCIID     model.ID `json:"target_ci_id"`
	RelationTypeID model.ID `json:"relation_type_id"`
}

type CallEdgeSkippedRow struct {
	SourceCIID model.ID `json:"source_ci_id"`
	TargetCIID model.ID `json:"target_ci_id"`
	Reason     string   `json:"reason"`
}

// IngestCallEdges writes the observed service calls into the application layer.
func (u *Usecase) IngestCallEdges(ctx context.Context, in CallEdgeIngestInput) (*CallEdgeIngestReport, error) {
	if u.repo == nil || u.types == nil {
		return nil, errs.ErrNotWiredYet
	}
	defaultEvidence := strings.TrimSpace(in.DefaultEvidenceSource)
	if defaultEvidence == "" {
		defaultEvidence = "collector:apm"
	}
	if !strings.HasPrefix(defaultEvidence, "collector:") {
		return nil, fmt.Errorf("%w: evidence source %q must start with collector:", errs.ErrInvalid, defaultEvidence)
	}
	report := &CallEdgeIngestReport{DryRun: in.DryRun}
	skip := func(row CallEdgeInput, reason string) {
		report.Skipped = append(report.Skipped, CallEdgeSkippedRow{
			SourceCIID: row.SourceCIID, TargetCIID: row.TargetCIID, Reason: reason,
		})
	}

	for _, edge := range in.Edges {
		if edge.SourceCIID <= 0 || edge.TargetCIID <= 0 {
			skip(edge, "source_ci_id and target_ci_id are required")
			continue
		}
		if edge.SourceCIID == edge.TargetCIID {
			skip(edge, "an edge cannot point at itself")
			continue
		}
		observedAt, err := time.Parse(time.RFC3339, strings.TrimSpace(edge.ObservedAt))
		if err != nil {
			skip(edge, "observed_at must be RFC3339")
			continue
		}
		if edge.Confidence != nil && (*edge.Confidence < 0 || *edge.Confidence > 1) {
			skip(edge, "confidence must be in [0,1]")
			continue
		}
		evidence := strings.TrimSpace(edge.EvidenceSource)
		if evidence == "" {
			evidence = defaultEvidence
		}
		if !strings.HasPrefix(evidence, "collector:") {
			skip(edge, "evidence_source must start with collector:")
			continue
		}

		first, err := u.loadInstance(ctx, edge.SourceCIID)
		if err != nil {
			if errors.Is(err, ErrInstanceNotFound) {
				skip(edge, "source CI does not exist")
				continue
			}
			return nil, err
		}
		second, err := u.loadInstance(ctx, edge.TargetCIID)
		if err != nil {
			if errors.Is(err, ErrInstanceNotFound) {
				skip(edge, "target CI does not exist")
				continue
			}
			return nil, err
		}
		rule, ok, err := u.types.RelationBetween(ctx, first.TypeID, second.TypeID)
		if err != nil {
			return nil, err
		}
		if !ok || rule.RelationTypeName != "CALLS" {
			skip(edge, "the model pair has no CALLS rule")
			continue
		}
		existing, err := u.repo.FindRelation(ctx, RelationRef{
			FirstCIID: edge.SourceCIID, SecondCIID: edge.TargetCIID,
		})
		if err != nil {
			return nil, err
		}
		if existing != nil && existing.RelationTypeID != rule.RelationTypeID {
			skip(edge, fmt.Sprintf("the pair already carries relation type %d, not CALLS", existing.RelationTypeID))
			continue
		}
		props, err := callEdgeProps(edge)
		if err != nil {
			return nil, err
		}
		row := CallEdgeAppliedRow{
			SourceCIID: edge.SourceCIID, TargetCIID: edge.TargetCIID, RelationTypeID: rule.RelationTypeID,
		}
		if in.DryRun {
			if existing != nil {
				report.Existing = append(report.Existing, row)
			} else {
				report.Created = append(report.Created, row)
			}
			continue
		}
		written, err := u.repo.AddRelation(ctx, RelationAddSpec{
			FirstCIID:         edge.SourceCIID,
			SecondCIID:        edge.TargetCIID,
			RelationTypeID:    rule.RelationTypeID,
			FirstTypeID:       first.TypeID,
			SecondTypeID:      second.TypeID,
			Constraint:        rule.Constraint,
			EnforceConstraint: true,
			EvidenceSource:    evidence,
			ObservedAt:        &observedAt,
			Confidence:        edge.Confidence,
			PropsJSON:         props,
		})
		if err != nil {
			return nil, fmt.Errorf("cmdb ci: call edges: write %d -> %d: %w",
				edge.SourceCIID, edge.TargetCIID, err)
		}
		row.RelationTypeID = written.RelationTypeID
		if existing != nil {
			report.Existing = append(report.Existing, row)
		} else {
			report.Created = append(report.Created, row)
		}
	}
	report.Total = len(report.Created) + len(report.Existing) + len(report.Skipped)
	return report, nil
}

// callEdgeProps keeps only the attributes the producer observed. The names are
// the ones the AIOps call-graph filters read (protocol, endpoint, method, sync,
// qps, latency_p95, error_rate).
func callEdgeProps(edge CallEdgeInput) (string, error) {
	props := make(map[string]any, 7)
	if value := strings.TrimSpace(edge.Protocol); value != "" {
		props["protocol"] = value
	}
	if value := strings.TrimSpace(edge.Endpoint); value != "" {
		props["endpoint"] = value
	}
	if value := strings.TrimSpace(edge.Method); value != "" {
		props["method"] = value
	}
	if edge.Sync != nil {
		props["sync"] = *edge.Sync
	}
	if edge.QPS != nil {
		props["qps"] = *edge.QPS
	}
	if edge.LatencyP95Ms != nil {
		props["latency_p95"] = *edge.LatencyP95Ms
	}
	if edge.ErrorRate != nil {
		props["error_rate"] = *edge.ErrorRate
	}
	if len(props) == 0 {
		return "", nil
	}
	raw, err := json.Marshal(props)
	if err != nil {
		return "", fmt.Errorf("cmdb ci: call edges: encode props: %w", err)
	}
	return string(raw), nil
}
