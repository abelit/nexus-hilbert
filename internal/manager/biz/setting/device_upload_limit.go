package setting

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"

	model "github.com/ongridio/ongrid/internal/manager/model/setting"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

const (
	DefaultDeviceFileMaxUploadMB = 8192
	MinDeviceFileMaxUploadMB     = 1
	MaxDeviceFileMaxUploadMB     = 8192
)

// DeviceFileUploadLimit resolves the global single-file upload cap for the
// device file manager. Missing, empty, invalid, or unreadable settings fall
// back to the 8 GiB default; the Edge keeps its own 8 GiB hard cap.
type DeviceFileUploadLimit struct {
	svc *Service
}

func NewDeviceFileUploadLimit(svc *Service) *DeviceFileUploadLimit {
	return &DeviceFileUploadLimit{svc: svc}
}

func (p *DeviceFileUploadLimit) LimitBytes(ctx context.Context) int64 {
	if p != nil && p.svc != nil {
		raw, found, err := p.svc.GetUncached(ctx, model.CategoryPlatform, model.KeyDeviceFileMaxUploadMB)
		if err != nil {
			p.svc.log.Warn("read device file upload limit setting", slog.Any("err", err))
		} else if found {
			if mib, ok := parseDeviceFileMaxUploadMB(raw); ok {
				return int64(mib) << 20
			}
			p.svc.log.Warn("invalid device file upload limit; using default", slog.String("value", raw))
		}
	}
	return int64(DefaultDeviceFileMaxUploadMB) << 20
}

func parseDeviceFileMaxUploadMB(raw string) (int, bool) {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n < MinDeviceFileMaxUploadMB || n > MaxDeviceFileMaxUploadMB {
		return 0, false
	}
	return n, true
}

func validateDeviceFileMaxUploadMB(value string) error {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	if _, ok := parseDeviceFileMaxUploadMB(value); !ok {
		return errsInvalidUploadLimit("must be an integer between %d and %d MiB", MinDeviceFileMaxUploadMB, MaxDeviceFileMaxUploadMB)
	}
	return nil
}

func errsInvalidUploadLimit(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{errs.ErrInvalid}, args...)...)
}
