package setting

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/ongridio/ongrid/internal/pkg/errs"
)

const (
	envDeviceFileWriteRoots = "ONGRID_DEVICE_FILE_ROOTS"
	maxDeviceFileRoots      = 32
	maxDeviceFileRootLen    = 512
	// maxDeviceFileRootsJSON leaves headroom under the Edge's 16 KiB preface
	// limit for the rest of the FM request (op, path, target, size).
	maxDeviceFileRootsJSON = 12 << 10
)

// DeviceFileRoots resolves the global writable roots for the device file
// manager. The DB setting wins; the environment variable is the fallback only
// when no row exists. An existing empty row means sandbox-only, and a failed
// read fails closed to the sandbox instead of reopening env-configured roots.
type DeviceFileRoots struct {
	svc *Service
}

func NewDeviceFileRoots(svc *Service) *DeviceFileRoots {
	return &DeviceFileRoots{svc: svc}
}

func (p *DeviceFileRoots) Roots(ctx context.Context) []string {
	if p != nil && p.svc != nil {
		raw, found, err := p.svc.DeviceFileWriteRoots(ctx)
		if err != nil {
			p.svc.log.Warn("read device file write roots setting", slog.Any("err", err))
			return nil
		}
		if found {
			return ParseDeviceFileRoots(raw)
		}
	}
	return ParseDeviceFileRoots(os.Getenv(envDeviceFileWriteRoots))
}

// ParseDeviceFileRoots accepts comma- or newline-separated paths. Empty,
// oversized, and duplicate entries are dropped, and the result is trimmed
// until its JSON encoding fits the FM request budget.
func ParseDeviceFileRoots(raw string) []string {
	out, _ := normalizeDeviceFileRoots(raw, false)
	for len(out) > 0 {
		encoded, err := json.Marshal(out)
		if err == nil && len(encoded) <= maxDeviceFileRootsJSON {
			break
		}
		out = out[:len(out)-1]
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// normalizeDeviceFileRoots splits, trims, de-duplicates, and bounds the list.
// In strict mode (settings write path) violations are errors; in lenient mode
// (read path) oversized entries are skipped and the count is capped.
func normalizeDeviceFileRoots(raw string, strict bool) ([]string, error) {
	fields := strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == '\n' })
	out := make([]string, 0, len(fields))
	seen := make(map[string]bool, len(fields))
	for _, field := range fields {
		field = strings.TrimSpace(field)
		if field == "" {
			continue
		}
		if strict {
			if len(field) > maxDeviceFileRootLen {
				return nil, errsInvalidRoots("each root must be at most %d characters", maxDeviceFileRootLen)
			}
			if strings.ContainsRune(field, 0) {
				return nil, errsInvalidRoots("root contains NUL")
			}
		} else if len(field) > maxDeviceFileRootLen {
			continue
		}
		if seen[field] {
			continue
		}
		if len(out) == maxDeviceFileRoots {
			if strict {
				return nil, errsInvalidRoots("at most %d roots", maxDeviceFileRoots)
			}
			break
		}
		seen[field] = true
		out = append(out, field)
	}
	return out, nil
}

func validateDeviceFileWriteRoots(value string) error {
	out, err := normalizeDeviceFileRoots(value, true)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return errsInvalidRoots("encode roots: %v", err)
	}
	if len(encoded) > maxDeviceFileRootsJSON {
		return errsInvalidRoots("write roots exceed the %d-byte request budget", maxDeviceFileRootsJSON)
	}
	return nil
}

func errsInvalidRoots(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{errs.ErrInvalid}, args...)...)
}
