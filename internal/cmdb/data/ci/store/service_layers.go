package store

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"

	cibiz "github.com/ongridio/ongrid/internal/cmdb/biz/ci"
	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
	"github.com/ongridio/ongrid/internal/cmdb/model/value"
)

// PlanServiceLayers is the READ-ONLY first half of the RFC-011 M1 migration.
//
// It maps the conventional source models to the three target layers and reports
// what can be classified confidently and what needs a human decision. It writes
// nothing: creating the target CIs and the ID mapping is a separate, explicit
// apply step after the review queue is empty.
type ServiceLayerPlan struct {
	Rows            []ServiceLayerPlanRow        `json:"rows"`
	Review          []ServiceLayerReviewRow      `json:"review,omitempty"`
	Recommendations []ServiceLayerRecommendation `json:"recommendations,omitempty"`
	MissingSources  []string                     `json:"missing_sources,omitempty"`
	MissingTargets  []string                     `json:"missing_targets,omitempty"`
	TotalInstances  int64                        `json:"total_instances"`
	Confident       int64                        `json:"confident"`
	ReviewCount     int64                        `json:"review_count"`
	Recommended     int64                        `json:"recommended"`
}

type ServiceLayerPlanRow struct {
	SourceModel string `json:"source_model"`
	TargetModel string `json:"target_model"`
	Instances   int64  `json:"instances"`
	Confident   int64  `json:"confident"`
	Review      int64  `json:"review"`
	Recommended int64  `json:"recommended"`
	Reason      string `json:"reason,omitempty"`
}

// ServiceLayerRecommendation is a review item the evidence rule can place. It
// is still in the review queue: the apply is what writes the target.
type ServiceLayerRecommendation struct {
	SourceModel string   `json:"source_model"`
	CIID        model.ID `json:"ci_id"`
	Name        string   `json:"name,omitempty"`
	TargetModel string   `json:"target_model"`
	Reason      string   `json:"reason"`
}

type ServiceLayerReviewRow struct {
	SourceModel string   `json:"source_model"`
	CIID        model.ID `json:"ci_id"`
	Name        string   `json:"name,omitempty"`
	Reason      string   `json:"reason"`
}

var serviceLayerSources = []struct {
	Source string
	Target string
	// Ambiguous means every instance needs a decision even when it has an
	// identifier: `service` can be a business service or an application
	// service, and the model alone cannot tell.
	Ambiguous bool
	Reason    string
}{
	{Source: "application", Target: "application_service"},
	{Source: "app_instance", Target: "service_instance"},
	{
		Source: "service", Target: "business_service", Ambiguous: true,
		Reason: "the model holds both business and application services; only the evidence-gated business subset is applied, the rest stays for review",
	},
}

// PlanServiceLayers reads the conventional source models and their instances.
func PlanServiceLayers(ctx context.Context, db *gorm.DB) (*ServiceLayerPlan, error) {
	if db == nil {
		return nil, errNilDB
	}
	repo := NewRepo(db)
	plan := &ServiceLayerPlan{Rows: []ServiceLayerPlanRow{}}

	targetNames := []string{"business_service", "application_service", "service_instance"}
	var targetTypes []citypemodel.CIType
	if err := db.WithContext(ctx).Where("name IN ?", targetNames).Find(&targetTypes).Error; err != nil {
		return nil, fmt.Errorf("cmdb ci: plan service layers: load targets: %w", err)
	}
	present := make(map[string]bool, len(targetTypes))
	for _, ct := range targetTypes {
		present[ct.Name] = true
	}
	for _, name := range targetNames {
		if !present[name] {
			plan.MissingTargets = append(plan.MissingTargets, name)
		}
	}

	for _, source := range serviceLayerSources {
		var ct citypemodel.CIType
		err := db.WithContext(ctx).Where("name = ?", source.Source).First(&ct).Error
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			plan.MissingSources = append(plan.MissingSources, source.Source)
			continue
		case err != nil:
			return nil, fmt.Errorf("cmdb ci: plan service layers: load %s: %w", source.Source, err)
		}

		var cis []cimodel.CI
		if err := db.WithContext(ctx).Where("type_id = ?", ct.ID).Order("id").Find(&cis).Error; err != nil {
			return nil, fmt.Errorf("cmdb ci: plan service layers: list %s: %w", source.Source, err)
		}
		row := ServiceLayerPlanRow{
			SourceModel: source.Source, TargetModel: source.Target,
			Instances: int64(len(cis)), Reason: source.Reason,
		}
		if len(cis) == 0 {
			plan.Rows = append(plan.Rows, row)
			continue
		}

		ids := make([]model.ID, 0, len(cis))
		for _, ci := range cis {
			ids = append(ids, ci.ID)
		}
		values, err := repo.ValueRowsForCIs(ctx, ids)
		if err != nil {
			return nil, fmt.Errorf("cmdb ci: plan service layers: values of %s: %w", source.Source, err)
		}
		var evidence map[model.ID]cibiz.ServiceLayerEvidence
		if source.Ambiguous {
			evidence, err = repo.ServiceLayerEvidence(ctx, ct.ID)
			if err != nil {
				return nil, fmt.Errorf("cmdb ci: plan service layers: evidence of %s: %w", source.Source, err)
			}
		}

		names := make(map[model.ID]string, len(cis))
		identifiers := make(map[model.ID]string, len(cis))
		counts := make(map[string]int, len(cis))
		for _, ci := range cis {
			names[ci.ID] = serviceLayerLabel(values[ci.ID], ct.ShowID, &ct.UniqueID)
			identifiers[ci.ID] = serviceLayerLabel(values[ci.ID], &ct.UniqueID, nil)
			if identifiers[ci.ID] != "" {
				counts[identifiers[ci.ID]]++
			}
		}

		for _, ci := range cis {
			reason := ""
			switch {
			case identifiers[ci.ID] == "":
				reason = "missing the model's unique identifier"
			case counts[identifiers[ci.ID]] > 1:
				reason = "duplicate unique identifier " + identifiers[ci.ID]
			case source.Ambiguous:
				target, classReason := cibiz.ClassifyServiceLayer(cibiz.ServiceLayerFacts{
					Identifier: identifiers[ci.ID],
					Duplicate:  counts[identifiers[ci.ID]] > 1,
					Evidence:   evidence[ci.ID],
				})
				if target == "" {
					reason = classReason
					break
				}
				// A recommendation is still a review item: the apply is what
				// writes the target, and a person owns that decision.
				row.Recommended++
				plan.Recommendations = append(plan.Recommendations, ServiceLayerRecommendation{
					SourceModel: source.Source, CIID: ci.ID, Name: names[ci.ID],
					TargetModel: target, Reason: classReason,
				})
				reason = "recommended " + target + ": " + classReason
			}
			if reason == "" {
				row.Confident++
				continue
			}
			row.Review++
			plan.Review = append(plan.Review, ServiceLayerReviewRow{
				SourceModel: source.Source, CIID: ci.ID, Name: names[ci.ID], Reason: reason,
			})
		}
		plan.Rows = append(plan.Rows, row)
		plan.TotalInstances += row.Instances
		plan.Confident += row.Confident
		plan.ReviewCount += row.Review
		plan.Recommended += row.Recommended
	}
	return plan, nil
}

// serviceLayerLabel returns the value of attrID, falling back to fallbackID.
// The display name and the identifier are both ordinary values; the caller
// passes them in that order.
func serviceLayerLabel(values []cibiz.ValueRow, attrID, fallbackID *model.ID) string {
	byAttr := make(map[model.ID]cibiz.ValueRow, len(values))
	for _, row := range values {
		byAttr[row.AttrID] = row
	}
	if attrID != nil {
		if row, ok := byAttr[*attrID]; ok {
			if label := valueLabel(row); label != "" {
				return label
			}
		}
	}
	if fallbackID != nil {
		if row, ok := byAttr[*fallbackID]; ok {
			return valueLabel(row)
		}
	}
	return ""
}

func valueLabel(row cibiz.ValueRow) string {
	switch row.Table {
	case value.TableIndexTexts:
		return strings.TrimSpace(row.Text)
	case value.TableIndexIntegers:
		return strconv.FormatInt(int64(row.Int), 10)
	case value.TableIndexFloats:
		return strconv.FormatFloat(row.Float, 'f', -1, 64)
	case value.TableIndexDateTime:
		return row.Time.Format(time.RFC3339)
	default:
		return ""
	}
}

// ServiceLayerEvidence reports the live relation evidence behind the RFC-011
// service classification, keyed by source CI.
//
// THE ENDS ARE MATCHED BY TYPE ID, NOT BY MODEL NAME. The peer checks use the
// governed vocabulary the relation split created (DEPENDS_ON, HAS_BELONGING,
// COVERS, manage, CONNECTS_TO) and read only live rows; the three attribute
// values the gates need are loaded by name. A model that does not carry one of
// them leaves the field empty and the classifier sends the instance to review.
func (r *Repo) ServiceLayerEvidence(ctx context.Context, sourceTypeID model.ID) (map[model.ID]cibiz.ServiceLayerEvidence, error) {
	if r.db == nil {
		return nil, errNilDB
	}
	out := make(map[model.ID]cibiz.ServiceLayerEvidence)
	if sourceTypeID == 0 {
		return out, nil
	}
	var rows []struct {
		FirstCI      model.ID `gorm:"column:first_ci_id"`
		SecondCI     model.ID `gorm:"column:second_ci_id"`
		Relation     string   `gorm:"column:rel"`
		Category     string   `gorm:"column:category"`
		FirstType    string   `gorm:"column:first_type"`
		SecondType   string   `gorm:"column:second_type"`
		FirstTypeID  model.ID `gorm:"column:first_type_id"`
		SecondTypeID model.ID `gorm:"column:second_type_id"`
	}
	if err := r.db.WithContext(ctx).Raw(`SELECT cr.first_ci_id, cr.second_ci_id,
			rt.name AS rel, rt.category AS category,
			ft.name AS first_type, st.name AS second_type,
			f.type_id AS first_type_id, s.type_id AS second_type_id
		FROM c_ci_relations cr
		JOIN c_relation_types rt ON rt.id = cr.relation_type_id
		JOIN c_cis f ON f.id = cr.first_ci_id
		JOIN c_ci_types ft ON ft.id = f.type_id
		JOIN c_cis s ON s.id = cr.second_ci_id
		JOIN c_ci_types st ON st.id = s.type_id
		WHERE cr.deleted_at IS NULL AND rt.deleted_at IS NULL
			AND f.deleted_at IS NULL AND s.deleted_at IS NULL
			AND (f.type_id = ? OR s.type_id = ?)`,
		sourceTypeID, sourceTypeID).Scan(&rows).Error; err != nil {
		return nil, fmt.Errorf("cmdb ci: service layer evidence: %w", err)
	}
	add := func(ciID model.ID, apply func(*cibiz.ServiceLayerEvidence)) {
		ev := out[ciID]
		apply(&ev)
		out[ciID] = ev
	}
	applicationTargets := make(map[model.ID]map[model.ID]bool)
	for _, row := range rows {
		firstIsSource := row.FirstTypeID == sourceTypeID
		secondIsSource := row.SecondTypeID == sourceTypeID
		if firstIsSource && row.Relation == "DEPENDS_ON" && row.SecondType == "application" {
			if applicationTargets[row.FirstCI] == nil {
				applicationTargets[row.FirstCI] = make(map[model.ID]bool)
			}
			applicationTargets[row.FirstCI][row.SecondCI] = true
		}
		if secondIsSource && row.FirstType == "product" && row.Category == "structure" {
			add(row.SecondCI, func(ev *cibiz.ServiceLayerEvidence) { ev.BelongsToProduct++ })
		}
		if secondIsSource && row.FirstType == "sla" && row.Relation == "COVERS" {
			add(row.SecondCI, func(ev *cibiz.ServiceLayerEvidence) { ev.CoveredBySLA++ })
		}
		if secondIsSource && row.FirstType == "members" && row.Relation == "manage" {
			add(row.SecondCI, func(ev *cibiz.ServiceLayerEvidence) { ev.ManagedByMembers++ })
		}
		if row.Relation == "CONNECTS_TO" && firstIsSource && secondIsSource {
			add(row.FirstCI, func(ev *cibiz.ServiceLayerEvidence) { ev.ConnectsToOutbound++ })
			add(row.SecondCI, func(ev *cibiz.ServiceLayerEvidence) { ev.ConnectsToInbound++ })
		}
	}
	for ciID, targets := range applicationTargets {
		ev := out[ciID]
		ev.ApplicationTargets = len(targets)
		out[ciID] = ev
	}

	// The gates also read three ordinary attributes. A model that does not carry
	// one leaves the field empty and the classifier sends the instance to review.
	var attrs []struct {
		CIID  model.ID `gorm:"column:ci_id"`
		Attr  string   `gorm:"column:attr"`
		Value string   `gorm:"column:value"`
	}
	if err := r.db.WithContext(ctx).Raw(`SELECT v.ci_id, a.name AS attr, v.value
		FROM c_value_index_texts v
		JOIN c_attributes a ON a.id = v.attr_id
		JOIN c_cis c ON c.id = v.ci_id
		WHERE c.type_id = ? AND c.deleted_at IS NULL AND a.deleted_at IS NULL
			AND a.name IN ?`,
		sourceTypeID, []string{"asset_use_type", "environment", "level"}).
		Scan(&attrs).Error; err != nil {
		return nil, fmt.Errorf("cmdb ci: service layer evidence: attributes: %w", err)
	}
	for _, row := range attrs {
		ev := out[row.CIID]
		switch row.Attr {
		case "asset_use_type":
			ev.AssetUseType = strings.TrimSpace(row.Value)
		case "environment":
			ev.Environment = strings.TrimSpace(row.Value)
		case "level":
			ev.Level = strings.TrimSpace(row.Value)
		}
		out[row.CIID] = ev
	}
	return out, nil
}

// LayerMappingFor returns the mapping for one source and target model, or nil.
func (r *Repo) LayerMappingFor(ctx context.Context, sourceCIID model.ID, targetModel string) (*cimodel.LayerMapping, error) {
	var row cimodel.LayerMapping
	err := r.db.WithContext(ctx).
		Where("source_ci_id = ? AND target_model = ?", sourceCIID, targetModel).
		First(&row).Error
	switch {
	case err == nil:
		return &row, nil
	case errors.Is(err, gorm.ErrRecordNotFound):
		return nil, nil
	default:
		return nil, fmt.Errorf("cmdb ci: service layers: load mapping: %w", err)
	}
}

// SaveLayerMapping upserts the mapping for a source and target model. The apply
// calls it after writing the target, and a retry that finds a stale mapping
// points it at the recreated target instead of adding a second row.
func (r *Repo) SaveLayerMapping(ctx context.Context, mapping *cimodel.LayerMapping) error {
	var existing cimodel.LayerMapping
	err := r.db.WithContext(ctx).
		Where("source_ci_id = ? AND target_model = ?", mapping.SourceCIID, mapping.TargetModel).
		First(&existing).Error
	switch {
	case err == nil:
		return r.db.WithContext(ctx).Model(&existing).Updates(map[string]any{
			"batch":        mapping.Batch,
			"source_model": mapping.SourceModel,
			"target_ci_id": mapping.TargetCIID,
		}).Error
	case errors.Is(err, gorm.ErrRecordNotFound):
		if err := r.db.WithContext(ctx).Create(mapping).Error; err != nil {
			return fmt.Errorf("cmdb ci: service layers: save mapping: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("cmdb ci: service layers: find mapping: %w", err)
	}
}
