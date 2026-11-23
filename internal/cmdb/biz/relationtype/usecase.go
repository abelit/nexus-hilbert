package relationtype

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"unicode/utf8"

	citypemodel "github.com/ongridio/ongrid/internal/cmdb/model/citype"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// Domain-specific errors. Each wraps an internal/pkg/errs sentinel so
// errs.HTTPStatus can map it without the HTTP layer needing to know this
// package's error vocabulary — that is the pattern AGENTS.md points at when it
// says errs.HTTPStatus is the single source of truth for status codes.
var (
	// ErrNameRequired is returned when a create or update omits the name.
	ErrNameRequired = fmt.Errorf("%w: relation type name is required", errs.ErrInvalid)
	// ErrNameTooLong is returned when the name exceeds the column width.
	ErrNameTooLong = fmt.Errorf("%w: relation type name is too long", errs.ErrInvalid)
	// ErrNameExists is returned when another live relation type already uses
	// the name. It is a conflict, not a malformed request.
	ErrNameExists = fmt.Errorf("%w: relation type name already exists", errs.ErrConflict)
	// ErrColorTooLong is returned when the colour exceeds the column width.
	ErrColorTooLong = fmt.Errorf("%w: relation type colour is too long", errs.ErrInvalid)
	// ErrColorInvalid is returned for a colour that is not a #rrggbb literal.
	ErrColorInvalid = fmt.Errorf("%w: relation type colour must be a #rrggbb literal", errs.ErrInvalid)
	// ErrRelationTypeInUse is returned when live model rules or instance edges
	// still reference the type. Deleting it would leave those rows resolvable
	// only by a dangling id.
	ErrRelationTypeInUse = fmt.Errorf("%w: relation type is still referenced", errs.ErrConflict)

	// ErrAliasTooLong is returned when an alias exceeds the column width.
	ErrAliasTooLong = fmt.Errorf("%w: relation type alias is too long", errs.ErrInvalid)
	// ErrAliasDuplicate is returned when one request repeats an alias.
	ErrAliasDuplicate = fmt.Errorf("%w: relation type alias is repeated", errs.ErrInvalid)
	// ErrAliasEqualsName is returned when an alias repeats the canonical name.
	ErrAliasEqualsName = fmt.Errorf("%w: relation type alias must differ from its name", errs.ErrInvalid)
	// ErrAliasExists is returned when an alias is already a live name or alias
	// of another relation type.
	ErrAliasExists = fmt.Errorf("%w: relation type alias is already in use", errs.ErrConflict)
	// ErrDisplayNameTooLong is returned when a localised display name exceeds
	// the column width.
	ErrDisplayNameTooLong = fmt.Errorf("%w: relation type display name is too long", errs.ErrInvalid)
)

// Input is the writable half of a relation type.
//
// THE PRESENTATION FIELDS ARE DATA, NOT CODE. The zh/en names, aliases and
// description live in the row so an operator can change what the console shows
// without a rebuild; the semantic mirror (category, traits, inverse) stays
// read-only and ontology-owned.
type Input struct {
	Name          string
	Color         string
	Aliases       []string
	DisplayNameZH string
	DisplayNameEN string
	Description   string
}

// InUseError carries the reference counts the caller needs to decide whether
// to migrate or keep the deprecated type.
type InUseError struct {
	Usage Usage
}

func (e *InUseError) Error() string {
	return fmt.Sprintf("%v: %d model rules, %d instance edges, %d history rows",
		ErrRelationTypeInUse, e.Usage.ModelRules, e.Usage.InstanceEdges, e.Usage.HistoryRows)
}

func (e *InUseError) Unwrap() error { return ErrRelationTypeInUse }

// Column widths. The colour stays cantor's String(7). The name was widened
// from cantor's String(16) so the dictionary can hold the vocabulary that
// nexus-topocortex already uses (e.g. MEMBER_OF_REDUNDANCY_GROUP), which is a
// prerequisite for mirroring ontology relation types into CMDB.
//
// THE NAME LIMIT IS IN CHARACTERS, NOT BYTES. MySQL's varchar(64) counts
// characters, so a 64-character Chinese name fits; `len()` counts bytes and
// would reject it at 22 characters.
const (
	MaxNameLen        = 64
	MaxColorLen       = 7
	MaxDisplayNameLen = 128
)

// DefaultColor mirrors cantor's server-side default for c_relation_types.color.
const DefaultColor = "#1890ff"

// Usecase is the relation-type dictionary service.
type Usecase struct {
	repo Repo
	log  *slog.Logger
}

// NewUsecase builds the usecase. A nil logger falls back to slog.Default.
func NewUsecase(repo Repo, log *slog.Logger) *Usecase {
	if log == nil {
		log = slog.Default()
	}
	return &Usecase{repo: repo, log: log.With(slog.String("comp", "cmdb-relationtype"))}
}

// List returns every live relation type.
//
// The dictionary is bounded (a handful of rows) and cantor returned it whole
// with no pagination, so there is no limit here. The HTTP layer still reports
// a total so the shape matches Ongrid's list convention.
func (u *Usecase) List(ctx context.Context) ([]citypemodel.RelationType, error) {
	if u.repo == nil {
		return nil, errs.ErrNotWiredYet
	}
	return u.repo.List(ctx)
}

// ListUsable is the selector view: it drops deprecated rows so a console
// dropdown or a connector cannot offer retired vocabulary. The dictionary page
// keeps using List so an operator can still see what was retired and why.
func (u *Usecase) ListUsable(ctx context.Context) ([]citypemodel.RelationType, error) {
	rows, err := u.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]citypemodel.RelationType, 0, len(rows))
	for _, rt := range rows {
		if rt.Deprecated {
			continue
		}
		out = append(out, rt)
	}
	return out, nil
}

// Create adds a relation type.
//
// The duplicate-name check is a read followed by a write, so two concurrent
// creates of the same name can both pass it. That is cantor's behaviour too —
// its c_relation_types.name carries a plain index, not a unique one, so the
// database would not catch it either. A unique index cannot be added here
// without a data-cleanup migration for any existing cantor database that
// already holds duplicates, so the race is accepted and documented rather than
// silently papered over.
func (u *Usecase) Create(ctx context.Context, in Input) (*citypemodel.RelationType, error) {
	if u.repo == nil {
		return nil, errs.ErrNotWiredYet
	}
	name, color, err := NormalizeInput(in.Name, in.Color)
	if err != nil {
		return nil, err
	}
	normalizedAliases, err := normalizeAliases(name, in.Aliases)
	if err != nil {
		return nil, err
	}
	zh, en, description, err := normalizePresentation(in)
	if err != nil {
		return nil, err
	}

	if existing, err := u.repo.FindByName(ctx, name); err != nil {
		return nil, err
	} else if existing != nil {
		return nil, fmt.Errorf("%w: %s", ErrNameExists, name)
	}
	if err := u.validateAliasCollisions(ctx, 0, name, normalizedAliases); err != nil {
		return nil, err
	}

	rt := &citypemodel.RelationType{
		Name: name, Color: color, Aliases: normalizedAliases,
		DisplayNameZH: zh, DisplayNameEN: en, Description: description,
	}
	if err := u.repo.Create(ctx, rt); err != nil {
		return nil, err
	}
	return rt, nil
}

// Update changes the writable fields of a relation type.
func (u *Usecase) Update(ctx context.Context, id int32, in Input) (*citypemodel.RelationType, error) {
	if u.repo == nil {
		return nil, errs.ErrNotWiredYet
	}
	if id == 0 {
		return nil, fmt.Errorf("%w: relation type id is required", errs.ErrInvalid)
	}
	name, color, err := NormalizeInput(in.Name, in.Color)
	if err != nil {
		return nil, err
	}
	normalizedAliases, err := normalizeAliases(name, in.Aliases)
	if err != nil {
		return nil, err
	}
	zh, en, description, err := normalizePresentation(in)
	if err != nil {
		return nil, err
	}

	existing, err := u.repo.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, errs.ErrNotFound
	}

	// Renaming to a name held by a DIFFERENT row is a conflict; renaming to its
	// own current name is not.
	if other, err := u.repo.FindByName(ctx, name); err != nil {
		return nil, err
	} else if other != nil && other.ID != id {
		return nil, fmt.Errorf("%w: %s", ErrNameExists, name)
	}
	if err := u.validateAliasCollisions(ctx, id, name, normalizedAliases); err != nil {
		return nil, err
	}

	existing.Name = name
	existing.Color = color
	existing.Aliases = normalizedAliases
	existing.DisplayNameZH = zh
	existing.DisplayNameEN = en
	existing.Description = description
	if err := u.repo.Update(ctx, existing); err != nil {
		return nil, err
	}
	return existing, nil
}

// Delete soft-deletes a relation type.
//
// LIVE REFERENCES BLOCK THE DELETE. A type still used by a model rule or an
// instance edge returns *InUseError, which wraps errs.ErrConflict (HTTP 409)
// and carries the counts. History rows are reported in the same error but do
// not block: they are audit evidence, not a live use. This replaces cantor's
// unconditional delete, which let an operator strand live rows on an id that
// no longer resolves.
func (u *Usecase) Delete(ctx context.Context, id int32) error {
	if u.repo == nil {
		return errs.ErrNotWiredYet
	}
	if id == 0 {
		return fmt.Errorf("%w: relation type id is required", errs.ErrInvalid)
	}
	existing, err := u.repo.Get(ctx, id)
	if err != nil {
		return err
	}
	if existing == nil {
		return errs.ErrNotFound
	}
	usage, err := u.repo.Usage(ctx, id)
	if err != nil {
		return err
	}
	if usage.LiveReferences() > 0 {
		return &InUseError{Usage: usage}
	}
	return u.repo.SoftDelete(ctx, id)
}

// NormalizeInput trims and validates a name/colour pair, applying the default
// colour when none is supplied.
//
// It is exported so the HTTP layer can pre-validate without duplicating the
// rules, and so tests can drive it directly.
func NormalizeInput(name, color string) (string, string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", "", ErrNameRequired
	}
	if utf8.RuneCountInString(name) > MaxNameLen {
		return "", "", fmt.Errorf("%w: %d > %d", ErrNameTooLong, utf8.RuneCountInString(name), MaxNameLen)
	}

	color = strings.TrimSpace(color)
	if color == "" {
		return name, DefaultColor, nil
	}
	if len(color) > MaxColorLen {
		return "", "", fmt.Errorf("%w: %d > %d", ErrColorTooLong, len(color), MaxColorLen)
	}
	// cantor accepted any 7-character string into a varchar(7); a malformed
	// colour then broke the UI in ways that were hard to trace back. Validating
	// the shape here is a strict improvement that cannot reject a value cantor
	// would have stored correctly.
	if !isHexColor(color) {
		return "", "", fmt.Errorf("%w: %q", ErrColorInvalid, color)
	}
	return name, color, nil
}

// normalizeAliases trims, de-duplicates and length-checks the alias list. An
// alias equal to the canonical name is refused: it adds no lookup value and
// would make "which one is the identity?" ambiguous.
func normalizeAliases(name string, aliases []string) (citypemodel.StringList, error) {
	out := make(citypemodel.StringList, 0, len(aliases))
	seen := make(map[string]struct{}, len(aliases))
	for _, raw := range aliases {
		alias := strings.TrimSpace(raw)
		if alias == "" {
			continue
		}
		if utf8.RuneCountInString(alias) > MaxNameLen {
			return nil, fmt.Errorf("%w: %s", ErrAliasTooLong, alias)
		}
		if alias == name {
			return nil, ErrAliasEqualsName
		}
		if _, duplicate := seen[alias]; duplicate {
			return nil, fmt.Errorf("%w: %s", ErrAliasDuplicate, alias)
		}
		seen[alias] = struct{}{}
		out = append(out, alias)
	}
	return out, nil
}

// normalizePresentation trims the display fields and checks the column width.
// An empty value is allowed: the console then falls back to the canonical name.
func normalizePresentation(in Input) (zh, en, description string, err error) {
	zh = strings.TrimSpace(in.DisplayNameZH)
	en = strings.TrimSpace(in.DisplayNameEN)
	description = strings.TrimSpace(in.Description)
	if utf8.RuneCountInString(zh) > MaxDisplayNameLen {
		return "", "", "", fmt.Errorf("%w: %s", ErrDisplayNameTooLong, zh)
	}
	if utf8.RuneCountInString(en) > MaxDisplayNameLen {
		return "", "", "", fmt.Errorf("%w: %s", ErrDisplayNameTooLong, en)
	}
	return zh, en, description, nil
}

// validateAliasCollisions keeps the dictionary unambiguous: an alias may not
// be another live row's name or alias, and a canonical name may not be another
// row's alias. The dictionary is small, so listing it is cheaper than a
// dialect-specific JSON containment query.
func (u *Usecase) validateAliasCollisions(ctx context.Context, id int32, name string, aliases citypemodel.StringList) error {
	rows, err := u.repo.List(ctx)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if row.ID == id {
			continue
		}
		if row.Name == name {
			return fmt.Errorf("%w: %s", ErrNameExists, name)
		}
		for _, alias := range aliases {
			if row.Name == alias {
				return fmt.Errorf("%w: %s is the name of %s", ErrAliasExists, alias, row.Name)
			}
			for _, existing := range row.Aliases {
				if existing == alias {
					return fmt.Errorf("%w: %s is an alias of %s", ErrAliasExists, alias, row.Name)
				}
			}
		}
		for _, existing := range row.Aliases {
			if existing == name {
				return fmt.Errorf("%w: %s is an alias of %s", ErrNameExists, name, row.Name)
			}
		}
	}
	return nil
}

// isHexColor reports whether s is a "#rrggbb" literal. The three-digit CSS
// shorthand is deliberately not accepted because it would not fit cantor's
// stored format.
func isHexColor(s string) bool {
	if len(s) != MaxColorLen || s[0] != '#' {
		return false
	}
	for i := 1; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
		case c >= 'a' && c <= 'f':
		case c >= 'A' && c <= 'F':
		default:
			return false
		}
	}
	return true
}
