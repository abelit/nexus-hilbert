# Device File Upload Size Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin configure the global single-file upload limit for the device file manager from the settings UI, default 8 GiB.

**Architecture:** Reuse `system_settings` (`platform/device_file_max_upload_mb`, MiB, 1–8192). A new biz provider resolves the value (uncached, default 8192) and `bootstrapTunnel` injects it into the webshell handler. The manager rejects oversized uploads before opening the stream; the Edge's 8 GiB `MaxUploadSize` stays as the hard backstop. A new card in Settings → General edits it.

**Tech Stack:** Go 1.25, chi, GORM-backed system settings, React 19 + TypeScript, Vitest, existing UI components.

**Spec:** [docs/design/device-file-manager.md](../../design/device-file-manager.md) §2.2

## Global Constraints

- Setting identity: category `platform`, key `device_file_max_upload_mb`.
- Unit MiB; range 1–8192; default 8192 (8 GiB) when the row is absent or the value is empty/invalid.
- Manager enforces `Content-Length` before opening the FM stream; the Edge's 8 GiB constant is unchanged. No Edge or protocol change.
- Only the file manager upload path is affected; `/files` (RDP file panel, 2 GiB) is out of scope.
- Read the setting uncached so a change applies on every manager instance.
- Admin-only surfaces only: the existing settings PUT and the admin-only Settings page.
- Frontend strings use `tr('中文', 'English')`; reuse existing components; no new dependencies.
- Do not commit or push; leave changes in the working tree.
- Verification: `go test -race` for affected packages, `go build ./cmd/ongrid`, `npm test -- src/pages/settings/General.test.tsx`, `npm run build`, `npm run lint`, `make arch-lint` (record if the tool is missing).

## Review Focus

- A limit of 0, a negative number, a non-number, or 8193 is rejected; 1 and 8192 are accepted.
- A missing row or an empty/invalid row resolves to 8192 MiB, not 0 and not an error that blocks uploads.
- An upload exactly at the limit is accepted; one byte above is rejected before any stream is opened or file is written.
- The value is read uncached, so a change on another manager instance applies immediately.
- Only the FM upload is limited; the RDP file panel keeps its 2 GiB cap and is untouched.

---

### Task 1: Setting constant, uncached getter, provider, validation

**Files:**
- Modify: `internal/manager/model/setting/model.go`
- Modify: `internal/manager/biz/setting/service.go`
- Modify: `internal/manager/biz/setting/device_files.go` (use the new uncached getter)
- Create: `internal/manager/biz/setting/device_upload_limit.go`
- Create: `internal/manager/biz/setting/device_upload_limit_test.go`

**Interfaces:**
- Consumes: `Service.GetUncached`, `model.CategoryPlatform`, `fakeRepo` (same package).
- Produces:
  - `model.KeyDeviceFileMaxUploadMB = "device_file_max_upload_mb"`
  - `const DefaultDeviceFileMaxUploadMB = 8192`, `MinDeviceFileMaxUploadMB = 1`, `MaxDeviceFileMaxUploadMB = 8192`
  - `(*Service).GetUncached(ctx, category, key) (string, bool, error)`
  - `setting.NewDeviceFileUploadLimit(svc *Service) *DeviceFileUploadLimit`
  - `(*DeviceFileUploadLimit).LimitBytes(ctx context.Context) int64`

- [ ] **Step 1: Write the failing tests**

Create `internal/manager/biz/setting/device_upload_limit_test.go`:

```go
package setting

import (
	"context"
	"errors"
	"testing"

	model "github.com/ongridio/ongrid/internal/manager/model/setting"
)

func TestValidateDeviceFileMaxUploadMB(t *testing.T) {
	repo := newFakeRepo()
	svc := New(repo, nil)
	ctx := context.Background()

	for _, value := range []string{"1", "1024", "8192", ""} {
		if err := svc.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileMaxUploadMB, value, false); err != nil {
			t.Fatalf("valid value %q rejected: %v", value, err)
		}
	}
	for _, value := range []string{"0", "-1", "8193", "abc", "1.5"} {
		if err := svc.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileMaxUploadMB, value, false); err == nil {
			t.Fatalf("invalid value %q accepted", value)
		}
	}
}

func TestDeviceFileUploadLimitDefaults(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	svc := New(repo, nil)
	p := NewDeviceFileUploadLimit(svc)

	if got, want := p.LimitBytes(ctx), int64(DefaultDeviceFileMaxUploadMB)<<20; got != want {
		t.Fatalf("default = %d, want %d", got, want)
	}
	if err := svc.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileMaxUploadMB, "1024", false); err != nil {
		t.Fatal(err)
	}
	if got, want := p.LimitBytes(ctx), int64(1024)<<20; got != want {
		t.Fatalf("configured = %d, want %d", got, want)
	}
	if err := svc.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileMaxUploadMB, "", false); err != nil {
		t.Fatal(err)
	}
	if got, want := p.LimitBytes(ctx), int64(DefaultDeviceFileMaxUploadMB)<<20; got != want {
		t.Fatalf("empty row = %d, want default %d", got, want)
	}
}

func TestDeviceFileUploadLimitFailsToDefaultOnReadError(t *testing.T) {
	repo := newFakeRepo()
	repo.getErr = errors.New("db down")
	svc := New(repo, nil)
	p := NewDeviceFileUploadLimit(svc)
	if got, want := p.LimitBytes(context.Background()), int64(DefaultDeviceFileMaxUploadMB)<<20; got != want {
		t.Fatalf("read error = %d, want default %d", got, want)
	}
}

func TestDeviceFileUploadLimitBypassesProcessCache(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	svc := New(repo, nil)
	p := NewDeviceFileUploadLimit(svc)

	if _, err := repo.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileMaxUploadMB, "1024", false); err != nil {
		t.Fatal(err)
	}
	if got, want := p.LimitBytes(ctx), int64(1024)<<20; got != want {
		t.Fatalf("first read = %d, want %d", got, want)
	}
	if _, err := repo.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileMaxUploadMB, "2048", false); err != nil {
		t.Fatal(err)
	}
	if got, want := p.LimitBytes(ctx), int64(2048)<<20; got != want {
		t.Fatalf("cross-instance update = %d, want %d", got, want)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/manager/biz/setting -run 'TestValidateDeviceFileMaxUploadMB|TestDeviceFileUploadLimit' -count=1`
Expected: FAIL — missing constants, `NewDeviceFileUploadLimit`, `KeyDeviceFileMaxUploadMB`, `GetUncached`.

- [ ] **Step 3: Add the model constant and uncached getter**

In `internal/manager/model/setting/model.go`, add under `CategoryPlatform` keys:

```go
// KeyDeviceFileMaxUploadMB is the global single-file upload cap for the
// device file manager, in MiB. Empty/invalid values use the default.
KeyDeviceFileMaxUploadMB = "device_file_max_upload_mb"
```

In `internal/manager/biz/setting/service.go`, add:

```go
// GetUncached reads a setting directly from the repo, bypassing the process
// cache. Use it for authorization/policy settings whose changes must apply on
// every manager instance immediately.
func (s *Service) GetUncached(ctx context.Context, category, key string) (string, bool, error) {
	row, err := s.repo.Get(ctx, category, key)
	if err != nil {
		if errors.Is(err, errs.ErrNotFound) {
			return "", false, nil
		}
		return "", false, err
	}
	return row.Value, true, nil
}
```

Refactor `DeviceFileWriteRoots` to call it:

```go
func (s *Service) DeviceFileWriteRoots(ctx context.Context) (string, bool, error) {
	return s.GetUncached(ctx, model.CategoryPlatform, model.KeyDeviceFileWriteRoots)
}
```

- [ ] **Step 4: Implement the provider and validation**

Create `internal/manager/biz/setting/device_upload_limit.go`:

```go
package setting

import (
	"context"
	"log/slog"
	"strconv"
	"strings"

	model "github.com/ongridio/ongrid/internal/manager/model/setting"
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
```

Add the `fmt` and `errs` imports. In `validateSetting`'s `CategoryPlatform` branch, add:

```go
if key == model.KeyDeviceFileMaxUploadMB {
	return validateDeviceFileMaxUploadMB(value)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test -race ./internal/manager/biz/setting -count=1`
Expected: PASS.

---

### Task 2: Handler seam, bootstrap wiring, upload enforcement test

**Files:**
- Modify: `internal/manager/server/webshell/http.go`
- Modify: `internal/manager/server/webshell/filemanager.go`
- Modify: `internal/manager/server/webshell/filemanager_test.go`
- Modify: `cmd/ongrid/bootstrap_tunnel.go`

**Interfaces:**
- Consumes: `NewDeviceFileUploadLimit(settings.settingSvc).LimitBytes` from Task 1.
- Produces: `webshell.MaxUploadBytesFunc`, `(*Handler).SetMaxUploadBytes`, `(*Handler).maxUploadBytes(ctx) int64`.

- [ ] **Step 1: Write the failing test**

In `internal/manager/server/webshell/filemanager_test.go`, add:

```go
func TestFileManagerRejectsUploadAboveConfiguredLimit(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ONGRID_EDGE_TRANSFER_DIR", t.TempDir())
	h := &Handler{
		tickets:          map[string]shellTicket{},
		failures:         map[string]authFailures{},
		streamer:         fmStreamer{},
		devices:          fileFakeDevices{},
		edges:            fileFakeEdges{},
		log:              slog.Default(),
		writeRoots:       func(context.Context) []string { return []string{root} },
		maxUploadBytesFn: func(context.Context) int64 { return 4 },
	}
	r := chi.NewRouter()
	r.Post("/v1/devices/{device_id}/fm/upload", h.fmUpload)
	srv := httptest.NewServer(r)
	defer srv.Close()

	url := srv.URL + "/v1/devices/42/fm/upload?path=" + url.QueryEscape(filepath.Join(root, "a.bin"))
	res, err := http.Post(url, "application/octet-stream", bytes.NewReader([]byte("12345")))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", res.StatusCode)
	}

	res, err = http.Post(url, "application/octet-stream", bytes.NewReader([]byte("1234")))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("at-limit status = %d, want 200", res.StatusCode)
	}
}
```

Also set `maxUploadBytesFn: func(context.Context) int64 { return 8 << 30 }` in `newFMTestServer` so existing tests keep the default and don't depend on the nil fallback.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/manager/server/webshell -run TestFileManagerRejectsUploadAboveConfiguredLimit -count=1`
Expected: FAIL — `Handler` has no field `maxUploadBytesFn`.

- [ ] **Step 3: Add the seam and enforcement**

In `internal/manager/server/webshell/http.go`:

```go
// MaxUploadBytesFunc returns the configured single-file upload cap for the
// device file manager. The Edge keeps its own hard cap.
type MaxUploadBytesFunc func(ctx context.Context) int64
```

Add `maxUploadBytesFn MaxUploadBytesFunc` to `Handler`, and:

```go
// SetMaxUploadBytes wires the device-file upload-limit provider post-construction.
func (h *Handler) SetMaxUploadBytes(fn MaxUploadBytesFunc) { h.maxUploadBytesFn = fn }
```

In `internal/manager/server/webshell/filemanager.go`:
- Rename `fileManagerMaxUpload` to `defaultFileManagerMaxUpload` (keep 8 GiB).
- Add:

```go
func (h *Handler) maxUploadBytes(ctx context.Context) int64 {
	if h.maxUploadBytesFn == nil {
		return defaultFileManagerMaxUpload
	}
	if limit := h.maxUploadBytesFn(ctx); limit > 0 {
		return limit
	}
	return defaultFileManagerMaxUpload
}
```

- In `fmUpload`, replace the constant check:

```go
limit := h.maxUploadBytes(r.Context())
if size > limit {
	writeErr(w, fmt.Errorf("%w: file exceeds the configured %d MiB upload limit", errs.ErrInvalid, limit>>20))
	return
}
```

- [ ] **Step 4: Run the webshell tests**

Run: `go test -race ./internal/manager/server/webshell -count=1`
Expected: PASS.

- [ ] **Step 5: Wire bootstrap**

In `cmd/ongrid/bootstrap_tunnel.go`, after the write-roots setter:

```go
webshellHandler.SetMaxUploadBytes(managerbizsetting.NewDeviceFileUploadLimit(settings.settingSvc).LimitBytes)
```

Run: `go build ./cmd/ongrid && go test -race ./internal/manager/server/webshell ./internal/manager/biz/setting -count=1`
Expected: PASS.

---

### Task 3: Settings → General upload limit card

**Files:**
- Modify: `web/src/pages/settings/General.tsx`
- Modify: `web/src/pages/settings/General.test.tsx`

**Interfaces:**
- Setting key `device_file_max_upload_mb`, category `platform`.
- Textarea/root card stays unchanged; the new card uses:
  - input id `device-file-max-upload-mb`
  - save button `保存上限`
  - reset button `恢复默认`

- [ ] **Step 1: Write the failing tests**

In `General.test.tsx`, add a describe block:

```tsx
describe('general settings — device file upload limit', () => {
  const platformUpload = (value: string) => ({
    items: [{ category: 'platform', key: 'device_file_max_upload_mb', value, sensitive: false, updated_at: '' }],
    total: 1,
  });

  it('loads and saves the limit in MiB', async () => {
    listMock.mockImplementation((category?: string) =>
      Promise.resolve(category === 'platform' ? platformUpload('1024') : { items: [], total: 0 }),
    );
    const user = userEvent.setup();
    render(<SettingsGeneral />);
    const input = await screen.findByLabelText('单文件上传上限（MiB）');
    expect(input).toHaveValue(1024);
    await user.clear(input);
    await user.type(input, '2048');
    await user.click(screen.getByRole('button', { name: '保存上限' }));
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith('platform', 'device_file_max_upload_mb', '2048', false),
    );
  });

  it('rejects a value outside 1–8192 MiB', async () => {
    const user = userEvent.setup();
    render(<SettingsGeneral />);
    const input = await screen.findByLabelText('单文件上传上限（MiB）');
    await user.clear(input);
    await user.type(input, '8193');
    await user.click(screen.getByRole('button', { name: '保存上限' }));
    expect(await screen.findByText(/1–8192/)).toBeInTheDocument();
    expect(setMock).not.toHaveBeenCalledWith('platform', 'device_file_max_upload_mb', expect.anything(), false);
  });

  it('restores the 8192 MiB default', async () => {
    listMock.mockImplementation((category?: string) =>
      Promise.resolve(category === 'platform' ? platformUpload('1024') : { items: [], total: 0 }),
    );
    const user = userEvent.setup();
    render(<SettingsGeneral />);
    await user.click(await screen.findByRole('button', { name: '恢复默认' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('platform', 'device_file_max_upload_mb'));
    expect(screen.getByLabelText('单文件上传上限（MiB）')).toHaveValue(8192);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npm test -- src/pages/settings/General.test.tsx --run`
Expected: FAIL — no input `单文件上传上限（MiB）`, no `保存上限` / `恢复默认` buttons.

- [ ] **Step 3: Implement the card**

In `General.tsx`:
- Add constants:

```ts
const DEVICE_FILE_MAX_UPLOAD_MB_KEY = 'device_file_max_upload_mb';
const MIN_UPLOAD_MB = 1;
const MAX_UPLOAD_MB = 8192;
const DEFAULT_UPLOAD_MB = 8192;
```

- Add state:

```ts
const [uploadLimitText, setUploadLimitText] = useState(String(DEFAULT_UPLOAD_MB));
const [uploadLimitHasRow, setUploadLimitHasRow] = useState(false);
const [uploadLimitSaving, setUploadLimitSaving] = useState(false);
const [uploadLimitError, setUploadLimitError] = useState<string | null>(null);
const [uploadLimitNotice, setUploadLimitNotice] = useState('');
```

- In `load`, find the row and set:

```ts
const uploadRow = response.items.find((item) => item.key === DEVICE_FILE_MAX_UPLOAD_MB_KEY);
setUploadLimitHasRow(Boolean(uploadRow));
setUploadLimitText(uploadRow?.value?.trim() || String(DEFAULT_UPLOAD_MB));
```

- Add callbacks:

```ts
const onSaveUploadLimit = useCallback(async () => {
  const n = Number(uploadLimitText);
  if (!Number.isInteger(n) || n < MIN_UPLOAD_MB || n > MAX_UPLOAD_MB) {
    setUploadLimitError(tr(`请输入 ${MIN_UPLOAD_MB}–${MAX_UPLOAD_MB} 之间的整数（MiB）`, `Enter an integer between ${MIN_UPLOAD_MB} and ${MAX_UPLOAD_MB} MiB`));
    setUploadLimitNotice('');
    return;
  }
  setUploadLimitSaving(true);
  setUploadLimitError(null);
  setUploadLimitNotice('');
  try {
    await setSetting(CATEGORY, DEVICE_FILE_MAX_UPLOAD_MB_KEY, String(n), false);
    setUploadLimitText(String(n));
    setUploadLimitHasRow(true);
    setUploadLimitNotice(tr('已保存', 'Saved'));
  } catch (err) {
    setUploadLimitError(err instanceof Error ? err.message : String(err));
  } finally {
    setUploadLimitSaving(false);
  }
}, [tr, uploadLimitText]);

const onResetUploadLimit = useCallback(async () => {
  setUploadLimitSaving(true);
  setUploadLimitError(null);
  setUploadLimitNotice('');
  try {
    await deleteSetting(CATEGORY, DEVICE_FILE_MAX_UPLOAD_MB_KEY);
    setUploadLimitText(String(DEFAULT_UPLOAD_MB));
    setUploadLimitHasRow(false);
    setUploadLimitNotice(tr('已恢复默认值', 'Restored default'));
  } catch (err) {
    setUploadLimitError(err instanceof Error ? err.message : String(err));
  } finally {
    setUploadLimitSaving(false);
  }
}, [tr]);
```

- Render after the write-roots card, before `<EdgeInstallAddressCard />`:

```tsx
<section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
  <div className="mb-3 flex items-center gap-2">
    <Upload size={14} className="text-zinc-400" />
    <h2 className="text-sm font-medium text-zinc-100">{tr('上传大小限制', 'Upload size limit')}</h2>
  </div>
  <p className="mb-4 text-xs leading-relaxed text-zinc-500">
    {tr(
      '设备文件管理的单文件上传上限。只影响文件管理，不影响 RDP 文件面板。',
      'Single-file upload limit for the device file manager. Does not affect the RDP file panel.',
    )}
  </p>
  <Label htmlFor="device-file-max-upload-mb">{tr('单文件上传上限（MiB）', 'Max upload size (MiB)')}</Label>
  <Input
    id="device-file-max-upload-mb"
    type="number"
    min={MIN_UPLOAD_MB}
    max={MAX_UPLOAD_MB}
    step={1}
    value={uploadLimitText}
    onChange={(event) => {
      setUploadLimitText(event.target.value);
      setUploadLimitNotice('');
    }}
  />
  <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
    {tr(
      `范围 ${MIN_UPLOAD_MB}–${MAX_UPLOAD_MB} MiB；当前约 ${(Number(uploadLimitText) / 1024).toFixed(2)} GiB。`,
      `Range ${MIN_UPLOAD_MB}–${MAX_UPLOAD_MB} MiB; about ${(Number(uploadLimitText) / 1024).toFixed(2)} GiB.`,
    )}
  </p>
  <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
    {uploadLimitHasRow
      ? tr('当前由界面配置。', 'Configured here.')
      : tr('尚未保存，使用默认值 8 GiB。', 'Not saved yet; using the 8 GiB default.')}
  </p>
  {uploadLimitError && <div className="mt-3 text-xs text-red-400">{uploadLimitError}</div>}
  <div className="mt-4 flex flex-wrap items-center gap-3">
    <Button type="button" variant="primary" disabled={uploadLimitSaving} onClick={() => void onSaveUploadLimit()}>
      {uploadLimitSaving ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : null}
      {tr('保存上限', 'Save limit')}
    </Button>
    <Button type="button" variant="ghost" disabled={uploadLimitSaving || !uploadLimitHasRow} onClick={() => void onResetUploadLimit()}>
      {tr('恢复默认', 'Restore default')}
    </Button>
    {uploadLimitNotice && <span className="text-xs text-emerald-400">{uploadLimitNotice}</span>}
  </div>
</section>
```

- Import `Upload` from `lucide-react`.

- [ ] **Step 4: Run tests, build, and lint**

Run:
```bash
cd web
npm test -- src/pages/settings/General.test.tsx --run
npm run build
npm run lint
```
Expected: PASS.

---

### Task 4: Documentation and full verification

**Files:**
- Modify: `docs/install/windows.md`

- [ ] **Step 1: Update the Windows doc**

Append to the file-manager bullet: the single-file upload limit is configurable under 设置 → 全局配置 → 上传大小限制 (1 MiB–8 GiB, default 8 GiB).

- [ ] **Step 2: Run the full affected checks**

```bash
go test -race ./internal/manager/biz/setting ./internal/manager/server/webshell -count=1
go build ./cmd/ongrid
go vet ./internal/manager/biz/setting ./internal/manager/server/webshell ./cmd/ongrid
make arch-lint
cd web && npm test -- src/pages/settings/General.test.tsx --run && npm run build && npm run lint
```

Record the arch-lint result (tool may be missing).

- [ ] **Step 3: Manual end-to-end check**

1. Rebuild and restart manager + web:
   ```bash
   cd deploy
   docker compose build ongrid nginx
   docker compose up -d ongrid nginx
   ```
2. Set the limit to `1` MiB via the UI or API.
3. Upload a 2 MiB file to the Linux device file manager → 400 with the configured-limit message.
4. Upload a 512 KiB file → 200 and download roundtrip matches.
5. Reset the setting; confirm the default 8192 MiB and that the 2 MiB upload succeeds.
