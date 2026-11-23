package ci

import (
	"context"
	"errors"
	"testing"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
)

type addRelationRepo struct {
	readRepoStub
	cis   map[model.ID]*cimodel.CI
	added []RelationAddSpec
}

func (r *addRelationRepo) LoadCI(_ context.Context, id model.ID) (*cimodel.CI, error) {
	return r.cis[id], nil
}

func (r *addRelationRepo) AddRelation(_ context.Context, spec RelationAddSpec) (*cimodel.Relation, error) {
	r.added = append(r.added, spec)
	return &cimodel.Relation{
		FirstCIID: spec.FirstCIID, SecondCIID: spec.SecondCIID,
		RelationTypeID: spec.RelationTypeID,
	}, nil
}

type addRelationResolver struct {
	resolverStub
	rule TypeRelationRule
}

func (r *addRelationResolver) RelationBetween(context.Context, model.ID, model.ID) (TypeRelationRule, bool, error) {
	return r.rule, true, nil
}

func addRelationFixture() (*addRelationRepo, *addRelationResolver) {
	first := &cimodel.CI{TypeID: 10}
	first.ID = 1
	second := &cimodel.CI{TypeID: 20}
	second.ID = 2
	repo := &addRelationRepo{cis: map[model.ID]*cimodel.CI{1: first, 2: second}}
	resolver := &addRelationResolver{rule: TypeRelationRule{
		RelationTypeID: 5, Constraint: model.ConstraintOne2Many,
	}}
	return repo, resolver
}

// The model pair's rule is the schema. A caller may omit the type or repeat the
// declared one, but a different label would create an edge the ontology never
// declared.
func TestAddRelationRejectsUndeclaredRelationType(t *testing.T) {
	repo, resolver := addRelationFixture()
	uc := NewUsecase(repo, resolver, nil)

	_, err := uc.AddRelation(context.Background(), AddRelationRequest{
		FirstCIID: 1, SecondCIID: 2, RelationTypeID: 99,
	}, AuditInfo{Actor: 7})
	if !errors.Is(err, ErrRelationTypeMismatch) {
		t.Fatalf("error = %v, want ErrRelationTypeMismatch", err)
	}
	if len(repo.added) != 0 {
		t.Fatalf("edge was written despite the mismatch: %+v", repo.added)
	}
}

func TestAddRelationDefaultsToPairRule(t *testing.T) {
	repo, resolver := addRelationFixture()
	uc := NewUsecase(repo, resolver, nil)

	if _, err := uc.AddRelation(context.Background(), AddRelationRequest{
		FirstCIID: 1, SecondCIID: 2,
	}, AuditInfo{Actor: 7}); err != nil {
		t.Fatalf("AddRelation() error = %v", err)
	}
	if len(repo.added) != 1 || repo.added[0].RelationTypeID != 5 {
		t.Fatalf("added = %+v, want the pair's declared type 5", repo.added)
	}
}

func TestAddRelationAcceptsDeclaredRelationType(t *testing.T) {
	repo, resolver := addRelationFixture()
	uc := NewUsecase(repo, resolver, nil)

	if _, err := uc.AddRelation(context.Background(), AddRelationRequest{
		FirstCIID: 1, SecondCIID: 2, RelationTypeID: 5,
	}, AuditInfo{Actor: 7}); err != nil {
		t.Fatalf("AddRelation() error = %v", err)
	}
	if len(repo.added) != 1 || repo.added[0].RelationTypeID != 5 {
		t.Fatalf("added = %+v", repo.added)
	}
}
