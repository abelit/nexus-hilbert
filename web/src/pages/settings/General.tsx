import { useAssistantPage } from '@/lib/assistantPage';
import { Switch } from '@/components/ui/Switch';
import { Button, Input, Label, Textarea } from '@/components/ui';
import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Link2, Loader2, Network, Upload } from 'lucide-react';
import { deleteSetting, listSettings, setSetting } from '@/api/settings';
import { useI18n } from '@/i18n/locale';
import {
  EDGE_INSTALL_EXTERNAL_KEY,
  EDGE_INSTALL_INTERNAL_KEY,
  EDGE_SETTINGS_CATEGORY,
  normalizeBaseUrl,
} from '@/lib/installAddresses';

const CATEGORY = 'platform';
const KEY = 'network_discovery_enabled';
const DEVICE_FILE_ROOTS_KEY = 'device_file_write_roots';
const MAX_FILE_ROOTS = 32;
const MAX_FILE_ROOT_LEN = 512;
// Leaves headroom under the Edge's 16 KiB FM preface limit.
const MAX_FILE_ROOTS_JSON = 12 * 1024;
const DEVICE_FILE_MAX_UPLOAD_MB_KEY = 'device_file_max_upload_mb';
const MIN_UPLOAD_MB = 1;
const MAX_UPLOAD_MB = 8192;
const DEFAULT_UPLOAD_MB = 8192;

// Match the manager's fail-open default: only an explicit false disables
// admission. This keeps the displayed state correct for old or malformed rows.
function isDiscoveryEnabled(value?: string): boolean {
  return value?.trim().toLowerCase() !== 'false';
}

// parseFileRoots accepts one absolute path per line (commas also work). It is
// shared by the save path and the inline validation message.
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
  const bytes = new TextEncoder().encode(JSON.stringify(roots)).length;
  if (bytes > MAX_FILE_ROOTS_JSON) {
    return {
      roots,
      error: tr(
        '可写目录总长度超出请求限制，请减少目录数量或长度',
        'The directory list exceeds the request size limit; remove entries or shorten them',
      ),
    };
  }
  return { roots, error: null };
}

export default function SettingsGeneral() {
  const { tr } = useI18n();
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rootsText, setRootsText] = useState('');
  const [rootsHasRow, setRootsHasRow] = useState(false);
  const [rootsSaving, setRootsSaving] = useState(false);
  const [rootsError, setRootsError] = useState<string | null>(null);
  const [rootsNotice, setRootsNotice] = useState('');
  const [uploadLimitText, setUploadLimitText] = useState(String(DEFAULT_UPLOAD_MB));
  const [uploadLimitHasRow, setUploadLimitHasRow] = useState(false);
  const [uploadLimitSaving, setUploadLimitSaving] = useState(false);
  const [uploadLimitError, setUploadLimitError] = useState<string | null>(null);
  const [uploadLimitNotice, setUploadLimitNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await listSettings(CATEGORY);
      const row = response.items.find((item) => item.key === KEY);
      // Missing row follows the Manager default: enabled for new installs.
      setEnabled(isDiscoveryEnabled(row?.value));
      const rootsRow = response.items.find((item) => item.key === DEVICE_FILE_ROOTS_KEY);
      setRootsHasRow(Boolean(rootsRow));
      setRootsText(
        rootsRow?.value
          ? rootsRow.value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).join('\n')
          : '',
      );
      const uploadRow = response.items.find((item) => item.key === DEVICE_FILE_MAX_UPLOAD_MB_KEY);
      setUploadLimitHasRow(Boolean(uploadRow));
      setUploadLimitText(uploadRow?.value?.trim() || String(DEFAULT_UPLOAD_MB));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onToggle = useCallback(async (next: boolean) => {
    setSaving(true);
    setError(null);
    setEnabled(next);
    try {
      await setSetting(CATEGORY, KEY, next ? 'true' : 'false', false);
    } catch (err) {
      setEnabled(!next);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, []);

  const onSaveFileRoots = useCallback(async () => {
    const parsed = parseFileRoots(rootsText, tr);
    if (parsed.error) {
      setRootsError(parsed.error);
      setRootsNotice('');
      return;
    }
    setRootsSaving(true);
    setRootsError(null);
    setRootsNotice('');
    try {
      const value = parsed.roots.join('\n');
      await setSetting(CATEGORY, DEVICE_FILE_ROOTS_KEY, value, false);
      setRootsText(value);
      setRootsHasRow(true);
      setRootsNotice(tr('已保存', 'Saved'));
    } catch (err) {
      setRootsError(err instanceof Error ? err.message : String(err));
    } finally {
      setRootsSaving(false);
    }
  }, [rootsText, tr]);

  const onResetFileRoots = useCallback(async () => {
    setRootsSaving(true);
    setRootsError(null);
    setRootsNotice('');
    try {
      await deleteSetting(CATEGORY, DEVICE_FILE_ROOTS_KEY);
      setRootsText('');
      setRootsHasRow(false);
      setRootsNotice(tr('已恢复环境变量默认值', 'Restored env default'));
    } catch (err) {
      setRootsError(err instanceof Error ? err.message : String(err));
    } finally {
      setRootsSaving(false);
    }
  }, [tr]);

  const onSaveUploadLimit = useCallback(async () => {
    const n = Number(uploadLimitText);
    if (!Number.isInteger(n) || n < MIN_UPLOAD_MB || n > MAX_UPLOAD_MB) {
      setUploadLimitError(
        tr(
          `请输入 ${MIN_UPLOAD_MB}–${MAX_UPLOAD_MB} 之间的整数（MiB）`,
          `Enter an integer between ${MIN_UPLOAD_MB} and ${MAX_UPLOAD_MB} MiB`,
        ),
      );
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

  useAssistantPage('通用设置', 'General settings', {
    network_discovery_enabled: enabled,
    device_file_write_roots: rootsText,
    device_file_max_upload_mb: uploadLimitText,
    loading,
  });

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="mb-3 flex items-center gap-2">
          <Network size={14} className="text-zinc-400" />
          <h2 className="text-sm font-medium text-zinc-100">{tr('网络发现', 'Network discovery')}</h2>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-zinc-500">
          {tr(
            '控制平台是否接收 Edge 上报的默认网关、ARP 邻居和 LLDP 邻居。关闭后不会再创建或更新候选设备，已有候选和正式网络设备不会被删除。',
            'Controls whether the platform accepts gateway, ARP-neighbor, and LLDP-neighbor reports from Edges. When disabled, no candidates are created or updated; existing candidates and verified network devices remain.',
          )}
        </p>

        {loading ? (
          <div className="flex h-10 items-center text-xs text-zinc-500">
            <Loader2 size={13} className="mr-2 animate-spin" /> {tr('加载中…', 'Loading…')}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-zinc-800 bg-zinc-950/40 px-4 py-3">
            <div>
              <div className="text-[13px] font-medium text-zinc-200">
                {tr('启用网络发现', 'Enable network discovery')}
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-500">
                {enabled
                  ? tr('当前：接收所有已启用 Edge 的发现上报', 'Current: accept discovery reports from enabled Edges')
                  : tr('当前：忽略新的网络发现上报', 'Current: ignore new network discovery reports')}
              </div>
            </div>
            <Switch checked={enabled} disabled={saving} onCheckedChange={(next) => void onToggle(next)} aria-label={tr('启用网络发现', 'Enable network discovery')} />
          </div>
        )}

        {error && <div className="mt-3 text-xs text-red-400">{error}</div>}

        <p className="mt-4 text-[11px] leading-relaxed text-zinc-600">
          {tr(
            '新安装的 Edge 默认开启本地采集。若只想停用某一台主机，可将其 /etc/ongrid-edge/ongrid-edge.env 中的 ONGRID_NETWORK_DISCOVERY_ENABLED 设为 false 后重启服务。',
            'New Edges collect locally by default. To stop one host only, set ONGRID_NETWORK_DISCOVERY_ENABLED=false in /etc/ongrid-edge/ongrid-edge.env and restart its service.',
          )}
        </p>
      </section>

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
            setRootsNotice('');
          }}
        />
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
          {tr('每行一个绝对路径，也支持逗号分隔。', 'One absolute path per line; commas are also accepted.')}
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
          {rootsHasRow
            ? tr('当前由界面配置；留空表示只允许传输沙箱。', 'Configured here; empty means sandbox-only.')
            : tr(
                '尚未保存，使用部署环境变量 ONGRID_DEVICE_FILE_ROOTS（如果已设置）。',
                'Not saved yet; using the deployment env var ONGRID_DEVICE_FILE_ROOTS if set.',
              )}
        </p>

        {rootsError && <div className="mt-3 text-xs text-red-400">{rootsError}</div>}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="button" variant="primary" disabled={rootsSaving} onClick={() => void onSaveFileRoots()}>
            {rootsSaving ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : null}
            {tr('保存可写目录', 'Save directories')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={rootsSaving || !rootsHasRow}
            onClick={() => void onResetFileRoots()}
          >
            {tr('恢复环境变量默认', 'Restore env default')}
          </Button>
          {rootsNotice && <span className="text-xs text-emerald-400">{rootsNotice}</span>}
        </div>
      </section>

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
          <Button
            type="button"
            variant="ghost"
            disabled={uploadLimitSaving || !uploadLimitHasRow}
            onClick={() => void onResetUploadLimit()}
          >
            {tr('恢复默认', 'Restore default')}
          </Button>
          {uploadLimitNotice && <span className="text-xs text-emerald-400">{uploadLimitNotice}</span>}
        </div>
      </section>

      <EdgeInstallAddressCard />
    </div>
  );
}

// EdgeInstallAddressCard edits the two base URLs the Devices page turns into
// copy-paste install commands. Empty values keep the historical behaviour:
// the command uses the host the browser is currently visiting.
function EdgeInstallAddressCard() {
  const { tr } = useI18n();
  const [internal, setInternal] = useState('');
  const [external, setExternal] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listSettings(EDGE_SETTINGS_CATEGORY)
      .then((response) => {
        if (cancelled) return;
        const valueOf = (key: string) => response.items.find((item) => item.key === key)?.value ?? '';
        setInternal(valueOf(EDGE_INSTALL_INTERNAL_KEY));
        setExternal(valueOf(EDGE_INSTALL_EXTERNAL_KEY));
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSave = useCallback(async () => {
    const internalValue = internal.trim() === '' ? '' : normalizeBaseUrl(internal);
    if (internalValue === null) {
      setError(tr('内网地址必须是完整的 http(s) URL，例如 https://ongrid.intra', 'The internal address must be a full http(s) URL, e.g. https://ongrid.intra'));
      return;
    }
    const externalValue = external.trim() === '' ? '' : normalizeBaseUrl(external);
    if (externalValue === null) {
      setError(tr('外网地址必须是完整的 http(s) URL，例如 https://ongrid.example.com', 'The external address must be a full http(s) URL, e.g. https://ongrid.example.com'));
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await setSetting(EDGE_SETTINGS_CATEGORY, EDGE_INSTALL_INTERNAL_KEY, internalValue, false);
      await setSetting(EDGE_SETTINGS_CATEGORY, EDGE_INSTALL_EXTERNAL_KEY, externalValue, false);
      setInternal(internalValue);
      setExternal(externalValue);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [external, internal, tr]);

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="mb-3 flex items-center gap-2">
        <Link2 size={14} className="text-zinc-400" />
        <h2 className="text-sm font-medium text-zinc-100">{tr('Edge 安装地址', 'Edge install addresses')}</h2>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-zinc-500">
        {tr(
          '用于设备页和集群接入弹窗生成的安装命令。内网地址供内网主机使用，外网地址供公网主机使用；两者都必须能提供 /edge/ 下的安装包。留空则使用浏览器当前访问的地址。',
          'Used by the install commands on the Devices page and the cluster enrollment dialog. The internal address serves intranet hosts, the external one serves public hosts; both must serve the artifacts under /edge/. Leave empty to use the browser’s current address.',
        )}
      </p>

      {loading ? (
        <div className="flex h-10 items-center text-xs text-zinc-500">
          <Loader2 size={13} className="mr-2 animate-spin" /> {tr('加载中…', 'Loading…')}
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <Label htmlFor="edge-install-internal-url">{tr('内网地址', 'Internal address')}</Label>
            <Input
              id="edge-install-internal-url"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://ongrid.intra"
              value={internal}
              onChange={(event) => {
                setInternal(event.target.value);
                setSaved(false);
              }}
            />
          </div>
          <div>
            <Label htmlFor="edge-install-external-url">{tr('外网地址', 'External address')}</Label>
            <Input
              id="edge-install-external-url"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://ongrid.example.com"
              value={external}
              onChange={(event) => {
                setExternal(event.target.value);
                setSaved(false);
              }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="primary" disabled={saving} onClick={() => void onSave()}>
              {saving ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : null}
              {tr('保存', 'Save')}
            </Button>
            {saved && <span className="text-xs text-emerald-400">{tr('已保存', 'Saved')}</span>}
            {error && <span className="text-xs text-red-400">{error}</span>}
          </div>
          <p className="text-[11px] leading-relaxed text-zinc-600">
            {tr(
              '两个地址至少配置一个后，安装命令会出现“内网 / 外网”切换；只配置一个时直接使用该地址。',
              'With at least one address configured the install command shows an Internal / External switch; with only one it is used directly.',
            )}
          </p>
        </div>
      )}
    </section>
  );
}
