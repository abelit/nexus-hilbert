import { useAssistantPage } from '@/lib/assistantPage';
import { Switch } from '@/components/ui/Switch';
import { Button, Input, Label } from '@/components/ui';
import { useCallback, useEffect, useState } from 'react';
import { Link2, Loader2, Network } from 'lucide-react';
import { listSettings, setSetting } from '@/api/settings';
import { useI18n } from '@/i18n/locale';
import {
  EDGE_INSTALL_EXTERNAL_KEY,
  EDGE_INSTALL_INTERNAL_KEY,
  EDGE_SETTINGS_CATEGORY,
  normalizeBaseUrl,
} from '@/lib/installAddresses';

const CATEGORY = 'platform';
const KEY = 'network_discovery_enabled';

// Match the manager's fail-open default: only an explicit false disables
// admission. This keeps the displayed state correct for old or malformed rows.
function isDiscoveryEnabled(value?: string): boolean {
  return value?.trim().toLowerCase() !== 'false';
}

export default function SettingsGeneral() {
  const { tr } = useI18n();
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await listSettings(CATEGORY);
      const row = response.items.find((item) => item.key === KEY);
      // Missing row follows the Manager default: enabled for new installs.
      setEnabled(isDiscoveryEnabled(row?.value));
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

  useAssistantPage('通用设置', 'General settings', {
    network_discovery_enabled: enabled,
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
