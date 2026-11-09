package ci

import (
	"context"
	"errors"
	"fmt"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// The M1/M2 operator rollback.
//
// IT IS DELIBERATELY NOT A BLIND DELETE. A target whose graph has grown beyond
// the projected containment edges is no longer "the migration's output": a
// person may have attached a dependency, a monitor or an owner. The rollback
// counts every live relation touching a target and refuses unless all of them
// are inferred CONTAINS edges between two targets of the same batch. The report
// names the blocking relations so the operator can resolve them first.
//
// THE MAPPING TABLE IS THE SCOPE. Only the batch's target CIs are candidates;
// the legacy source CIs are never touched.

// ServiceLayerRollbackStore is the read/cleanup side of the rollback.
type ServiceLayerRollbackStore interface {
	LayerMappingsForBatch(ctx context.Context, batch string) ([]cimodel.LayerMapping, error)
	RelationsTouching(ctx context.Context, ciIDs []model.ID) ([]ServiceLayerRelation, error)
	DeleteLayerMappings(ctx context.Context, batch string) (int64, error)
}

// ServiceLayerRelation is one live relation touching a rollback target.
type ServiceLayerRelation struct {
	ID             model.ID
	FirstCIID      model.ID
	SecondCIID     model.ID
	RelationType   string
	EvidenceSource string
}

// WithServiceLayerRollback injects the rollback store.
func (u *Usecase) WithServiceLayerRollback(store ServiceLayerRollbackStore) *Usecase {
	u.layerRollback = store
	return u
}

type ServiceLayerRollbackInput struct {
	DryRun bool
}

type ServiceLayerRollbackReport struct {
	DryRun bool   `json:"dry_run"`
	Batch  string `json:"batch"`

	Mappings      int `json:"mappings"`
	Targets       int `json:"targets"`
	InferredEdges int `json:"inferred_edges"`

	DeletedTargets  int   `json:"deleted_targets,omitempty"`
	DeletedMappings int64 `json:"deleted_mappings,omitempty"`

	// Blocked is non-empty when a live relation is not an inferred containment
	// between two batch targets; the rollback then deletes nothing.
	Blocked []ServiceLayerRollbackBlocked `json:"blocked,omitempty"`
}

type ServiceLayerRollbackBlocked struct {
	RelationID     model.ID `json:"relation_id"`
	FirstCIID      model.ID `json:"first_ci_id"`
	SecondCIID     model.ID `json:"second_ci_id"`
	RelationType   string   `json:"relation_type"`
	EvidenceSource string   `json:"evidence_source"`
}

// RollbackServiceLayers removes the batch's targets, mappings and inferred
// containment edges. A dry run reports the same scope without writing.
func (u *Usecase) RollbackServiceLayers(ctx context.Context, in ServiceLayerRollbackInput) (*ServiceLayerRollbackReport, error) {
	if u.repo == nil {
		return nil, errs.ErrNotWiredYet
	}
	if u.layerRollback == nil {
		return nil, fmt.Errorf("cmdb ci: service layer rollback: store not configured")
	}
	mappings, err := u.layerRollback.LayerMappingsForBatch(ctx, serviceLayerBatch)
	if err != nil {
		return nil, err
	}
	report := &ServiceLayerRollbackReport{DryRun: in.DryRun, Batch: serviceLayerBatch, Mappings: len(mappings)}
	targets := make([]model.ID, 0, len(mappings))
	targetSet := make(map[model.ID]bool, len(mappings))
	for _, mapping := range mappings {
		if !targetSet[mapping.TargetCIID] {
			targetSet[mapping.TargetCIID] = true
			targets = append(targets, mapping.TargetCIID)
		}
	}
	report.Targets = len(targets)

	relations, err := u.layerRollback.RelationsTouching(ctx, targets)
	if err != nil {
		return nil, err
	}
	for _, relation := range relations {
		insideBatch := targetSet[relation.FirstCIID] && targetSet[relation.SecondCIID]
		if relation.RelationType == "CONTAINS" &&
			relation.EvidenceSource == string(model.RelationEvidenceInference) &&
			insideBatch {
			report.InferredEdges++
			continue
		}
		report.Blocked = append(report.Blocked, ServiceLayerRollbackBlocked{
			RelationID: relation.ID, FirstCIID: relation.FirstCIID, SecondCIID: relation.SecondCIID,
			RelationType: relation.RelationType, EvidenceSource: relation.EvidenceSource,
		})
	}
	if in.DryRun || len(report.Blocked) > 0 {
		return report, nil
	}

	for _, id := range targets {
		if err := u.repo.DeleteCI(ctx, id); err != nil {
			// A resumed rollback finds a target it already removed; that is not
			// a failure, and the remaining mappings still have to go.
			if errors.Is(err, errs.ErrNotFound) {
				continue
			}
			return nil, fmt.Errorf("cmdb ci: service layer rollback: delete target %d: %w", id, err)
		}
	}
	deleted, err := u.layerRollback.DeleteLayerMappings(ctx, serviceLayerBatch)
	if err != nil {
		return nil, err
	}
	report.DeletedTargets = len(targets)
	report.DeletedMappings = deleted
	return report, nil
}
