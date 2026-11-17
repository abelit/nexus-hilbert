# Device File Write Roots UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin configure the global device-file upload roots from the settings UI, backed by `system_settings`, with `ONGRID_DEVICE_FILE_ROOTS` as the pre-save fallback.

**Architecture:** Reuse the existing `system_settings` store and `/v1/system-settings` API. A new `biz/setting.DeviceFileRoots` provider resolves DB value → env fallback; `bootstrapTunnel` injects it into the webshell handler, replacing the handler's direct env read. The admin-only Settings → General page gains a textarea card. Edge behavior is unchanged: it still filters platform-invalid roots and enforces writes.

**Tech Stack:** Go 1.25, chi, GORM-backed key/value settings, React 19 + TypeScript, Vitest, Tailwind 3 + shadcn-derived components.

**Spec:** [docs/design/device-file-manager.md](../../design/device-file-manager.md) §2.1

## Global Constraints

- Setting identity: category `platform`, key `device_file_write_roots`.
- Precedence: an existing DB row wins, including an explicit empty value (sandbox only). The env var is used only when no row exists.
- Input format: comma- or newline-separated device-side paths; trim, drop empties, de-duplicate exact strings; max 32 entries, 512 chars each.
- Manager must not judge OS-specific absolute paths; the Edge filters via `filepath.IsAbs` and enforces symlink/junction checks.
- No new HTTP endpoints, tables, or dependencies. Use the existing admin-only `PUT /v1/system-settings/{category}/{key}`.
- All user-facing frontend strings use `tr('中文', 'English')`; reuse existing UI components; settings pages are admin-only.
- Do not commit or push; leave changes in the working tree unless the user asks.
- Verification: `go test -race` for affected Go packages, `npm test -- src/pages/settings/General.test.tsx`, `npm run build`, `npm run lint`, `make arch-lint`.

## Review Focus

- An admin saves an empty value: the env fallback must not return; only the sandbox is writable.
- An admin has never saved: the env value must still apply (backward compatibility).
- A global list mixes Windows and Linux paths: each Edge ignores the other platform's entries without failing the request.
- A huge, duplicated, or malformed list must not produce an oversized FM preface or a 500: caps, de-dupe, and server-side validation.
- Only admins can change it: the new card lives on the admin-only settings page and the existing PUT requires admin. No new authorization path.

---

### Task 1: Setting model, parser, provider, validation

**Files:**
- Modify: `internal/manager/model/setting/model.go`
- Create: `internal/manager/biz/setting/device_files.go`
- Create: `internal/manager/biz/setting/device_files_test.go`

**Interfaces:**
- Consumes: `Service.Get(ctx, category, key) (string, bool, error)`, `Service.Set`, `model.CategoryPlatform`, `fakeRepo` from `service_test.go` (same package).
- Produces:
  - `model.KeyDeviceFileWriteRoots = "device_file_write_roots"`
  - `setting.ParseDeviceFileRoots(raw string) []string`
  - `setting.NewDeviceFileRoots(svc *Service) *DeviceFileRoots`
  - `(*DeviceFileRoots).Roots(ctx context.Context) []string`

- [ ] **Step 1: Write the failing tests**

Create `internal/manager/biz/setting/device_files_test.go`:

```go
package setting

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"

	model "github.com/ongridio/ongrid/internal/manager/model/setting"
)

func TestParseDeviceFileRoots(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"empty", "", nil},
		{"comma and newline", " /srv/app , D:\\data\n", []string{"/srv/app", `D:\data`}},
		{"dedupe", "/a,/a,/b", []string{"/a", "/b"}},
		{"skip oversized entry", "/ok," + strings.Repeat("x", maxDeviceFileRootLen+1), []string{"/ok"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ParseDeviceFileRoots(tc.in); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("ParseDeviceFileRoots(%q) = %#v, want %#v", tc.in, got, tc.want)
			}
		})
	}

	many := make([]string, 0, maxDeviceFileRoots+5)
	for i := 0; i < maxDeviceFileRoots+5; i++ {
		many = append(many, fmt.Sprintf("/p%d", i))
	}
	if got := ParseDeviceFileRoots(strings.Join(many, ",")); len(got) != maxDeviceFileRoots {
		t.Fatalf("len = %d, want cap %d", len(got), maxDeviceFileRoots)
	}
}

func TestDeviceFileRootsPrecedence(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	svc := New(repo, nil)
	t.Setenv("ONGRID_DEVICE_FILE_ROOTS", "/from-env")
	p := NewDeviceFileRoots(svc)

	if got, want := p.Roots(ctx), []string{"/from-env"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("env fallback = %#v, want %#v", got, want)
	}
	if err := svc.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileWriteRoots, "/from-db", false); err != nil {
		t.Fatal(err)
	}
	if got, want := p.Roots(ctx), []string{"/from-db"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("db value = %#v, want %#v", got, want)
	}
	if err := svc.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileWriteRoots, "", false); err != nil {
		t.Fatal(err)
	}
	if got := p.Roots(ctx); len(got) != 0 {
		t.Fatalf("explicit empty row = %#v, want sandbox-only", got)
	}
}

func TestValidateDeviceFileWriteRoots(t *testing.T) {
	repo := newFakeRepo()
	svc := New(repo, nil)
	ctx := context.Background()

	if err := svc.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileWriteRoots, `D:\data,/srv/app`, false); err != nil {
		t.Fatalf("valid list rejected: %v", err)
	}
	if err := svc.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileWriteRoots, strings.Repeat("x", maxDeviceFileRootLen+1), false); err == nil {
		t.Fatal("oversized entry accepted")
	}
	tooMany := make([]string, maxDeviceFileRoots+1)
	for i := range tooMany {
		tooMany[i] = "/p" + strings.Repeat("a", i%5)
	}
	if err := svc.Set(ctx, model.CategoryPlatform, model.KeyDeviceFileWriteRoots, strings.Join(tooMany, ","), false); err == nil {
		t.Fatal("oversized list accepted")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/manager/biz/setting -run 'TestParseDeviceFileRoots|TestDeviceFileRootsPrecedence|TestValidateDeviceFileWriteRoots' -count=1`
Expected: FAIL — undefined `maxDeviceFileRootLen`, `ParseDeviceFileRoots`, `NewDeviceFileRoots`, `KeyDeviceFileWriteRoots`.

- [ ] **Step 3: Add the model constant**

In `internal/manager/model/setting/model.go`, under `CategoryPlatform` keys, add:

```go
// KeyDeviceFileWriteRoots is the admin-editable list of device-side paths the
// device file manager may write to. Empty means sandbox-only.
KeyDeviceFileWriteRoots = "device_file_write_roots"
```

- [ ] **Step 4: Implement parser, provider, and validation**

Create `internal/manager/biz/setting/device_files.go`:

```go
package setting

import (
	"context"
	"log/slog"
	"os"
	"strings"

	model "github.com/ongridio/ongrid/internal/manager/model/setting"
)

const (
	envDeviceFileWriteRoots = "ONGRID_DEVICE_FILE_ROOTS"
	maxDeviceFileRoots      = 32
	maxDeviceFileRootLen    = 512
)

// DeviceFileRoots resolves the global writable roots for the device file
// manager. The DB setting wins; the environment variable is the fallback only
// when no row exists. An existing empty row means sandbox-only.
type DeviceFileRoots struct {
	svc *Service
}

func NewDeviceFileRoots(svc *Service) *DeviceFileRoots {
	return &DeviceFileRoots{svc: svc}
}

func (p *DeviceFileRoots) Roots(ctx context.Context) []string {
	if p != nil && p.svc != nil {
		raw, found, err := p.svc.Get(ctx, model.CategoryPlatform, model.KeyDeviceFileWriteRoots)
		if err != nil {
			p.svc.log.Warn("read device file write roots setting", slog.Any("err", err))
		} else if found {
			return ParseDeviceFileRoots(raw)
		}
	}
	return ParseDeviceFileRoots(os.Getenv(envDeviceFileWriteRoots))
}

// ParseDeviceFileRoots accepts comma- or newline-separated paths. Empty and
// oversized entries are dropped; exact duplicates keep their first position.
func ParseDeviceFileRoots(raw string) []string {
	fields := strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == '\n' })
	out := make([]string, 0, len(fields))
	seen := make(map[string]bool, len(fields))
	for _, field := range fields {
		field = strings.TrimSpace(field)
		if field == "" || len(field) > maxDeviceFileRootLen || seen[field] {
			continue
		}
		seen[field] = true
		out = append(out, field)
		if len(out) == maxDeviceFileRoots {
			break
		}
	}
	return out
}

func validateDeviceFileWriteRoots(value string) error {
	fields := strings.FieldsFunc(value, func(r rune) bool { return r == ',' || r == '\n' })
	count := 0
	for _, field := range fields {
		field = strings.TrimSpace(field)
		if field == "" {
			continue
		}
		count++
		if count > maxDeviceFileRoots {
			return errsInvalidRoots("at most %d roots", maxDeviceFileRoots)
		}
		if len(field) > maxDeviceFileRootLen {
			return errsInvalidRoots("each root must be at most %d characters", maxDeviceFileRootLen)
		}
		if strings.ContainsRune(field, 0) {
			return errsInvalidRoots("root contains NUL")
		}
	}
	return nil
}
```

Use `fmt.Errorf("%w: ...", errs.ErrInvalid)` for `errsInvalidRoots` (import `fmt` and `internal/pkg/errs`), e.g.:

```go
func errsInvalidRoots(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{errs.ErrInvalid}, args...)...)
}
```

Then in `validateSetting`'s `case model.CategoryPlatform:`, before the `auto_apm_enabled` check:

```go
if key == model.KeyDeviceFileWriteRoots {
	return validateDeviceFileWriteRoots(value)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test -race ./internal/manager/biz/setting -count=1`
Expected: PASS.

---

### Task 2: Inject provider into webshell handler and bootstrap

**Files:**
- Modify: `internal/manager/server/webshell/http.go`
- Modify: `internal/manager/server/webshell/filemanager.go`
- Modify: `internal/manager/server/webshell/filemanager_test.go`
- Modify: `cmd/ongrid/bootstrap_tunnel.go`
- Modify: `cmd/ongrid/main.go`

**Interfaces:**
- Consumes: `setting.NewDeviceFileRoots(settings.settingSvc).Roots` from Task 1.
- Produces: `webshell.WriteRootsFunc`, `(*Handler).SetWriteRoots`, `(*Handler).fileWriteRoots(ctx) []string`.

- [ ] **Step 1: Write the failing handler test**

In `internal/manager/server/webshell/filemanager_test.go`, change `newFMTestServer` to inject the root instead of setting the env var:

```go
func newFMTestServer(t *testing.T, writableRoot string) *httptest.Server {
	t.Helper()
	sandbox := t.TempDir()
	t.Setenv("ONGRID_EDGE_TRANSFER_DIR", sandbox)
	h := &Handler{
		tickets:    map[string]shellTicket{},
		failures:   map[string]authFailures{},
		streamer:   fmStreamer{},
		devices:    fileFakeDevices{},
		edges:      fileFakeEdges{},
		log:        slog.Default(),
		writeRoots: func(context.Context) []string { return []string{writableRoot} },
	}
	// ...rest unchanged
}
```

Add a focused test:

```go
func TestFileManagerUsesInjectedWriteRoots(t *testing.T) {
	root := t.TempDir()
	srv := newFMTestServer(t, root)
	res, err := http.Get(srv.URL + "/v1/devices/42/fm/roots")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK || !bytes.Contains(body, []byte(root)) {
		t.Fatalf("roots status=%d body=%s", res.StatusCode, body)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/manager/server/webshell -run TestFileManagerUsesInjectedWriteRoots -count=1`
Expected: FAIL — `Handler` has no field `writeRoots`.

- [ ] **Step 3: Add the provider seam to the handler**

In `internal/manager/server/webshell/http.go`:

```go
// WriteRootsFunc returns the manager-configured writable roots for the device
// file manager. The Edge still enforces the final path check.
type WriteRootsFunc func(ctx context.Context) []string
```

Add `writeRoots WriteRootsFunc` to `Handler`, and:

```go
// SetWriteRoots wires the device-file write-root provider post-construction.
func (h *Handler) SetWriteRoots(fn WriteRootsFunc) { h.writeRoots = fn }
```

In `internal/manager/server/webshell/filemanager.go`, replace the old `fileWriteRoots()` function with:

```go
func (h *Handler) fileWriteRoots(ctx context.Context) []string {
	if h.writeRoots == nil {
		return nil
	}
	return h.writeRoots(ctx)
}
```

Update the six call sites from `fileWriteRoots()` to `h.fileWriteRoots(r.Context())` (lines around 45, 60, 84, 133, 160, 174). Keep the `os` and `strings` imports: `os` is still used by the file operations and `strings` by `callFileManager`.

- [ ] **Step 4: Run the webshell tests**

Run: `go test -race ./internal/manager/server/webshell -count=1`
Expected: PASS.

- [ ] **Step 5: Wire bootstrap**

In `cmd/ongrid/bootstrap_tunnel.go`:
- Add `settings *settingsModule` as the last parameter of `bootstrapTunnel`.
- Import `managerbizsetting "github.com/ongridio/ongrid/internal/manager/biz/setting"`.
- After `webshellHandler := managerwebshellserver.NewHandler(...)`, add:

```go
webshellHandler.SetWriteRoots(managerbizsetting.NewDeviceFileRoots(settings.settingSvc).Roots)
```

In `cmd/ongrid/main.go`, pass `settings`:

```go
tunnel, err := bootstrapTunnel(rootCtx, cfg, log, &cleanup, storage, iam, devices, alerts, telemetry, settings)
```

- [ ] **Step 6: Build and run affected Go tests**

Run: `go build ./cmd/ongrid && go test -race ./internal/manager/server/webshell ./internal/manager/biz/setting -count=1`
Expected: PASS with no output from `go build`.

---

### Task 3: Settings → General card and tests

**Files:**
- Modify: `web/src/pages/settings/General.tsx`
- Modify: `web/src/pages/settings/General.test.tsx`

**Interfaces:**
- Consumes: `listSettings`, `setSetting`, `deleteSetting` from `@/api/settings`; `Textarea`, `Button`, `Label` from `@/components/ui`.
- Produces: a card with textarea id `device-file-roots`, save button label `保存可写目录`, reset button label `恢复环境变量默认`.

- [ ] **Step 1: Write the failing tests**

In `web/src/pages/settings/General.test.tsx`, extend the mock:

```ts
const deleteMock = vi.fn();
vi.mock('@/api/settings', () => ({
  listSettings: (category?: string) => listMock(category),
  setSetting: (category: string, key: string, value: string, sensitive?: boolean) =>
    setMock(category, key, value, sensitive),
  deleteSetting: (category: string, key: string) => deleteMock(category, key),
}));
```

Also reset the delete mock in `beforeEach`:

```ts
deleteMock.mockReset().mockResolvedValue(undefined);
```

Add tests:

```tsx
describe('general settings — device file write roots', () => {
  it('loads the saved roots and saves normalized lines', async () => {
    listMock.mockImplementation((category?: string) =>
      Promise.resolve(
        category === 'platform'
          ? {
              items: [{
                category: 'platform',
                key: 'device_file_write_roots',
                value: 'D:\\data\n/srv/app',
                sensitive: false,
                updated_at: '',
              }],
              total: 1,
            }
          : { items: [], total: 0 },
      ),
    );
    const user = userEvent.setup();
    render(<SettingsGeneral />);

    const box = await screen.findByLabelText('允许上传的目录');
    expect(box).toHaveValue('D:\\data\n/srv/app');
    await user.clear(box);
    await user.type(box, 'D:\\data{Enter}/srv/app{Enter}/opt/app');
    await user.click(screen.getByRole('button', { name: '保存可写目录' }));

    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        'platform',
        'device_file_write_roots',
        'D:\\data\n/srv/app\n/opt/app',
        false,
      ),
    );
  });

  it('rejects a relative path', async () => {
    const user = userEvent.setup();
    render(<SettingsGeneral />);
    const box = await screen.findByLabelText('允许上传的目录');
    await user.type(box, 'relative/path');
    await user.click(screen.getByRole('button', { name: '保存可写目录' }));
    expect(await screen.findByText(/必须是绝对路径/)).toBeInTheDocument();
    expect(setMock).not.toHaveBeenCalledWith(
      'platform',
      'device_file_write_roots',
      expect.anything(),
      false,
    );
  });

  it('restores the env fallback by deleting the row', async () => {
    listMock.mockImplementation((category?: string) =>
      Promise.resolve(
        category === 'platform'
          ? {
              items: [{
                category: 'platform',
                key: 'device_file_write_roots',
                value: '/srv/app',
                sensitive: false,
                updated_at: '',
              }],
              total: 1,
            }
          : { items: [], total: 0 },
      ),
    );
    const user = userEvent.setup();
    render(<SettingsGeneral />);
    await user.click(await screen.findByRole('button', { name: '恢复环境变量默认' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('platform', 'device_file_write_roots'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npm test -- src/pages/settings/General.test.tsx`
Expected: FAIL — no `device-file-roots` label / no reset button / `deleteSetting` mock missing.

- [ ] **Step 3: Implement the card**

In `web/src/pages/settings/General.tsx`:
- Add `Textarea` to the `@/components/ui` import and `deleteSetting` to the `@/api/settings` import.
- Add constants:

```ts
const DEVICE_FILE_ROOTS_KEY = 'device_file_write_roots';
const MAX_FILE_ROOTS = 32;
const MAX_FILE_ROOT_LEN = 512;
```

- In `SettingsGeneral`, add state: `rootsText`, `rootsHasRow`, `rootsSaving`, `rootsError`, `rootsSaved`.
- In `load`, after finding the network key:

```ts
const rootsRow = response.items.find((item) => item.key === DEVICE_FILE_ROOTS_KEY);
setRootsHasRow(Boolean(rootsRow));
setRootsText(
  rootsRow?.value
    ? rootsRow.value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).join('\n')
    : '',
);
```

- Add a parser/validator:

```ts
function parseFileRoots(
  raw: string,
  tr: (zh: string, en: string) => string,
): { roots: string[]; error: string | null } {
  const roots = [...new Set(raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))];
  if (roots.length > MAX_FILE_ROOTS) {
    return { roots, error: tr(`最多 ${MAX_FILE_ROOTS} 个目录`, `At most ${MAX_FILE_ROOTS} directories`) };
  }
  for (const root of roots) {
    if (root.startsWith('\\\\') || root.startsWith('//')) {
      return { roots, error: tr('不支持 UNC 路径', 'UNC paths are not supported') };
    }
    const windowsAbs = /^[A-Za-z]:[\\/]/.test(root);
    const posixAbs = root.startsWith('/');
    if (!windowsAbs && !posixAbs) {
      return {
        roots,
        error: tr('必须是绝对路径，例如 D:\\data 或 /srv/app', 'Must be an absolute path, e.g. D:\\data or /srv/app'),
      };
    }
    if (root.length > MAX_FILE_ROOT_LEN) {
      return {
        roots,
        error: tr(`单个目录不能超过 ${MAX_FILE_ROOT_LEN} 个字符`, `Each directory must be at most ${MAX_FILE_ROOT_LEN} characters`),
      };
    }
  }
  return { roots, error: null };
}
```

- Add `onSaveFileRoots` and `onResetFileRoots` callbacks using `setSetting`/`deleteSetting` with `CATEGORY`; `onSaveFileRoots` calls `parseFileRoots(rootsText, tr)` and writes `roots.join('\n')`; on reset, set `rootsText` to `''`, `rootsHasRow=false`, show `已恢复环境变量默认值`.
- Render the card after the network discovery section, before `<EdgeInstallAddressCard />`:

```tsx
<section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
  <div className="mb-3 flex items-center gap-2">
    <FolderOpen size={14} className="text-zinc-400" />
    <h2 className="text-sm font-medium text-zinc-100">{tr('设备文件管理', 'Device files')}</h2>
  </div>
  <p className="mb-4 text-xs leading-relaxed text-zinc-500">
    {tr(
      '允许文件管理上传、新建目录和重命名的设备端目录。所有设备共用；读取不受限制，Edge 传输沙箱始终可写。留空表示只允许传输沙箱。',
      'Device-side directories where the file manager may upload, create folders, and rename. Shared by all devices; reads are unrestricted and the Edge transfer sandbox is always writable. Leave empty for sandbox-only.',
    )}
  </p>
  <Label htmlFor="device-file-roots">{tr('允许上传的目录', 'Writable upload directories')}</Label>
  <Textarea
    id="device-file-roots"
    rows={4}
    spellCheck={false}
    placeholder={'D:\\data\n/srv/app'}
    value={rootsText}
    onChange={(event) => {
      setRootsText(event.target.value);
      setRootsSaved(false);
    }}
  />
  <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
    {tr('每行一个绝对路径，也支持逗号分隔。', 'One absolute path per line; commas are also accepted.')}
  </p>
  <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
    {rootsHasRow
      ? tr('当前由界面配置；留空表示只允许传输沙箱。', 'Configured here; empty means sandbox-only.')
      : tr('尚未保存，使用部署环境变量 ONGRID_DEVICE_FILE_ROOTS（如果已设置）。', 'Not saved yet; using the deployment env var ONGRID_DEVICE_FILE_ROOTS if set.')}
  </p>
  {rootsError && <div className="mt-3 text-xs text-red-400">{rootsError}</div>}
  <div className="mt-4 flex flex-wrap items-center gap-3">
    <Button type="button" variant="primary" disabled={rootsSaving} onClick={() => void onSaveFileRoots()}>
      {rootsSaving ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : null}
      {tr('保存可写目录', 'Save directories')}
    </Button>
    <Button type="button" variant="ghost" disabled={rootsSaving || !rootsHasRow} onClick={() => void onResetFileRoots()}>
      {tr('恢复环境变量默认', 'Restore env default')}
    </Button>
    {rootsSaved && <span className="text-xs text-emerald-400">{tr('已保存', 'Saved')}</span>}
  </div>
</section>
```

- Import `FolderOpen` from `lucide-react`.

- [ ] **Step 4: Run tests, build, and lint**

Run:
```bash
cd web
npm test -- src/pages/settings/General.test.tsx
npm run build
npm run lint
```
Expected: all PASS.

---

### Task 4: Documentation and full verification

**Files:**
- Modify: `docs/install/windows.md` (the `ONGRID_DEVICE_FILE_ROOTS` sentence near the Windows file-manager note)
- Already updated: `docs/design/device-file-manager.md` §2.1

**Interfaces:** none.

- [ ] **Step 1: Update the Windows install doc**

Replace the `ONGRID_DEVICE_FILE_ROOTS` mention with:

```md
可写根可在 Manager 的「设置 → 全局配置 → 设备文件管理」中配置（保存后写入 `system_settings`，优先于环境变量），也可继续使用部署环境变量 `ONGRID_DEVICE_FILE_ROOTS` 作为未保存时的默认值。详见[设备文件管理](../design/device-file-manager.md)。
```

- [ ] **Step 2: Run the full affected checks**

```bash
go test -race ./internal/manager/biz/setting ./internal/manager/server/webshell -count=1
go build ./cmd/ongrid
make arch-lint
cd web && npm test -- src/pages/settings/General.test.tsx && npm run build && npm run lint
```

Expected: Go tests PASS, build succeeds, arch-lint passes or reports the tool-skip (record which), frontend tests/build/lint PASS.

- [ ] **Step 3: Manual end-to-end check (dev stack)**

1. Rebuild and restart the manager:
   ```bash
   cd deploy
   docker compose build ongrid
   docker compose up -d ongrid
   ```
2. Log in as admin, open Settings → General, save `/var/lib/ongrid-edge/transfer` plus a new directory (e.g. `/tmp/fm-roots-test`) in the card.
3. Open the Linux device file manager: the roots list must show both the sandbox and `/tmp/fm-roots-test`; upload a file into the new root.
4. Open the Windows device file manager: the Windows Edge must ignore the Linux path and still show its sandbox + configured Windows roots.
5. Press「恢复环境变量默认」and confirm the roots list falls back to the env value (or sandbox-only when unset).
