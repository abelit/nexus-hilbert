package ci

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// FileCleaner is the file domain's lifecycle port. The CI usecase owns the
// value rows and knows which attributes are files; the file usecase owns the
// objects. This interface keeps the two packages from importing each other.
type FileCleaner interface {
	// CleanupFileValues deletes every file referenced by the JSON values.
	CleanupFileValues(ctx context.Context, values []string) error
	// CleanupFileValueChange deletes files present in oldValue but absent from
	// newValue. It is a no-op when the two values reference the same ids.
	CleanupFileValueChange(ctx context.Context, oldValue, newValue string) error
}

// WithFileCleaner injects the optional lifecycle hook. It is called from the
// assembly layer after both usecases exist.
func (u *Usecase) WithFileCleaner(cleaner FileCleaner) *Usecase {
	u.fileCleaner = cleaner
	return u
}

// FileValues returns the raw JSON values of a CI's file attributes, keyed by
// attribute name. Ordinary read endpoints deliberately omit file values; the
// file manager asks for them explicitly.
func (u *Usecase) FileValues(ctx context.Context, ciID model.ID) (map[string]string, error) {
	if u.repo == nil || u.types == nil {
		return nil, errs.ErrNotWiredYet
	}
	ci, err := u.repo.LoadCI(ctx, ciID)
	if err != nil {
		return nil, err
	}
	if ci == nil {
		return nil, ErrInstanceNotFound
	}
	set, err := u.types.ResolveForCI(ctx, fmt.Sprint(ci.TypeID))
	if err != nil {
		return nil, err
	}
	if set == nil {
		return nil, ErrTypeNotFound
	}
	rows, err := u.repo.LoadValueRows(ctx, ciID)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string)
	for _, row := range rows {
		spec, ok := set.Specs[row.AttrID]
		if !ok || !spec.IsFile {
			continue
		}
		out[spec.Name] = rowText(row)
	}
	return out, nil
}

func fileValuesForRows(set *AttributeSet, rows []ValueRow) []string {
	out := make([]string, 0)
	for _, row := range rows {
		spec, ok := set.Specs[row.AttrID]
		if !ok || !spec.IsFile {
			continue
		}
		if text := rowText(row); text != "" {
			out = append(out, text)
		}
	}
	return out
}

func fileValueText(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case []byte:
		return string(typed)
	default:
		raw, err := json.Marshal(value)
		if err != nil {
			return ""
		}
		return string(raw)
	}
}

func sameFileValue(oldText string, value any) bool {
	newText := strings.TrimSpace(fileValueText(value))
	oldText = strings.TrimSpace(oldText)
	if oldText == newText {
		return true
	}
	// Formatting differences are not a change. Compare the file ids as sets.
	oldIDs := fileIDs(oldText)
	newIDs := fileIDs(newText)
	if len(oldIDs) == 0 || len(newIDs) == 0 {
		return false
	}
	for id := range oldIDs {
		if !newIDs[id] {
			return false
		}
	}
	return true
}

func fileIDs(raw string) map[string]bool {
	var values []struct {
		FileID string `json:"file_id"`
	}
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return nil
	}
	out := make(map[string]bool, len(values))
	for _, item := range values {
		if id := strings.TrimSpace(item.FileID); id != "" {
			out[id] = true
		}
	}
	return out
}

func (u *Usecase) cleanupChangedFiles(_ context.Context, set *AttributeSet, rows []ValueRow, values map[model.ID]any) {
	if u.fileCleaner == nil || len(rows) == 0 {
		return
	}
	for _, row := range rows {
		spec, ok := set.Specs[row.AttrID]
		if !ok || !spec.IsFile {
			continue
		}
		incoming, supplied := values[row.AttrID]
		if !supplied || sameFileValue(row.Text, incoming) {
			continue
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := u.fileCleaner.CleanupFileValueChange(cleanupCtx, row.Text, fileValueText(incoming))
		cancel()
		if err != nil {
			u.log.Warn("cmdb ci: could not clean up removed file",
				slog.String("attr", spec.Name), slog.Any("err", err))
		}
	}
}

func (u *Usecase) cleanupDeletedFiles(values []string) {
	if u.fileCleaner == nil || len(values) == 0 {
		return
	}
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := u.fileCleaner.CleanupFileValues(cleanupCtx, values); err != nil {
		u.log.Warn("cmdb ci: could not clean up files for deleted instance", slog.Any("err", err))
	}
}
