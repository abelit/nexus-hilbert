package ci

import (
	"context"
	"errors"
	"fmt"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// The M2 edge projection (RFC-011).
//
// IT IS READ-ONLY TOWARD THE LEGACY GRAPH. Every mapped `service --DEPENDS_ON-->
// application` edge becomes a new `business_service --CONTAINS--> application_service`
// edge; the legacy edge stays where it is, because M2 keeps the old graph
// readable and the new one additive. A repeated run finds the pair and reports
// it as existing.
//
// THE CONTAINMENT RULE IS THE MODEL'S, NOT THIS FILE'S. The pair's rule decides
// the relation type and the cardinality; a second business service claiming the
// same application_service is reported as skipped rather than violating the
// one-to-many rule. That conflict is a modelling decision for a person.

const serviceLayerEdgeBatch = "service-layer-edges"

// ServiceLayerEdgeStore is the read side of the M2 projection.
type ServiceLayerEdgeStore interface {
	// ServiceLayerMappings returns the live source -> target mapping for one
	// model pair of the M1 batch.
	ServiceLayerMappings(ctx context.Context, batch, sourceModel, targetModel string) (map[model.ID]model.ID, error)

	// LegacyServiceApplicationEdges returns the live service -> application
	// DEPENDS_ON edges the projection derives from.
	LegacyServiceApplicationEdges(ctx context.Context, serviceTypeID, applicationTypeID model.ID) ([]ServiceLayerLegacyEdge, error)

	// ServiceLayerEdgeBetween returns the relation type of a live edge between
	// the pair, if one exists.
	ServiceLayerEdgeBetween(ctx context.Context, firstCIID, secondCIID model.ID) (model.ID, bool, error)

	// ServiceLayerContainingParent returns the business service that already
	// contains the child under the relation type, if any.
	ServiceLayerContainingParent(ctx context.Context, childCIID, relationTypeID model.ID) (model.ID, bool, error)
}

// ServiceLayerLegacyEdge is one legacy source pair to project.
type ServiceLayerLegacyEdge struct {
	ServiceCIID     model.ID
	ApplicationCIID model.ID
}

// WithServiceLayerEdges injects the M2 projection store.
func (u *Usecase) WithServiceLayerEdges(store ServiceLayerEdgeStore) *Usecase {
	u.layerEdges = store
	return u
}

// ServiceLayerEdgeApplyInput is one projection run.
type ServiceLayerEdgeApplyInput struct {
	DryRun bool
}

// ServiceLayerEdgeApplyReport lists what the projection did or would do.
type ServiceLayerEdgeApplyReport struct {
	DryRun   bool                      `json:"dry_run"`
	Batch    string                    `json:"batch"`
	Created  []ServiceLayerEdgeRow     `json:"created,omitempty"`
	Existing []ServiceLayerEdgeRow     `json:"existing,omitempty"`
	Skipped  []ServiceLayerEdgeSkipped `json:"skipped,omitempty"`
	Total    int                       `json:"total"`
}

type ServiceLayerEdgeRow struct {
	SourceCIID             model.ID `json:"source_ci_id"`
	ApplicationCIID        model.ID `json:"application_ci_id"`
	BusinessServiceCIID    model.ID `json:"business_service_ci_id"`
	ApplicationServiceCIID model.ID `json:"application_service_ci_id"`
}

type ServiceLayerEdgeSkipped struct {
	SourceCIID      model.ID `json:"source_ci_id"`
	ApplicationCIID model.ID `json:"application_ci_id"`
	Reason          string   `json:"reason"`
}

// ApplyServiceEdges projects the mapped legacy edges into the service layers.
func (u *Usecase) ApplyServiceEdges(ctx context.Context, in ServiceLayerEdgeApplyInput) (*ServiceLayerEdgeApplyReport, error) {
	if u.repo == nil || u.types == nil {
		return nil, errs.ErrNotWiredYet
	}
	if u.layerEdges == nil {
		return nil, fmt.Errorf("cmdb ci: service layer edges: store not configured")
	}
	serviceSet, err := u.types.ResolveForCI(ctx, "service")
	if err != nil {
		return nil, err
	}
	applicationSet, err := u.types.ResolveForCI(ctx, "application")
	if err != nil {
		return nil, err
	}
	businessSet, err := u.types.ResolveForCI(ctx, "business_service")
	if err != nil {
		return nil, err
	}
	applicationServiceSet, err := u.types.ResolveForCI(ctx, "application_service")
	if err != nil {
		return nil, err
	}
	if serviceSet == nil || applicationSet == nil || businessSet == nil || applicationServiceSet == nil {
		return nil, fmt.Errorf("%w: the service layer models are not all present", errs.ErrNotFound)
	}
	rule, ok, err := u.types.RelationBetween(ctx, businessSet.Type.ID, applicationServiceSet.Type.ID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("%w: business_service -> application_service", ErrRelationTypeUndeclared)
	}

	serviceMappings, err := u.layerEdges.ServiceLayerMappings(ctx, serviceLayerBatch, "service", "business_service")
	if err != nil {
		return nil, err
	}
	applicationMappings, err := u.layerEdges.ServiceLayerMappings(ctx, serviceLayerBatch, "application", "application_service")
	if err != nil {
		return nil, err
	}
	legacy, err := u.layerEdges.LegacyServiceApplicationEdges(ctx, serviceSet.Type.ID, applicationSet.Type.ID)
	if err != nil {
		return nil, err
	}
	report := &ServiceLayerEdgeApplyReport{DryRun: in.DryRun, Batch: serviceLayerEdgeBatch}
	claimed := make(map[model.ID]model.ID)

	for _, edge := range legacy {
		businessTarget, ok := serviceMappings[edge.ServiceCIID]
		if !ok {
			report.Skipped = append(report.Skipped, ServiceLayerEdgeSkipped{
				SourceCIID: edge.ServiceCIID, ApplicationCIID: edge.ApplicationCIID,
				Reason: "the service has no business_service mapping",
			})
			continue
		}
		applicationTarget, ok := applicationMappings[edge.ApplicationCIID]
		if !ok {
			report.Skipped = append(report.Skipped, ServiceLayerEdgeSkipped{
				SourceCIID: edge.ServiceCIID, ApplicationCIID: edge.ApplicationCIID,
				Reason: "the application has no application_service mapping",
			})
			continue
		}
		row := ServiceLayerEdgeRow{
			SourceCIID: edge.ServiceCIID, ApplicationCIID: edge.ApplicationCIID,
			BusinessServiceCIID: businessTarget, ApplicationServiceCIID: applicationTarget,
		}
		if relationTypeID, exists, err := u.layerEdges.ServiceLayerEdgeBetween(ctx, businessTarget, applicationTarget); err != nil {
			return nil, err
		} else if exists {
			if relationTypeID == rule.RelationTypeID {
				report.Existing = append(report.Existing, row)
			} else {
				report.Skipped = append(report.Skipped, ServiceLayerEdgeSkipped{
					SourceCIID: edge.ServiceCIID, ApplicationCIID: edge.ApplicationCIID,
					Reason: fmt.Sprintf("the pair already has a relation of type %d, not the containment type %d",
						relationTypeID, rule.RelationTypeID),
				})
			}
			continue
		}
		if owner, ok := claimed[applicationTarget]; ok {
			report.Skipped = append(report.Skipped, ServiceLayerEdgeSkipped{
				SourceCIID: edge.ServiceCIID, ApplicationCIID: edge.ApplicationCIID,
				Reason: fmt.Sprintf("application_service %d is already contained by business_service %d in this batch",
					applicationTarget, owner),
			})
			continue
		}
		if parent, exists, err := u.layerEdges.ServiceLayerContainingParent(ctx, applicationTarget, rule.RelationTypeID); err != nil {
			return nil, err
		} else if exists {
			report.Skipped = append(report.Skipped, ServiceLayerEdgeSkipped{
				SourceCIID: edge.ServiceCIID, ApplicationCIID: edge.ApplicationCIID,
				Reason: fmt.Sprintf("application_service %d is already contained by business_service %d",
					applicationTarget, parent),
			})
			continue
		}
		if in.DryRun {
			report.Created = append(report.Created, row)
			claimed[applicationTarget] = businessTarget
			continue
		}
		if _, err := u.AddRelation(ctx, AddRelationRequest{
			FirstCIID:      businessTarget,
			SecondCIID:     applicationTarget,
			EvidenceSource: string(model.RelationEvidenceInference),
		}, AuditInfo{}); err != nil {
			if errors.Is(err, ErrRelationConstraint) {
				report.Skipped = append(report.Skipped, ServiceLayerEdgeSkipped{
					SourceCIID: edge.ServiceCIID, ApplicationCIID: edge.ApplicationCIID,
					Reason: err.Error(),
				})
				continue
			}
			return nil, fmt.Errorf("cmdb ci: service layer edges: project %d -> %d: %w",
				edge.ServiceCIID, edge.ApplicationCIID, err)
		}
		report.Created = append(report.Created, row)
		claimed[applicationTarget] = businessTarget
	}
	report.Total = len(report.Created) + len(report.Existing) + len(report.Skipped)
	return report, nil
}
