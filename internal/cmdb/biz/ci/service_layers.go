package ci

import (
	"context"
	"fmt"
	"strings"
	"time"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
	"github.com/ongridio/ongrid/internal/cmdb/model/value"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// The M1 service-layer apply (RFC-011).
//
// IT IS ADDITIVE AND RESUMABLE. Source instances stay untouched; a target CI is
// created (or updated by its identifying value), and a mapping row links the
// two. A rerun skips a source that already has a live target mapping, so a
// failure half-way through leaves a consistent prefix rather than duplicates.
//
// `application` AND `app_instance` MAP DETERMINISTICALLY to the two lower
// layers. `service` is evidence-gated: only a service that aggregates
// applications or belongs to a product is projected to business_service, and a
// service-to-service connection still stays in the review queue.

const serviceLayerBatch = "service-layers"

var serviceLayerApplyMappings = []struct {
	Source, Target string
	// Classify gates the source on live relation evidence. Only `service` needs
	// it: application and app_instance map deterministically.
	Classify bool
}{
	{Source: "application", Target: "application_service"},
	{Source: "app_instance", Target: "service_instance"},
	{Source: "service", Target: "business_service", Classify: true},
}

// ServiceLayerEvidence is the live relation evidence behind the RFC-011
// service classification. The planner and the apply both read it, so a
// recommendation and the applied target cannot disagree.
type ServiceLayerEvidence struct {
	// ApplicationTargets is the number of distinct applications this service
	// depends on. The conservative M1 rule accepts exactly one application
	// implementation; zero or several targets need the per-edge M2 decision.
	ApplicationTargets int

	// BelongsToProduct, CoveredBySLA and ManagedByMembers are the three
	// governance anchors. A service is a business capability only when all
	// three are present.
	BelongsToProduct int
	CoveredBySLA     int
	ManagedByMembers int

	// ConnectsToOutbound / ConnectsToInbound count service-to-service
	// CONNECTS_TO edges. Without APM evidence the layer of either endpoint is
	// undecided.
	ConnectsToOutbound int
	ConnectsToInbound  int

	// AssetUseType, Environment and Level are the source attribute values the
	// gates read. Empty means the model does not carry the attribute.
	AssetUseType string
	Environment  string
	Level        string
}

// ServiceLayerFacts is the per-instance input the caller already has: the
// identity and whether another instance shares it. The evidence carries the
// rest.
type ServiceLayerFacts struct {
	Identifier string
	Duplicate  bool
	Evidence   ServiceLayerEvidence
}

// ClassifyServiceLayer is the conservative M1 rule. It NEVER returns
// application_service for a legacy `service`: the layer of a service-to-service
// endpoint needs APM evidence or a per-item decision, so it stays in review.
//
// THE GATES ARE ORDERED so the reason names the first fact that blocks the
// classification. `ledger` is the only positive non-default asset_use_type;
// `business` may be the attribute default, so the graph and the governance
// anchors carry the rest of the decision.
func ClassifyServiceLayer(facts ServiceLayerFacts) (target, reason string) {
	if strings.TrimSpace(facts.Identifier) == "" {
		return "", "missing the model's unique identifier"
	}
	if facts.Duplicate {
		return "", "duplicate unique identifier " + facts.Identifier
	}
	ev := facts.Evidence
	if !strings.EqualFold(ev.AssetUseType, "business") {
		value := strings.TrimSpace(ev.AssetUseType)
		if value == "" {
			value = "unknown"
		}
		return "", "asset_use_type=" + value + "; only business entries enter the business layer"
	}
	if ev.ConnectsToOutbound+ev.ConnectsToInbound > 0 {
		return "", fmt.Sprintf(
			"service-to-service CONNECTS_TO (out %d / in %d); no APM CALLS evidence, layer decision deferred to M2",
			ev.ConnectsToOutbound, ev.ConnectsToInbound)
	}
	if !strings.EqualFold(ev.Environment, "prod") {
		value := strings.TrimSpace(ev.Environment)
		if value == "" {
			value = "unknown"
		}
		return "", "environment=" + value + "; only production entries enter the business roll-up"
	}
	if strings.EqualFold(ev.Level, "experimental") {
		return "", "level=experimental; excluded from the production roll-up"
	}
	if ev.ApplicationTargets != 1 {
		return "", fmt.Sprintf(
			"%d application targets; CONTAINS vs technical dependency is a per-edge M2 decision",
			ev.ApplicationTargets)
	}
	missing := make([]string, 0, 3)
	if ev.BelongsToProduct == 0 {
		missing = append(missing, "product HAS_BELONGING")
	}
	if ev.CoveredBySLA == 0 {
		missing = append(missing, "SLA COVERS")
	}
	if ev.ManagedByMembers == 0 {
		missing = append(missing, "members manage")
	}
	if len(missing) > 0 {
		return "", "missing governance anchors: " + strings.Join(missing, ", ")
	}
	return "business_service", "production business service with one application implementation and all governance anchors"
}

// LayerMappingStore is the migration bookkeeping the apply needs. It is a
// separate port (not part of Repo) so the existing read/write fakes do not have
// to grow a method they never use.
type LayerMappingStore interface {
	LayerMappingFor(ctx context.Context, sourceCIID model.ID, targetModel string) (*cimodel.LayerMapping, error)
	SaveLayerMapping(ctx context.Context, mapping *cimodel.LayerMapping) error

	// ServiceLayerEvidence is the read side of the service classification. It
	// shares the planner's query so a recommendation and an applied target
	// cannot disagree.
	ServiceLayerEvidence(ctx context.Context, sourceTypeID model.ID) (map[model.ID]ServiceLayerEvidence, error)
}

// WithLayerMappings injects the M1 mapping store.
func (u *Usecase) WithLayerMappings(store LayerMappingStore) *Usecase {
	u.layerMappings = store
	return u
}

type ServiceLayerApplyInput struct {
	DryRun bool

	// ClassifyService enables the evidence-gated `service` classification. It
	// is off by default: the RFC requires owner sign-off on the planner's
	// recommendation list before the apply writes business_service targets.
	ClassifyService bool
}

type ServiceLayerApplyReport struct {
	DryRun   bool                     `json:"dry_run"`
	Batch    string                   `json:"batch"`
	Created  []ServiceLayerAppliedRow `json:"created,omitempty"`
	Existing []ServiceLayerAppliedRow `json:"existing,omitempty"`
	Skipped  []ServiceLayerSkippedRow `json:"skipped,omitempty"`
	Total    int                      `json:"total"`
}

type ServiceLayerAppliedRow struct {
	SourceModel string   `json:"source_model"`
	SourceCIID  model.ID `json:"source_ci_id"`
	TargetModel string   `json:"target_model"`
	TargetCIID  model.ID `json:"target_ci_id,omitempty"`
	Name        string   `json:"name,omitempty"`
}

type ServiceLayerSkippedRow struct {
	SourceModel string   `json:"source_model"`
	SourceCIID  model.ID `json:"source_ci_id"`
	Name        string   `json:"name,omitempty"`
	Reason      string   `json:"reason"`
}

// ApplyServiceLayers projects the deterministic source models into the service
// layers. A dry run reports the same rows without writing.
func (u *Usecase) ApplyServiceLayers(ctx context.Context, in ServiceLayerApplyInput) (*ServiceLayerApplyReport, error) {
	if u.repo == nil || u.types == nil {
		return nil, errs.ErrNotWiredYet
	}
	if u.layerMappings == nil {
		return nil, fmt.Errorf("cmdb ci: service layers: mapping store not configured")
	}
	report := &ServiceLayerApplyReport{DryRun: in.DryRun, Batch: serviceLayerBatch}

	for _, mapping := range serviceLayerApplyMappings {
		sourceSet, err := u.types.ResolveForCI(ctx, mapping.Source)
		if err != nil {
			return nil, err
		}
		if sourceSet == nil {
			continue
		}
		targetSet, err := u.types.ResolveForCI(ctx, mapping.Target)
		if err != nil {
			return nil, err
		}
		if targetSet == nil {
			return nil, fmt.Errorf("%w: service layer target %q", errs.ErrNotFound, mapping.Target)
		}

		sourceCIs, err := u.listAllCIs(ctx, sourceSet.Type.ID)
		if err != nil {
			return nil, fmt.Errorf("cmdb ci: service layers: list %s: %w", mapping.Source, err)
		}
		if len(sourceCIs) == 0 {
			continue
		}
		ids := make([]model.ID, 0, len(sourceCIs))
		for _, ci := range sourceCIs {
			ids = append(ids, ci.ID)
		}
		values, err := u.repo.ValueRowsForCIs(ctx, ids)
		if err != nil {
			return nil, fmt.Errorf("cmdb ci: service layers: values of %s: %w", mapping.Source, err)
		}
		var evidence map[model.ID]ServiceLayerEvidence
		if mapping.Classify && in.ClassifyService {
			evidence, err = u.layerMappings.ServiceLayerEvidence(ctx, sourceSet.Type.ID)
			if err != nil {
				return nil, fmt.Errorf("cmdb ci: service layers: evidence of %s: %w", mapping.Source, err)
			}
		}

		identifiers := make(map[model.ID]string, len(sourceCIs))
		uniqueRows := make(map[model.ID]ValueRow, len(sourceCIs))
		uniqueCounts := make(map[string]int, len(sourceCIs))
		for _, ci := range sourceCIs {
			row, ok := valueRowOf(values[ci.ID], sourceSet.UniqueAttrID)
			if ok {
				uniqueRows[ci.ID] = row
			}
			identifier := ""
			if ok {
				identifier = valueLabel(row)
			}
			identifiers[ci.ID] = identifier
			if identifier != "" {
				uniqueCounts[identifier]++
			}
		}

		for _, ci := range sourceCIs {
			identifier := identifiers[ci.ID]
			nameRow, _ := valueRowOf(values[ci.ID], sourceSet.ShowAttr.ID)
			name := valueLabel(nameRow)
			if name == "" {
				name = identifier
			}
			reason := ""
			switch {
			case identifier == "":
				reason = "missing the model's unique identifier"
			case uniqueCounts[identifier] > 1:
				reason = "duplicate unique identifier " + identifier
			}
			if reason != "" {
				report.Skipped = append(report.Skipped, ServiceLayerSkippedRow{
					SourceModel: mapping.Source, SourceCIID: ci.ID, Name: name, Reason: reason,
				})
				continue
			}

			if existing, err := u.layerMappings.LayerMappingFor(ctx, ci.ID, mapping.Target); err != nil {
				return nil, err
			} else if existing != nil {
				if target, err := u.repo.LoadCI(ctx, existing.TargetCIID); err != nil {
					return nil, err
				} else if target != nil {
					report.Existing = append(report.Existing, ServiceLayerAppliedRow{
						SourceModel: mapping.Source, SourceCIID: ci.ID,
						TargetModel: mapping.Target, TargetCIID: existing.TargetCIID, Name: name,
					})
					continue
				}
			}

			// A classified source keeps its evidence gate after the resume
			// check: an already-mapped source stays "existing" even if the
			// graph changed, and only a source the rule can place is written.
			if mapping.Classify {
				if !in.ClassifyService {
					report.Skipped = append(report.Skipped, ServiceLayerSkippedRow{
						SourceModel: mapping.Source, SourceCIID: ci.ID, Name: name,
						Reason: "service classification requires --classify-service after owner review",
					})
					continue
				}
				target, reason := ClassifyServiceLayer(ServiceLayerFacts{
					Identifier: identifiers[ci.ID],
					Duplicate:  uniqueCounts[identifiers[ci.ID]] > 1,
					Evidence:   evidence[ci.ID],
				})
				if target == "" {
					report.Skipped = append(report.Skipped, ServiceLayerSkippedRow{
						SourceModel: mapping.Source, SourceCIID: ci.ID, Name: name, Reason: reason,
					})
					continue
				}
				if target != mapping.Target {
					report.Skipped = append(report.Skipped, ServiceLayerSkippedRow{
						SourceModel: mapping.Source, SourceCIID: ci.ID, Name: name,
						Reason: "classified as " + target + ", but this mapping targets " + mapping.Target,
					})
					continue
				}
			}

			if in.DryRun {
				report.Created = append(report.Created, ServiceLayerAppliedRow{
					SourceModel: mapping.Source, SourceCIID: ci.ID, TargetModel: mapping.Target, Name: name,
				})
				continue
			}

			targetValues := serviceLayerTargetValues(
				sourceSet, targetSet, values[ci.ID], uniqueRows[ci.ID], nameRow,
			)
			written, err := u.Create(ctx, WriteRequest{
				TypeRef:     targetSet.Type.Name,
				Values:      targetValues,
				ExistPolicy: ExistReplace,
			})
			if err != nil {
				return nil, fmt.Errorf("cmdb ci: service layers: create %s for %s %d: %w", mapping.Target, mapping.Source, ci.ID, err)
			}
			mappingRow := &cimodel.LayerMapping{
				Batch:       serviceLayerBatch,
				SourceModel: mapping.Source,
				SourceCIID:  ci.ID,
				TargetModel: mapping.Target,
				TargetCIID:  written.CIID,
			}
			if err := u.layerMappings.SaveLayerMapping(ctx, mappingRow); err != nil {
				return nil, err
			}
			row := ServiceLayerAppliedRow{
				SourceModel: mapping.Source, SourceCIID: ci.ID,
				TargetModel: mapping.Target, TargetCIID: written.CIID, Name: name,
			}
			if written.Created {
				report.Created = append(report.Created, row)
			} else {
				report.Existing = append(report.Existing, row)
			}
		}
	}
	report.Total = len(report.Created) + len(report.Existing) + len(report.Skipped)
	return report, nil
}

func (u *Usecase) listAllCIs(ctx context.Context, typeID model.ID) ([]cimodel.CI, error) {
	const pageSize = 500
	var out []cimodel.CI
	for offset := 0; ; offset += pageSize {
		page, total, err := u.repo.ListCIsByType(ctx, typeID, pageSize, offset)
		if err != nil {
			return nil, err
		}
		out = append(out, page...)
		if len(page) == 0 || int64(len(out)) >= total {
			return out, nil
		}
	}
}

func valueRowOf(rows []ValueRow, attrID model.ID) (ValueRow, bool) {
	if attrID == 0 {
		return ValueRow{}, false
	}
	for _, row := range rows {
		if row.AttrID == attrID {
			return row, true
		}
	}
	return ValueRow{}, false
}

func valueLabel(row ValueRow) string {
	switch row.Table {
	case value.TableIndexTexts, value.TableTexts:
		return row.Text
	case value.TableIndexIntegers:
		return fmt.Sprint(int64(row.Int))
	case value.TableIndexFloats:
		return fmt.Sprint(row.Float)
	case value.TableIndexDateTime:
		return row.Time.Format(time.RFC3339)
	default:
		return ""
	}
}

func valueRowAny(row ValueRow) (any, bool) {
	switch row.Table {
	case value.TableIndexTexts, value.TableTexts:
		return row.Text, true
	case value.TableIndexIntegers:
		return int64(row.Int), true
	case value.TableIndexFloats:
		return row.Float, true
	case value.TableIndexDateTime:
		return row.Time, true
	case value.TableJSON:
		return row.JSON, true
	default:
		return nil, false
	}
}

// serviceLayerTargetValues builds the target attribute values: the target's
// own identity and show attributes come from the source's unique/show values;
// every other target attribute is copied when the source has one with the same
// name. The target values are keyed by NAME, which the write path resolves.
func serviceLayerTargetValues(source, target *AttributeSet, rows []ValueRow, identifier, name ValueRow) map[string]any {
	out := make(map[string]any, len(target.Specs))
	for _, spec := range target.Specs {
		if spec.ID == target.UniqueAttrID || spec.ID == target.ShowAttr.ID {
			continue
		}
		sourceID, ok := source.ByName[spec.Name]
		if !ok {
			continue
		}
		sourceSpec, ok := source.Specs[sourceID]
		if !ok {
			continue
		}
		if row, ok := valueRowOf(rows, sourceSpec.ID); ok {
			if v, ok := valueRowAny(row); ok {
				out[spec.Name] = v
			}
		}
	}
	if v, ok := valueRowAny(identifier); ok {
		out[target.UniqueAttr.Name] = v
	}
	// A model with no show binding falls back to its unique attribute, and the
	// two then name the same field. Writing the display name here would
	// overwrite the identity — the built-in service models have exactly that
	// shape, and two source instances sharing a display name collapsed onto one
	// target before this guard existed.
	if target.ShowAttr.Name != "" && target.ShowAttr.ID != target.UniqueAttr.ID {
		if v, ok := valueRowAny(name); ok {
			out[target.ShowAttr.Name] = v
		}
	}
	return out
}
