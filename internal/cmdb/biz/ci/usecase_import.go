package ci

import (
	"context"
	"fmt"
	"sort"
	"strings"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// Importing a sheet.
//
// WHAT THE PORT ADDS TO CANTOR HERE IS A BACKEND. cantor's import was the
// console's own: a browser library parsed the file and then posted one instance
// at a time, so a five-thousand-row sheet was five thousand requests, each its
// own transaction, with no record of where it stopped. There was nothing to
// validate against — the console knew the model only as a form — and nothing to
// report: a failure was one request's error among five thousand.
//
// TWO ENDPOINTS, ONE ROW BUILDER. `Preview` answers "what would this do" and
// writes nothing; `Commit` does it in one transaction. They share the row
// builder so a preview cannot promise something the commit then refuses.
//
// THE CONSOLE STILL PARSES THE FILE, and that is a deliberate division: reading
// xlsx is a browser library's job and the alternative is a Go dependency the
// project has not reviewed. What the console sends is the SHEET — headers and
// cells — so the mapping from a column to an attribute, which needs the model,
// happens here.
//
// A SHEET MAY ALSO CARRY RELATION COLUMNS. cantor's `$parent.attribute` header
// named a parent instance by one of its attribute values; here the same header
// is resolved against the parent model and its instances in the preview, and
// the edges are written by the SAME batch transaction as the instances. cantor
// dispatched a Celery task after each create, so a relation could fail without
// the import knowing.

// ImportRequest is one sheet.
type ImportRequest struct {
	// TypeRef names the model the rows are instances of.
	TypeRef string

	// Headers are the sheet's first row, in order.
	Headers []string

	// Rows are the data rows, each a list of cells positioned like the headers.
	// A short row is padded and a long one is ignored, because a spreadsheet is
	// a rectangle only by convention.
	Rows [][]any

	// ExistPolicy decides what a row does when its identifying value is already
	// taken. Empty means reject, which is a create.
	ExistPolicy ExistPolicy

	// NoAttributePolicy decides what happens to a column the model does not
	// carry. Empty means the column is dropped — and it is REPORTED either way,
	// which is what stops a filled-in column from vanishing.
	NoAttributePolicy ExistPolicy

	Audit AuditInfo
}

// ImportPreview is what a sheet would do.
type ImportPreview struct {
	// Total, Valid and Invalid count the data rows.
	Total   int `json:"total"`
	Valid   int `json:"valid"`
	Invalid int `json:"invalid"`

	// Columns is the sheet's attribute columns, matched against the model. It
	// includes the ones that did NOT match, because a column the operator filled
	// in and the port ignored is the failure an import must not have.
	Columns []ImportColumn `json:"columns"`

	// Relations are the sheet's relation columns, `$parent.attribute`, already
	// resolved against the parent model and the model graph. A malformed or
	// unresolvable relation header is a refusal rather than an ignored column:
	// silently dropping it would import every row without the relation the
	// operator asked for.
	Relations []ImportRelationColumn `json:"relations,omitempty"`

	// Rows is one entry per data row, in the sheet's order.
	Rows []ImportRow `json:"rows"`

	// Creates and Updates are the actions the valid rows would take.
	Creates int `json:"creates"`
	Updates int `json:"updates"`
}

// ImportResult is what a commit did.
type ImportResult struct {
	// Written is how many rows were written.
	Written int `json:"written"`

	// Creates and Updates say which kind each was.
	Creates int `json:"creates"`
	Updates int `json:"updates"`

	// Rows is the outcome per row, in the sheet's order, carrying each row's
	// instance id.
	Rows []ImportRow `json:"rows"`
}

// importPlan is the resolved shape of a sheet: the model, its attribute
// columns, and its relation columns. Keeping it one value is what makes the
// preview and the commit share exactly the same mapping.
type importPlan struct {
	set       *AttributeSet
	columns   []ImportColumn
	relations []ImportRelationColumn
}

// PreviewImport validates a sheet and writes nothing.
func (u *Usecase) PreviewImport(ctx context.Context, req ImportRequest) (*ImportPreview, error) {
	if u.repo == nil || u.types == nil {
		return nil, errs.ErrNotWiredYet
	}
	plan, err := u.prepareImport(ctx, req)
	if err != nil {
		return nil, err
	}
	rows, err := u.buildImportRows(ctx, plan, req)
	if err != nil {
		return nil, err
	}
	return summariseImport(plan, rows), nil
}

// CommitImport writes a sheet, in one transaction.
//
// EVERY ROW OR NONE. The alternative — skipping the bad ones and reporting the
// good — leaves an operator with a half-imported sheet to reconcile against the
// file, and no way to tell "the import finished" from "the import stopped". The
// preview is what tells them what to fix.
func (u *Usecase) CommitImport(ctx context.Context, req ImportRequest) (*ImportResult, error) {
	if u.repo == nil || u.types == nil {
		return nil, errs.ErrNotWiredYet
	}
	plan, err := u.prepareImport(ctx, req)
	if err != nil {
		return nil, err
	}
	rows, err := u.buildImportRows(ctx, plan, req)
	if err != nil {
		return nil, err
	}
	preview := summariseImport(plan, rows)
	if preview.Invalid > 0 {
		return nil, fmt.Errorf("%w: %d of %d rows cannot be written (%s)",
			errs.ErrInvalid, preview.Invalid, preview.Total, firstIssues(rows, 3))
	}

	policy := importPolicy(req.ExistPolicy)
	specs := make([]WriteSpec, 0, len(rows))
	for _, row := range rows {
		values, err := NormalizeValues(plan.set, row.Values, req.NoAttributePolicy)
		if err != nil {
			return nil, fmt.Errorf("row %d: %w", row.Number, err)
		}
		if err := u.applyDefaults(plan.set, values); err != nil {
			return nil, fmt.Errorf("row %d: %w", row.Number, err)
		}
		unique, err := u.uniqueValue(plan.set, values)
		if err != nil {
			return nil, fmt.Errorf("row %d: %w", row.Number, err)
		}
		specs = append(specs, WriteSpec{
			TypeRef: plan.set.Type.Name, TypeID: plan.set.Type.ID,
			UniqueAttrID: plan.set.UniqueAttrID, UniqueValue: unique,
			Policy:    policy,
			Specs:     u.plannerSpecs(plan.set),
			Values:    values,
			Relations: importRelationSpecs(plan, row),
			Audit:     req.Audit,
		})
	}

	// THE WRITE IS ONE CALL, and therefore one transaction. A loop here would
	// put the transaction boundary back in the use case — which is exactly the
	// shape that made cantor's import non-atomic.
	written, err := u.repo.WriteCIBatch(ctx, specs)
	if err != nil {
		return nil, err
	}

	out := &ImportResult{Written: len(written), Rows: rows}
	for i := range out.Rows {
		out.Rows[i].InstanceID = written[i].CIID
		if written[i].Created {
			out.Rows[i].Action = importActionCreate
			out.Creates++
		} else {
			out.Rows[i].Action = importActionUpdate
			out.Updates++
		}
	}
	return out, nil
}

// prepareImport resolves the model and the column mapping, and checks the
// sheet's shape.
func (u *Usecase) prepareImport(ctx context.Context, req ImportRequest) (*importPlan, error) {
	if len(req.Headers) == 0 {
		return nil, fmt.Errorf("%w: the sheet has no header row", errs.ErrInvalid)
	}
	if len(req.Headers) > MaxImportColumns {
		return nil, fmt.Errorf("%w: the sheet has %d columns, more than the %d an import may carry",
			errs.ErrInvalid, len(req.Headers), MaxImportColumns)
	}
	if len(req.Rows) > MaxImportRows {
		return nil, fmt.Errorf("%w: the sheet has %d rows, more than the %d an import may carry; split it",
			errs.ErrInvalid, len(req.Rows), MaxImportRows)
	}
	if !importPolicy(req.ExistPolicy).Valid() {
		return nil, fmt.Errorf("%w: %q", ErrExistPolicyInvalid, req.ExistPolicy)
	}

	set, err := u.resolveSet(ctx, req.TypeRef)
	if err != nil {
		return nil, err
	}

	all := MatchColumns(set, req.Headers)
	columns := make([]ImportColumn, 0, len(all))
	for _, col := range all {
		if IsRelationHeader(col.Header) {
			continue
		}
		columns = append(columns, col)
	}
	relations, err := u.resolveRelationColumns(ctx, set, req.Headers)
	if err != nil {
		return nil, err
	}

	matched, _ := ImportColumnSummary(columns)
	if matched == 0 {
		return nil, fmt.Errorf("%w: none of the sheet's columns names an attribute of %s",
			errs.ErrInvalid, set.Type.Name)
	}
	// Nothing identifies the rows, so nothing says which instance each one is
	// about — and the write's own lookup would fail row by row.
	identified := false
	for _, col := range columns {
		if col.Matched && col.Identifier {
			identified = true
			break
		}
	}
	if !identified {
		return nil, fmt.Errorf("%w: no column supplies %s, which is what identifies an instance of %s",
			errs.ErrInvalid, set.UniqueAttr.Name, set.Type.Name)
	}
	return &importPlan{set: set, columns: columns, relations: relations}, nil
}

// typeAliasResolver is the optional half of TypeResolver that resolves a model
// by display alias. It is separate because an alias is not unique: the
// resolver must be able to refuse an ambiguous one, and a caller that does not
// have that answer (the write routes) must keep using names and ids.
type typeAliasResolver interface {
	ResolveForCIAlias(ctx context.Context, alias string) (*AttributeSet, error)
}

// resolveRelationColumns resolves `$parent.attribute` headers.
//
// A RELATION HEADER IS NEVER SILENTLY IGNORED. An attribute column the model
// does not carry is reported and dropped, because a client may post a superset
// of a model; a relation column is different — the operator wrote it to create
// an edge, and dropping it would import every row without the relationship the
// sheet asked for. Both halves must resolve and the model pair must declare a
// relation, or the sheet is refused.
func (u *Usecase) resolveRelationColumns(ctx context.Context, set *AttributeSet, headers []string) ([]ImportRelationColumn, error) {
	out := make([]ImportRelationColumn, 0)
	for i, raw := range headers {
		if !IsRelationHeader(raw) {
			continue
		}
		parentRef, attrRef, _, ok := SplitRelationHeader(raw)
		header := strings.TrimSpace(raw)
		if !ok {
			return nil, fmt.Errorf("%w: relation column %q must be $<model>.<attribute>",
				errs.ErrInvalid, header)
		}

		parentSet, err := u.types.ResolveForCI(ctx, parentRef)
		if err != nil {
			return nil, err
		}
		if parentSet == nil {
			// The generated template uses the model NAME, but cantor's used the
			// display alias and an operator may have edited the header to one.
			// The alias lookup is optional because not every resolver has one.
			if aliaser, ok := u.types.(typeAliasResolver); ok {
				parentSet, err = aliaser.ResolveForCIAlias(ctx, parentRef)
				if err != nil {
					return nil, err
				}
			}
		}
		if parentSet == nil {
			return nil, fmt.Errorf("%w: relation column %q names no model %q",
				errs.ErrInvalid, header, parentRef)
		}
		attrID, found := parentSet.ResolveAttrID(attrRef)
		if !found {
			return nil, fmt.Errorf("%w: relation column %q: model %s has no attribute %q",
				errs.ErrInvalid, header, parentSet.Type.Name, attrRef)
		}
		spec, found := parentSet.Specs[attrID]
		if !found {
			return nil, fmt.Errorf("%w: relation column %q: attribute %q is not part of model %s",
				errs.ErrInvalid, header, attrRef, parentSet.Type.Name)
		}
		if spec.IsPassword || spec.IsComputed || spec.IsFile || spec.IsList {
			return nil, fmt.Errorf("%w: relation column %q cannot use %s, which cannot identify a parent instance from a cell",
				errs.ErrInvalid, header, spec.Name)
		}

		rule, related, err := u.types.RelationBetween(ctx, parentSet.Type.ID, set.Type.ID)
		if err != nil {
			return nil, err
		}
		if !related {
			return nil, fmt.Errorf("%w: relation column %q: models %s and %s have no declared relation",
				errs.ErrInvalid, header, parentSet.Type.Name, set.Type.Name)
		}
		if rule.RelationTypeID == 0 {
			return nil, fmt.Errorf("%w: relation column %q: the relation between %s and %s has no relation type",
				errs.ErrInvalid, header, parentSet.Type.Name, set.Type.Name)
		}

		col := ImportRelationColumn{
			Index:          i,
			Header:         header,
			ParentTypeID:   parentSet.Type.ID,
			ParentType:     parentSet.Type.Name,
			ParentAlias:    parentSet.Type.Alias,
			AttrID:         spec.ID,
			Attr:           spec.Name,
			AttrAlias:      spec.Alias,
			RelationTypeID: rule.RelationTypeID,
			Constraint:     rule.Constraint,
			Matched:        true,
			parentSet:      parentSet,
		}
		if !strings.EqualFold(parentRef, parentSet.Type.Name) && parentRef != fmt.Sprint(parentSet.Type.ID) {
			col.Note = fmt.Sprintf("matched model %s by its display alias", parentSet.Type.Name)
		}
		out = append(out, col)
	}
	return out, nil
}

// buildImportRows resolves every row, and then asks ONE query which rows already
// exist and ONE per relation column which parents the rows name.
func (u *Usecase) buildImportRows(ctx context.Context, plan *importPlan, req ImportRequest) ([]ImportRow, error) {
	set := plan.set
	policy := importPolicy(req.ExistPolicy)
	rows := make([]ImportRow, 0, len(req.Rows))
	for i, cells := range req.Rows {
		rows = append(rows, buildImportRow(set, plan.columns, cells, i+1, 1))
	}
	if err := u.resolveRowRelations(ctx, plan.relations, req, rows); err != nil {
		return nil, err
	}

	// Which rows would update rather than create. It is asked of the valid rows
	// only, in one query — a preview that issued one query per row would make
	// looking at a sheet as expensive as importing it.
	values := make([]any, 0, len(rows))
	positions := make([]int, 0, len(rows))
	for i, row := range rows {
		if !row.OK {
			continue
		}
		normalized, err := NormalizeValues(set, row.Values, req.NoAttributePolicy)
		if err != nil {
			continue
		}
		unique, ok := normalized[set.UniqueAttrID]
		if !ok {
			continue
		}
		values = append(values, unique)
		positions = append(positions, i)
	}
	if len(values) == 0 {
		return rows, nil
	}
	ids, err := u.repo.FindCIsByUniqueValues(ctx, set.Type.ID, set.UniqueAttrID, set.Specs, values)
	if err != nil {
		return nil, err
	}
	for i, pos := range positions {
		if ids[i] == 0 {
			continue
		}
		rows[pos].InstanceID = ids[i]
		// THE ACTION IS WHAT WOULD HAPPEN, not what the policy would allow: a
		// row whose identifier is taken is an update under `replace` and a
		// refusal under `reject`, and the console shows the two differently.
		if policy == ExistReplace {
			rows[pos].Action = importActionUpdate
			continue
		}
		rows[pos].OK = false
		rows[pos].Action = ""
		rows[pos].Issues = append(rows[pos].Issues, ImportIssue{
			Message: fmt.Sprintf("an instance with this %s already exists (id %d), and this import replaces nothing",
				set.UniqueAttr.Name, ids[i]),
		})
	}
	return rows, nil
}

// resolveRowRelations turns each relation cell into parent instance ids.
//
// ONE LOOKUP PER RELATION COLUMN, not one per cell: a sheet of five thousand
// rows naming a rack would otherwise issue five thousand queries to answer the
// same question. The values are deduplicated before the query, and the result
// is mapped back to the cells that named each one.
//
// A VALUE WITH NO PARENT IS A ROW ERROR. cantor's async relation task logged
// the miss and moved on, leaving an instance that the sheet said belonged to a
// rack and that no rack contained. The preview is where that has to be visible.
func (u *Usecase) resolveRowRelations(ctx context.Context, relations []ImportRelationColumn, req ImportRequest, rows []ImportRow) error {
	for _, rel := range relations {
		if rel.parentSet == nil || !rel.Matched {
			continue
		}

		// The tokens each row names, and the de-duplicated query values.
		rowTokens := make([][]string, len(rows))
		tokens := make([]string, 0)
		seen := make(map[string]bool)
		for i, cells := range req.Rows {
			if rel.Index < 0 || rel.Index >= len(cells) || isBlankCell(cells[rel.Index]) {
				continue
			}
			for _, part := range strings.Split(fmt.Sprint(cells[rel.Index]), ",") {
				token := strings.TrimSpace(part)
				if token == "" {
					continue
				}
				rowTokens[i] = append(rowTokens[i], token)
				if !seen[token] {
					seen[token] = true
					tokens = append(tokens, token)
				}
			}
		}
		if len(tokens) == 0 {
			continue
		}

		values := make([]any, len(tokens))
		for i, token := range tokens {
			values[i] = token
		}
		matches, err := u.repo.FindCIsByAttributeValues(ctx, rel.ParentTypeID, rel.AttrID, rel.parentSet.Specs, values)
		if err != nil {
			return err
		}
		byToken := make(map[string][]model.ID, len(tokens))
		for i, token := range tokens {
			byToken[token] = matches[i]
		}

		for i, parts := range rowTokens {
			if len(parts) == 0 {
				continue
			}
			seenParents := make(map[model.ID]bool)
			for _, token := range parts {
				found := byToken[token]
				if len(found) == 0 {
					rows[i].OK = false
					rows[i].Action = ""
					rows[i].Issues = append(rows[i].Issues, ImportIssue{
						Column: rel.Header,
						Message: fmt.Sprintf("no %s instance has %s = %q",
							rel.ParentType, rel.Attr, token),
					})
					continue
				}
				for _, id := range found {
					if seenParents[id] {
						continue
					}
					seenParents[id] = true
					rows[i].Parents = append(rows[i].Parents, ImportParentEdge{
						ColumnIndex: rel.Index,
						ParentID:    id,
					})
				}
			}
		}
	}
	return nil
}

// importRelationSpecs projects a row's resolved parents into the write's edges.
//
// THE INSTANCE BEING WRITTEN IS THE CHILD. cantor's `$parent.attr` columns
// added the edge as parent -> child, so DiscoveredIsFirst stays false and the
// peer is the parent the lookup found. A zero relation type never reaches here:
// resolveRelationColumns refuses a model pair with no declared rule.
func importRelationSpecs(plan *importPlan, row ImportRow) []RelationSpec {
	if len(row.Parents) == 0 {
		return nil
	}
	byIndex := make(map[int]ImportRelationColumn, len(plan.relations))
	for _, rel := range plan.relations {
		byIndex[rel.Index] = rel
	}
	out := make([]RelationSpec, 0, len(row.Parents))
	for _, edge := range row.Parents {
		rel, ok := byIndex[edge.ColumnIndex]
		if !ok || rel.RelationTypeID == 0 || edge.ParentID == 0 {
			continue
		}
		out = append(out, RelationSpec{
			PeerCIID:          edge.ParentID,
			PeerTypeID:        rel.ParentTypeID,
			DiscoveredIsFirst: false,
			DiscoveredTypeID:  plan.set.Type.ID,
			RelationTypeID:    rel.RelationTypeID,
			Constraint:        rel.Constraint,
		})
	}
	return out
}

// importPolicy defaults a sheet's policy to a create.
func importPolicy(p ExistPolicy) ExistPolicy {
	if p == "" {
		return ExistReject
	}
	return p
}

// summariseImport counts what the rows would do.
func summariseImport(plan *importPlan, rows []ImportRow) *ImportPreview {
	out := &ImportPreview{
		Total: len(rows), Columns: plan.columns, Relations: plan.relations, Rows: rows,
	}
	for _, row := range rows {
		if !row.OK {
			out.Invalid++
			continue
		}
		out.Valid++
		if row.InstanceID != 0 {
			out.Updates++
		} else {
			out.Creates++
		}
	}
	return out
}

// firstIssues renders the first few problems, so a refusal names something
// actionable rather than only counting.
func firstIssues(rows []ImportRow, limit int) string {
	parts := make([]string, 0, limit)
	for _, row := range rows {
		if row.OK {
			continue
		}
		msgs := make([]string, 0, len(row.Issues))
		for _, issue := range row.Issues {
			msgs = append(msgs, issue.Message)
		}
		parts = append(parts, fmt.Sprintf("row %d: %s", row.SheetRow, strings.Join(msgs, "; ")))
		if len(parts) == limit {
			break
		}
	}
	sort.Strings(parts)
	return strings.Join(parts, " | ")
}

// ImportTypeRefOf is a convenience for a caller that has a model id.
func ImportTypeRefOf(id model.ID) string { return fmt.Sprint(id) }
