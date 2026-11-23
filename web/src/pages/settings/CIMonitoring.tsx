import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MonitorPlay, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';

import {
  Button,
  Card,
  Chip,
  EmptyState,
  Input,
  Label,
  Select,
  Switch,
} from '@/components/ui';
import { Modal } from '@/components/Modal';
import { useDialogs } from '@/components/ui/useDialogs';
import { ApiError } from '@/api/client';
import { useI18n } from '@/i18n/locale';
import { listCITypes, type CIType } from '@/api/federation';
import {
  createMonitoringConnection,
  deleteCILink,
  deleteMonitoringConnection,
  listCILinks,
  listMonitoringConnections,
  monitoringConnectionsHealth,
  previewCILink,
  saveCILink,
  setPlatformConnectionEnabled,
  testMonitoringConnection,
  testSavedMonitoringConnection,
  updateMonitoringConnection,
  type CILink,
  type CILinkInput,
  type CIPreview,
  type ConnectionHealth,
  type LabelMapping,
  type Matcher,
  type MonitoringConnection,
  type MonitoringConnectionInput,
  type Provider,
  type VarMapping,
} from '@/api/ciMonitoring';
import {
  listSettings,
  revealSetting,
  setSetting,
  testGrafanaConnection,
  testPromConnection,
} from '@/api/settings';
import { invalidateGrafanaRootCache } from '@/lib/drilldown';

const OPEN_MODES = [
  { value: 'link', label: 'link' },
  { value: 'embed', label: 'embed' },
];

const MATCHER_OPS = ['eq', 'ne', 'regex'].map((op) => ({ value: op, label: op }));

// The platform connection edits the same system_settings rows as
// Settings → Integrations. Keys and sensitivity match that page, so the two
// entry points cannot drift into different credential semantics.
const GRAFANA_KEYS = ['root_url', 'sa_token', 'api_key', 'org_id', 'tls_insecure'] as const;
const GRAFANA_SENSITIVE = new Set<string>(['sa_token', 'api_key']);
const PROM_KEYS = ['query_url', 'remote_write_url', 'bearer_token', 'basic_user', 'basic_password', 'tls_insecure'] as const;
const PROM_SENSITIVE = new Set<string>(['bearer_token', 'basic_password']);

type PlatformForm = Record<string, string>;

export default function CIMonitoringSettings() {
  const { tr } = useI18n();
  const [refreshToken, setRefreshToken] = useState(0);
  const [ciTypes, setCITypes] = useState<CIType[]>([]);

  useEffect(() => {
    void listCITypes()
      .then((response) => setCITypes(response.items ?? []))
      .catch(() => setCITypes([]));
  }, [refreshToken]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-text">{tr('CI 监控', 'CI monitoring')}</h1>
          <p className="mt-1 max-w-2xl text-xs text-text-muted">
            {tr(
              '每个供应商是一个整体：连接、平台内部配置与 CI 链接都在同一张卡片内完成。',
              'Each provider is one unit: connections, platform configuration, and CI links live in the same card.',
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() => setRefreshToken((token) => token + 1)}
          aria-label={tr('刷新全部', 'Refresh all')}
        >
          <RefreshCw size={12} />
          {tr('刷新', 'Refresh')}
        </Button>
      </div>

      <ProviderSection provider="grafana" ciTypes={ciTypes} refreshToken={refreshToken} />
      <ProviderSection provider="prometheus" ciTypes={ciTypes} refreshToken={refreshToken} />
    </div>
  );
}

function ProviderSection({
  provider,
  ciTypes,
  refreshToken,
}: {
  provider: Provider;
  ciTypes: CIType[];
  refreshToken: number;
}) {
  const { tr } = useI18n();
  const { confirmAction, alertAction, dialog } = useDialogs();
  const label = provider === 'grafana' ? 'Grafana' : 'Prometheus';

  const [connections, setConnections] = useState<MonitoringConnection[]>([]);
  const [health, setHealth] = useState<Record<number, ConnectionHealth>>({});
  const [connLoading, setConnLoading] = useState(true);
  const [connErr, setConnErr] = useState<string | null>(null);
  const [busyConn, setBusyConn] = useState<number | null>(null);

  const [links, setLinks] = useState<CILink[]>([]);
  const [linksLoading, setLinksLoading] = useState(true);
  const [linksErr, setLinksErr] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [editingConn, setEditingConn] = useState<MonitoringConnection | null>(null);
  const [creatingConn, setCreatingConn] = useState(false);
  const [configuringPlatform, setConfiguringPlatform] = useState(false);
  const [editingLink, setEditingLink] = useState<CILink | null>(null);
  const [creatingLink, setCreatingLink] = useState(false);

  const loadConnections = useCallback(async () => {
    setConnLoading(true);
    try {
      const [rows, healthRows] = await Promise.all([
        listMonitoringConnections(provider),
        monitoringConnectionsHealth(provider).catch(() => ({ items: [] as ConnectionHealth[], total: 0 })),
      ]);
      setConnections(rows.items ?? []);
      setHealth(Object.fromEntries((healthRows.items ?? []).map((row) => [row.id, row])));
      setConnErr(null);
    } catch (e) {
      setConnErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setConnLoading(false);
    }
  }, [provider]);

  const loadLinks = useCallback(async () => {
    setLinksLoading(true);
    try {
      const response = await listCILinks(provider);
      setLinks(response.items ?? []);
      setLinksErr(null);
    } catch (e) {
      setLinksErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLinksLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    void loadConnections();
    void loadLinks();
  }, [loadConnections, loadLinks, refreshToken]);

  const typeName = useCallback(
    (id: number) => {
      const found = ciTypes.find((ciType) => ciType.id === id);
      return found ? found.alias || found.name : `#${id}`;
    },
    [ciTypes],
  );

  const connectionName = useCallback(
    (id?: number) => {
      if (!id) return tr('平台内部', 'Platform');
      return connections.find((conn) => conn.id === id)?.name ?? `#${id}`;
    },
    [connections, tr],
  );

  const visibleLinks = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return links;
    return links.filter((link) => {
      const name = typeName(link.ci_type_id).toLowerCase();
      return name.includes(query) || String(link.ci_type_id) === query;
    });
  }, [links, search, typeName]);

  const stats = useMemo(() => {
    const platform = links.filter((link) => !link.connection_id).length;
    const healthRows = Object.values(health);
    return {
      platform,
      external: links.length - platform,
      healthy: healthRows.length ? `${healthRows.filter((row) => row.ok).length}/${healthRows.length}` : '—',
    };
  }, [links, health]);

  const platformEnabled = connections.find((conn) => conn.kind === 'internal')?.enabled ?? true;

  async function toggleConnection(row: MonitoringConnection, enabled: boolean) {
    setBusyConn(row.id);
    try {
      if (row.kind === 'internal') {
        await setPlatformConnectionEnabled(provider, enabled);
      } else {
        // auth_data is omitted so the stored credential is preserved.
        await updateMonitoringConnection(provider, row.id, {
          name: row.name,
          base_url: row.base_url ?? '',
          auth_type: (row.auth_type as 'none' | 'bearer' | 'basic') || 'none',
          tls_insecure: row.tls_insecure,
          enabled,
          remark: row.remark ?? '',
        });
      }
      await loadConnections();
    } catch (e) {
      await alertAction(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusyConn(null);
    }
  }

  async function probe(row: MonitoringConnection) {
    try {
      if (row.kind === 'internal') {
        await loadConnections();
        return;
      }
      await testSavedMonitoringConnection(row.id);
      await loadConnections();
    } catch (e) {
      await alertAction(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  async function removeConnection(row: MonitoringConnection) {
    if (!(await confirmAction(tr(`删除连接「${row.name}」？`, `Delete connection “${row.name}”?`)))) return;
    try {
      await deleteMonitoringConnection(row.id);
      await loadConnections();
    } catch (e) {
      await alertAction(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  async function removeLink(link: CILink) {
    if (!(await confirmAction(tr('删除该监控链接？', 'Delete this monitoring link?')))) return;
    try {
      await deleteCILink(provider, link.ci_type_id);
      await loadLinks();
    } catch (e) {
      await alertAction(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center gap-2">
        <MonitorPlay size={14} className="text-text-faint" />
        <h2 className="text-sm font-semibold text-text">{tr(`${label} 监控`, `${label} monitoring`)}</h2>
      </div>
      <p className="mb-4 text-[11px] text-text-muted">
        {provider === 'grafana'
          ? tr(
              '管理平台内部或外部 Grafana 连接，并把 CI 类型绑定到仪表盘变量；连接、配置和链接共用同一份设置。',
              'Manage the platform or external Grafana connections and bind CI types to dashboard variables; connections, configuration, and links share one setup.',
            )
          : tr(
              '管理平台内部或外部 Prometheus 连接，并把 CI 类型绑定到告警标签；连接、配置和链接共用同一份设置。',
              'Manage the platform or external Prometheus connections and bind CI types to alert labels; connections, configuration, and links share one setup.',
            )}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="text-xs font-medium text-text">{tr('连接', 'Connections')}</h3>
          <span className="text-[10.5px] text-text-faint">
            {tr('平台内部 + 外部实例', 'Platform + external instances')}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() => { setEditingConn(null); setCreatingConn(true); }}
        >
          <Plus size={12} />
          {tr('新建外部连接', 'New external connection')}
        </Button>
      </div>

      {connErr && (
        <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-[11px] text-red-500 dark:text-red-300">
          <div>{connErr}</div>
          <Button variant="subtle" size="sm" type="button" className="mt-2" onClick={() => void loadConnections()}>
            {tr('重试', 'Retry')}
          </Button>
        </div>
      )}

      <div className="mt-2">
        {connLoading && connections.length === 0 ? (
          <p className="py-6 text-center text-[11px] text-text-faint">{tr('加载中…', 'Loading…')}</p>
        ) : (
          <div className="og-resource-table overflow-x-auto" data-variant="quiet">
            <table className="w-full min-w-[680px] text-xs">
              <thead>
                <tr>
                  <th>{tr('名称', 'Name')}</th>
                  <th>{tr('类型', 'Kind')}</th>
                  <th>{tr('地址 / 认证', 'Endpoint / auth')}</th>
                  <th>{tr('健康', 'Health')}</th>
                  <th>{tr('启用', 'Enabled')}</th>
                  <th className="text-right">{tr('操作', 'Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((row) => (
                  <tr key={`${row.kind}-${row.id}`}>
                    <td className="whitespace-nowrap text-text">{row.name}</td>
                    <td className="whitespace-nowrap">
                      {row.kind === 'internal' ? (
                        <Chip tone="info">{tr('平台内部', 'Platform')}</Chip>
                      ) : (
                        <Chip>{tr('外部', 'External')}</Chip>
                      )}
                    </td>
                    <td
                      className="max-w-[13rem] truncate font-mono text-[11px] text-text-muted"
                      title={row.kind === 'internal'
                        ? tr('Settings → 集成', 'Settings → Integrations')
                        : `${row.base_url ?? ''}${row.auth_type && row.auth_type !== 'none' ? ` · ${row.auth_type}` : ''}`}
                    >
                      {row.kind === 'internal'
                        ? tr('Settings → 集成', 'Settings → Integrations')
                        : `${row.base_url ?? ''}${row.auth_type && row.auth_type !== 'none' ? ` · ${row.auth_type}` : ''}`}
                    </td>
                    <td><ConnectionHealthLabel row={row} health={health[row.id]} /></td>
                    <td className="whitespace-nowrap">
                      <Switch
                        checked={row.enabled}
                        disabled={busyConn === row.id}
                        onCheckedChange={(checked) => void toggleConnection(row, checked)}
                        aria-label={tr(`启用 ${row.name}`, `Enable ${row.name}`)}
                      />
                    </td>
                    <td className="text-right">
                      <div className="flex justify-end gap-1">
                        {row.kind === 'internal' ? (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              type="button"
                              onClick={() => { setEditingConn(null); setCreatingConn(false); setConfiguringPlatform(true); }}
                            >
                              {tr('配置', 'Configure')}
                            </Button>
                            <Button variant="ghost" size="sm" type="button" onClick={() => void probe(row)}>
                              {tr('测试', 'Test')}
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button variant="ghost" size="sm" type="button" onClick={() => void probe(row)}>
                              {tr('测试', 'Test')}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              type="button"
                              aria-label={tr('编辑', 'Edit')}
                              onClick={() => { setConfiguringPlatform(false); setCreatingConn(false); setEditingConn(row); }}
                            >
                              <Pencil size={12} />
                            </Button>
                            <Button
                              variant="dangerGhost"
                              size="sm"
                              type="button"
                              aria-label={tr('删除', 'Delete')}
                              onClick={() => void removeConnection(row)}
                            >
                              <Trash2 size={12} />
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="my-4 border-t border-border" />

      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="text-xs font-medium text-text">{tr('监控链接', 'Monitoring links')}</h3>
          <span className="text-[10.5px] text-text-faint">
            {tr(`已配置 ${links.length}`, `${links.length} configured`)}
            {' · '}{tr(`平台 ${stats.platform}`, `platform ${stats.platform}`)}
            {' · '}{tr(`外部 ${stats.external}`, `external ${stats.external}`)}
            {' · '}{tr(`连接健康 ${stats.healthy}`, `health ${stats.healthy}`)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label={tr('搜索 CI 类型', 'Search CI types')}
            placeholder={tr('搜索 CI 类型', 'Search CI types')}
            className="w-40"
          />
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={() => { setEditingLink(null); setCreatingLink(true); }}
          >
            <Plus size={12} />
            {tr('新建链接', 'New link')}
          </Button>
        </div>
      </div>

      {linksErr && (
        <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-[11px] text-red-500 dark:text-red-300">
          <div>{linksErr}</div>
          <Button variant="subtle" size="sm" type="button" className="mt-2" onClick={() => void loadLinks()}>
            {tr('重试', 'Retry')}
          </Button>
        </div>
      )}

      <div className="mt-2">
        {linksLoading && links.length === 0 ? (
          <p className="py-6 text-center text-[11px] text-text-faint">{tr('加载中…', 'Loading…')}</p>
        ) : links.length === 0 ? (
          <EmptyState
            icon={MonitorPlay}
            title={tr('尚未配置链接', 'No links yet')}
            hint={tr(
              '配置后，CMDB 实例详情会出现「监控」页签。',
              'Once configured, CMDB instance details gain a Monitoring tab.',
            )}
            action={
              <Button variant="primary" size="sm" type="button" onClick={() => { setEditingLink(null); setCreatingLink(true); }}>
                {tr('新建链接', 'New link')}
              </Button>
            }
          />
        ) : visibleLinks.length === 0 ? (
          <EmptyState
            icon={MonitorPlay}
            title={tr('没有匹配的 CI 类型', 'No matching CI types')}
            hint={tr('当前类型下没有与搜索词匹配的链接。', 'No link under this provider matches the search.')}
            action={
              <Button variant="subtle" size="sm" type="button" onClick={() => setSearch('')}>
                {tr('清除搜索', 'Clear search')}
              </Button>
            }
          />
        ) : (
          <div className="og-resource-table overflow-x-auto" data-variant="quiet">
            <table className="w-full min-w-[720px] text-xs">
              <thead>
                <tr>
                  <th>{tr('CI 类型', 'CI type')}</th>
                  <th>{tr('连接', 'Connection')}</th>
                  <th>{provider === 'grafana' ? tr('仪表盘 / 变量映射', 'Dashboard / variables') : tr('标签 / 匹配条件', 'Labels / matchers')}</th>
                  <th>{tr('状态', 'Status')}</th>
                  <th className="text-right">{tr('操作', 'Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleLinks.map((link) => (
                  <tr key={link.ci_type_id}>
                    <td>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-text">{typeName(link.ci_type_id)}</span>
                        <span className="text-[10.5px] text-text-faint">
                          {ciTypes.find((ciType) => ciType.id === link.ci_type_id)?.name ?? 'ci'} · #{link.ci_type_id}
                        </span>
                      </div>
                    </td>
                    <td>
                      {link.connection_id ? (
                        <Chip>{connectionName(link.connection_id)}</Chip>
                      ) : (
                        <Chip tone={platformEnabled ? 'info' : 'default'}>
                          {platformEnabled ? tr('平台内部', 'Platform') : tr('平台内部 · 已停用', 'Platform · disabled')}
                        </Chip>
                      )}
                    </td>
                    <td className="max-w-[24rem]">
                      {provider === 'grafana' ? (
                        <div className="min-w-0">
                          <div className="truncate font-mono text-[11px] text-text-muted" title={`${link.dashboard_uid ?? ''}${link.dashboard_slug ? ` / ${link.dashboard_slug}` : ''}`}>
                            {link.dashboard_uid}
                            {link.dashboard_slug ? ` / ${link.dashboard_slug}` : ''}
                          </div>
                          {link.var_mapping?.length ? (
                            <div className="mt-0.5 truncate text-[10.5px] text-text-faint">
                              {link.var_mapping.map((mapping) => `var-${mapping.var_name} ← ${mapping.ci_attribute}`).join(' · ')}
                            </div>
                          ) : (
                            <Chip tone="warning" dense className="mt-1">{tr('变量未映射', 'No variables')}</Chip>
                          )}
                        </div>
                      ) : (
                        <div className="min-w-0">
                          <div className="truncate font-mono text-[11px] text-text-muted">
                            {link.label_mapping?.length
                              ? link.label_mapping.map((mapping) => `${mapping.prom_label} ← ${mapping.ci_attribute}`).join(' · ')
                              : '—'}
                          </div>
                          {link.extra_matchers?.length ? (
                            <div className="mt-0.5 truncate text-[10.5px] text-text-faint">
                              {link.extra_matchers.map((matcher) => `${matcher.label}${matcherSymbol(matcher.op)}${matcher.value}`).join(' · ')}
                            </div>
                          ) : null}
                        </div>
                      )}
                    </td>
                    <td>
                      {link.enabled ? (
                        <Chip tone="success">{tr('启用', 'On')}</Chip>
                      ) : (
                        <Chip>{tr('停用', 'Off')}</Chip>
                      )}
                    </td>
                    <td className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          aria-label={tr('编辑', 'Edit')}
                          onClick={() => { setCreatingLink(false); setEditingLink(link); }}
                        >
                          <Pencil size={12} />
                        </Button>
                        <Button
                          variant="dangerGhost"
                          size="sm"
                          type="button"
                          aria-label={tr('删除', 'Delete')}
                          onClick={() => void removeLink(link)}
                        >
                          <Trash2 size={12} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="mt-3 text-[10.5px] text-text-faint">
        {tr(
          '链接决定 CMDB 实例详情是否出现「监控」页签；保存后立即生效。',
          'Links decide whether a CMDB instance detail shows the Monitoring tab; changes apply immediately.',
        )}
      </p>

      {(creatingConn || editingConn) && (
        <ConnectionDialog
          provider={provider}
          connection={editingConn}
          onClose={() => { setCreatingConn(false); setEditingConn(null); }}
          onSaved={async () => {
            setCreatingConn(false);
            setEditingConn(null);
            await loadConnections();
          }}
        />
      )}
      {configuringPlatform && (
        <PlatformConnectionDialog
          provider={provider}
          enabled={platformEnabled}
          onClose={() => setConfiguringPlatform(false)}
          onSaved={async () => {
            await loadConnections();
            setConfiguringPlatform(false);
          }}
        />
      )}
      {(creatingLink || editingLink) && (
        <LinkDialog
          provider={provider}
          link={editingLink}
          ciTypes={ciTypes}
          connections={connections}
          platformEnabled={platformEnabled}
          onClose={() => { setCreatingLink(false); setEditingLink(null); }}
          onSaved={async () => {
            setCreatingLink(false);
            setEditingLink(null);
            await loadLinks();
          }}
        />
      )}
      {dialog}
    </Card>
  );
}

function ConnectionHealthLabel({ row, health }: { row: MonitoringConnection; health?: ConnectionHealth }) {
  const { tr } = useI18n();
  if (!row.enabled) {
    return <span className="text-[10.5px] text-text-faint">{tr('未启用', 'Disabled')}</span>;
  }
  if (!health) {
    return <span className="text-[10.5px] text-text-faint">—</span>;
  }
  if (health.ok) {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-[10.5px] text-emerald-500">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
        {tr('正常', 'OK')}
      </span>
    );
  }
  return (
    <span title={health.error} className="inline-flex items-center gap-1 whitespace-nowrap text-[10.5px] text-amber-500">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
      {row.kind === 'internal' ? tr('需配置', 'Needs setup') : tr('异常', 'Failed')}
    </span>
  );
}

function matcherSymbol(op: string) {
  if (op === 'ne') return '!=';
  if (op === 'regex') return '=~';
  return '=';
}

function ConnectionDialog({
  provider,
  connection,
  onClose,
  onSaved,
}: {
  provider: Provider;
  connection: MonitoringConnection | null;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const { tr } = useI18n();
  const [name, setName] = useState(connection?.name ?? '');
  const [baseURL, setBaseURL] = useState(connection?.base_url ?? '');
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'basic'>(
    (connection?.auth_type as 'none' | 'bearer' | 'basic') ?? 'none',
  );
  const [token, setToken] = useState('');
  const [username, setUsername] = useState(connection?.username ?? '');
  const [password, setPassword] = useState('');
  const [tlsInsecure, setTLSInsecure] = useState(connection?.tls_insecure ?? false);
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  const [remark, setRemark] = useState(connection?.remark ?? '');
  const [credentialsTouched, setCredentialsTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const authHint = connection?.token_set || connection?.password_set
    ? tr('已设置，留空保持不变', 'Set; leave blank to keep')
    : undefined;

  function input(): MonitoringConnectionInput {
    const includeAuth = !connection || credentialsTouched;
    return {
      name: name.trim(),
      base_url: baseURL.trim(),
      auth_type: authType,
      auth_data: includeAuth && authType !== 'none' ? { token, username, password } : undefined,
      tls_insecure: tlsInsecure,
      enabled,
      remark: remark.trim(),
    };
  }

  async function probe() {
    setTesting(true);
    setErr(null);
    setOk(null);
    try {
      if (connection && !credentialsTouched) {
        await testSavedMonitoringConnection(connection.id);
      } else {
        await testMonitoringConnection(provider, input());
      }
      setOk(tr('连接测试通过', 'Connection test passed'));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      if (connection) await updateMonitoringConnection(provider, connection.id, input());
      else await createMonitoringConnection(provider, input());
      await onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={connection ? tr('编辑外部连接', 'Edit external connection') : tr('新建外部连接', 'New external connection')}
      size="lg"
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" type="button" onClick={() => void probe()} disabled={testing || saving}>
            {testing ? tr('测试中…', 'Testing…') : tr('测试连接', 'Test connection')}
          </Button>
          <Button variant="ghost" size="sm" type="button" onClick={onClose} disabled={saving}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => void save()} disabled={saving || testing}>
            {saving ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {err && <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">{err}</div>}
        {ok && <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">{ok}</div>}
        <div>
          <Label htmlFor="ciobs-conn-name">{tr('名称', 'Name')}</Label>
          <Input id="ciobs-conn-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="ciobs-conn-url">{tr('Base URL', 'Base URL')}</Label>
          <Input id="ciobs-conn-url" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} className="font-mono" placeholder={provider === 'grafana' ? 'https://grafana.example.com/grafana' : 'https://prometheus.example.com/prometheus'} />
        </div>
        <div>
          <Label>{tr('认证', 'Auth')}</Label>
          <Select
            label={tr('认证', 'Auth')}
            value={authType}
            onValueChange={(v) => setAuthType(v as 'none' | 'bearer' | 'basic')}
            options={[
              { value: 'none', label: 'None' },
              { value: 'bearer', label: 'Bearer' },
              { value: 'basic', label: 'Basic' },
            ]}
            className="w-full"
          />
        </div>
        {authType === 'bearer' && (
          <div>
            <Label htmlFor="ciobs-conn-token">{tr('Token', 'Token')}</Label>
            <Input id="ciobs-conn-token" type="password" placeholder={authHint} value={token} onChange={(e) => { setToken(e.target.value); setCredentialsTouched(true); }} autoComplete="new-password" />
          </div>
        )}
        {authType === 'basic' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="ciobs-conn-user">{tr('用户名', 'Username')}</Label>
              <Input id="ciobs-conn-user" value={username} onChange={(e) => { setUsername(e.target.value); setCredentialsTouched(true); }} autoComplete="off" />
            </div>
            <div>
              <Label htmlFor="ciobs-conn-pass">{tr('密码', 'Password')}</Label>
              <Input id="ciobs-conn-pass" type="password" placeholder={authHint} value={password} onChange={(e) => { setPassword(e.target.value); setCredentialsTouched(true); }} autoComplete="new-password" />
            </div>
          </div>
        )}
        <div>
          <Label htmlFor="ciobs-conn-remark">{tr('备注', 'Remark')}</Label>
          <Input id="ciobs-conn-remark" value={remark} onChange={(e) => setRemark(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-5 text-xs text-text-muted">
          <label className="flex items-center gap-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label={tr('启用', 'Enabled')} />
            {tr('启用', 'Enabled')}
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={tlsInsecure} onCheckedChange={setTLSInsecure} aria-label={tr('跳过 TLS 校验', 'Skip TLS verification')} />
            {tr('跳过 TLS 校验', 'Skip TLS verification')}
          </label>
        </div>
      </div>
    </Modal>
  );
}

function PlatformConnectionDialog({
  provider,
  enabled,
  onClose,
  onSaved,
}: {
  provider: Provider;
  enabled: boolean;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const { tr } = useI18n();
  const category = provider;
  const keys = provider === 'grafana' ? GRAFANA_KEYS : PROM_KEYS;
  const sensitive = provider === 'grafana' ? GRAFANA_SENSITIVE : PROM_SENSITIVE;
  const [server, setServer] = useState<PlatformForm>({});
  const [draft, setDraft] = useState<PlatformForm>({});
  const [enabledDraft, setEnabledDraft] = useState(enabled);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const response = await listSettings(category);
      const next: PlatformForm = {};
      for (const key of keys) next[key] = '';
      for (const item of response.items ?? []) {
        if (!(keys as readonly string[]).includes(item.key)) continue;
        if (!sensitive.has(item.key)) next[item.key] = item.value ?? '';
      }
      await Promise.all(
        (response.items ?? [])
          .filter((item) => sensitive.has(item.key) && (item.value ?? '') !== '')
          .map(async (item) => {
            try {
              next[item.key] = (await revealSetting(category, item.key)).value ?? '';
            } catch {
              /* leave it empty so a fresh credential can be pasted */
            }
          }),
      );
      setServer(next);
      setDraft(next);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [category, keys, sensitive]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = keys.some((key) => (draft[key] ?? '') !== (server[key] ?? ''));

  function update(key: string, value: string) {
    setOk(null);
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function probe() {
    setTesting(true);
    setErr(null);
    setOk(null);
    try {
      if (provider === 'grafana') {
        await testGrafanaConnection({
          root_url: draft.root_url ?? '',
          sa_token: draft.sa_token ?? '',
          api_key: draft.api_key ?? '',
          org_id: draft.org_id ?? '',
          tls_insecure: draft.tls_insecure === 'true',
        });
      } else {
        await testPromConnection({
          query_url: draft.query_url ?? '',
          remote_write_url: draft.remote_write_url ?? '',
          bearer_token: draft.bearer_token ?? '',
          basic_user: draft.basic_user ?? '',
          basic_password: draft.basic_password ?? '',
          tls_insecure: draft.tls_insecure === 'true',
        });
      }
      setOk(tr('连接测试通过', 'Connection test passed'));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      for (const key of keys) {
        if ((draft[key] ?? '') === (server[key] ?? '')) continue;
        await setSetting(category, key, draft[key] ?? '', sensitive.has(key));
      }
      if (enabledDraft !== enabled) {
        await setPlatformConnectionEnabled(provider, enabledDraft);
      }
      if (provider === 'grafana') invalidateGrafanaRootCache();
      await onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const title = provider === 'grafana' ? tr('配置平台 Grafana', 'Configure platform Grafana') : tr('配置平台 Prometheus', 'Configure platform Prometheus');

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <Link to="/settings/integrations" className="text-[11px] text-text-muted underline-offset-2 hover:text-text hover:underline">
            {tr('打开设置 → 集成', 'Open Settings → Integrations')}
          </Link>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" size="sm" type="button" onClick={() => void probe()} disabled={loading || testing || saving}>
              {testing ? tr('测试中…', 'Testing…') : tr('测试连接', 'Test connection')}
            </Button>
            <Button variant="ghost" size="sm" type="button" onClick={onClose} disabled={saving}>
              {tr('取消', 'Cancel')}
            </Button>
            <Button variant="primary" size="sm" type="button" onClick={() => void save()} disabled={loading || saving || testing}>
              {saving ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        {err && <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">{err}</div>}
        {ok && <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">{ok}</div>}
        <div className="rounded-md border border-indigo-500/30 bg-indigo-500/5 px-3 py-2 text-[11px] leading-relaxed text-text-muted">
          {tr(
            '与 设置 → 集成 共用同一份配置；保存后平台内所有使用该连接的监控链接立即生效。',
            'Shares one configuration with Settings → Integrations; saving affects every platform-backed monitoring link immediately.',
          )}
        </div>
        {loading ? (
          <p className="py-6 text-center text-xs text-text-faint">{tr('加载中…', 'Loading…')}</p>
        ) : provider === 'grafana' ? (
          <>
            <div>
              <Label htmlFor="ciobs-platform-root">{tr('Root URL', 'Root URL')}</Label>
              <Input
                id="ciobs-platform-root"
                value={draft.root_url ?? ''}
                onChange={(event) => update('root_url', event.target.value)}
                className="font-mono"
                placeholder="http://grafana:3000/grafana"
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="ciobs-platform-sa-token">{tr('Service account token', 'Service account token')}</Label>
                <Input
                  id="ciobs-platform-sa-token"
                  type="password"
                  value={draft.sa_token ?? ''}
                  onChange={(event) => update('sa_token', event.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <div>
                <Label htmlFor="ciobs-platform-api-key">{tr('API Key', 'API key')}</Label>
                <Input
                  id="ciobs-platform-api-key"
                  type="password"
                  value={draft.api_key ?? ''}
                  onChange={(event) => update('api_key', event.target.value)}
                  autoComplete="new-password"
                />
              </div>
            </div>
            <p className="text-[10.5px] text-text-faint">
              {tr('两种凭据二选一，Service account token 优先。', 'Use either credential; the service account token takes precedence.')}
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="ciobs-platform-org">{tr('Org ID', 'Org ID')}</Label>
                <Input
                  id="ciobs-platform-org"
                  value={draft.org_id ?? ''}
                  onChange={(event) => update('org_id', event.target.value)}
                />
              </div>
              <label className="flex items-end gap-2 pb-2 text-xs text-text-muted">
                <Switch
                  checked={draft.tls_insecure === 'true'}
                  onCheckedChange={(checked) => update('tls_insecure', checked ? 'true' : 'false')}
                  aria-label={tr('跳过 TLS 校验', 'Skip TLS verification')}
                />
                {tr('跳过 TLS 校验', 'Skip TLS verification')}
              </label>
            </div>
          </>
        ) : (
          <>
            <div>
              <Label htmlFor="ciobs-platform-query">{tr('Query URL', 'Query URL')}</Label>
              <Input
                id="ciobs-platform-query"
                value={draft.query_url ?? ''}
                onChange={(event) => update('query_url', event.target.value)}
                className="font-mono"
                placeholder="http://prometheus:9090/prometheus"
              />
            </div>
            <div>
              <Label htmlFor="ciobs-platform-bearer">{tr('Bearer token', 'Bearer token')}</Label>
              <Input
                id="ciobs-platform-bearer"
                type="password"
                value={draft.bearer_token ?? ''}
                onChange={(event) => update('bearer_token', event.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="ciobs-platform-basic-user">{tr('Basic 用户名', 'Basic username')}</Label>
                <Input
                  id="ciobs-platform-basic-user"
                  value={draft.basic_user ?? ''}
                  onChange={(event) => update('basic_user', event.target.value)}
                  autoComplete="off"
                />
              </div>
              <div>
                <Label htmlFor="ciobs-platform-basic-pass">{tr('Basic 密码', 'Basic password')}</Label>
                <Input
                  id="ciobs-platform-basic-pass"
                  type="password"
                  value={draft.basic_password ?? ''}
                  onChange={(event) => update('basic_password', event.target.value)}
                  autoComplete="new-password"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-text-muted">
              <Switch
                checked={draft.tls_insecure === 'true'}
                onCheckedChange={(checked) => update('tls_insecure', checked ? 'true' : 'false')}
                aria-label={tr('跳过 TLS 校验', 'Skip TLS verification')}
              />
              {tr('跳过 TLS 校验', 'Skip TLS verification')}
            </label>
          </>
        )}
        <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
          <div>
            <div className="text-xs text-text">{tr('启用该连接', 'Enable this connection')}</div>
            <div className="mt-0.5 text-[10.5px] text-text-faint">
              {tr('停用后，使用平台连接的监控链接不再展示仪表盘或活动告警。', 'When disabled, monitoring links backed by the platform connection show no dashboard or active alerts.')}
            </div>
          </div>
          <Switch
            checked={enabledDraft}
            onCheckedChange={setEnabledDraft}
            aria-label={tr('启用该连接', 'Enable this connection')}
          />
        </div>
        {dirty && (
          <p className="text-[10.5px] text-text-faint">
            {tr('保存只写入有改动的配置项。', 'Only changed settings are written on save.')}
          </p>
        )}
      </div>
    </Modal>
  );
}

function LinkDialog({
  provider,
  link,
  ciTypes,
  connections,
  platformEnabled,
  onClose,
  onSaved,
}: {
  provider: Provider;
  link: CILink | null;
  ciTypes: CIType[];
  connections: MonitoringConnection[];
  platformEnabled: boolean;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const { tr } = useI18n();
  const [ciTypeID, setCITypeID] = useState(String(link?.ci_type_id ?? ciTypes[0]?.id ?? ''));
  const [connectionID, setConnectionID] = useState(String(link?.connection_id ?? 0));
  const [enabled, setEnabled] = useState(link?.enabled ?? true);
  const [dashboardUID, setDashboardUID] = useState(link?.dashboard_uid ?? '');
  const [dashboardSlug, setDashboardSlug] = useState(link?.dashboard_slug ?? '');
  const [openMode, setOpenMode] = useState<'link' | 'embed'>(link?.open_mode ?? 'link');
  const [vars, setVars] = useState<VarMapping[]>(link?.var_mapping ?? [{ ci_attribute: '', var_name: '' }]);
  const [labels, setLabels] = useState<LabelMapping[]>(link?.label_mapping ?? [{ ci_attribute: '', prom_label: '' }]);
  const [matchers, setMatchers] = useState<Matcher[]>(link?.extra_matchers ?? []);
  const [ciID, setCIID] = useState('');
  const [preview, setPreview] = useState<CIPreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const input: CILinkInput = {
    enabled,
    connection_id: Number(connectionID) || 0,
    dashboard_uid: provider === 'grafana' ? dashboardUID : undefined,
    dashboard_slug: provider === 'grafana' ? dashboardSlug : undefined,
    open_mode: provider === 'grafana' ? openMode : undefined,
    var_mapping: provider === 'grafana' ? vars.filter((v) => v.ci_attribute && v.var_name) : undefined,
    label_mapping: provider === 'prometheus' ? labels.filter((l) => l.ci_attribute && l.prom_label) : undefined,
    extra_matchers: provider === 'prometheus' ? matchers.filter((m) => m.label && m.value) : undefined,
  };

  async function runPreview() {
    setErr(null);
    setPreview(null);
    try {
      setPreview(await previewCILink(provider, Number(ciID), input));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await saveCILink(provider, Number(ciTypeID), input);
      await onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={link ? tr('编辑监控链接', 'Edit monitoring link') : tr('新建监控链接', 'New monitoring link')}
      size="xl"
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" type="button" onClick={() => void runPreview()} disabled={!ciID}>
            {tr('预览命中', 'Preview')}
          </Button>
          <Button variant="ghost" size="sm" type="button" onClick={onClose} disabled={saving}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => void save()} disabled={saving}>
            {saving ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {err && <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">{err}</div>}
        {preview && (
          <div className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-text-muted">
            <div>{tr('命中：', 'Matched: ')}{preview.matched}{preview.reason ? ` · ${preview.reason}` : ''}</div>
            {preview.vars && Object.keys(preview.vars).length > 0 && (
              <div className="mt-1 font-mono text-[11px]">{Object.entries(preview.vars).map(([k, v]) => `var-${k}=${v}`).join(' ')}</div>
            )}
            {preview.labels && Object.keys(preview.labels).length > 0 && (
              <div className="mt-1 font-mono text-[11px]">{Object.entries(preview.labels).map(([k, v]) => `${k}="${v}"`).join(', ')}</div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Label>{tr('CI 类型', 'CI type')}</Label>
            {ciTypes.length > 0 ? (
              <Select
                label={tr('CI 类型', 'CI type')}
                value={ciTypeID}
                onValueChange={setCITypeID}
                options={ciTypes.map((ciType) => ({ value: String(ciType.id), label: ciType.alias || ciType.name }))}
                className="w-full"
                searchable
              />
            ) : (
              <Input aria-label={tr('CI 类型 ID', 'CI type ID')} type="number" value={ciTypeID} onChange={(e) => setCITypeID(e.target.value)} />
            )}
          </div>
          <div>
            <Label>{tr('连接', 'Connection')}</Label>
            <Select
              label={tr('连接', 'Connection')}
              value={connectionID}
              onValueChange={setConnectionID}
              options={[
                {
                  value: '0',
                  label: platformEnabled
                    ? tr('平台内部', 'Platform')
                    : tr('平台内部（已停用）', 'Platform (disabled)'),
                },
                ...connections
                  .filter((conn) => conn.kind === 'external' && conn.enabled)
                  .map((conn) => ({ value: String(conn.id), label: conn.name })),
              ]}
              className="w-full"
            />
          </div>
          <div>
            <Label htmlFor="ciobs-preview-ci">{tr('预览用 CI ID', 'CI ID for preview')}</Label>
            <Input id="ciobs-preview-ci" type="number" value={ciID} onChange={(e) => setCIID(e.target.value)} />
          </div>
          <label className="flex items-end gap-2 pb-2 text-xs text-text-muted">
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label={tr('启用', 'Enabled')} />
            {tr('启用', 'Enabled')}
          </label>
        </div>

        {connectionID === '0' && !platformEnabled && (
          <p className="text-[10.5px] text-amber-500">
            {tr(
              '平台连接已停用；请先在连接表中启用，或选择一个外部连接。',
              'The platform connection is disabled; enable it in the connection table or choose an external connection.',
            )}
          </p>
        )}

        {provider === 'grafana' ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <Label htmlFor="ciobs-uid">{tr('Dashboard UID', 'Dashboard UID')}</Label>
                <Input id="ciobs-uid" value={dashboardUID} onChange={(e) => setDashboardUID(e.target.value)} className="font-mono" />
              </div>
              <div>
                <Label htmlFor="ciobs-slug">{tr('Dashboard slug', 'Dashboard slug')}</Label>
                <Input id="ciobs-slug" value={dashboardSlug} onChange={(e) => setDashboardSlug(e.target.value)} className="font-mono" />
              </div>
              <div>
                <Label>{tr('打开方式', 'Open mode')}</Label>
                <Select label={tr('打开方式', 'Open mode')} value={openMode} onValueChange={(v) => setOpenMode(v as 'link' | 'embed')} options={OPEN_MODES} className="w-full" />
              </div>
            </div>
            <RowEditor
              title={tr('变量映射', 'Variable mappings')}
              rows={vars}
              onChange={setVars}
              fields={[
                { key: 'ci_attribute', placeholder: 'hostname' },
                { key: 'var_name', placeholder: 'device_id' },
              ]}
              empty={{ ci_attribute: '', var_name: '' }}
            />
          </>
        ) : (
          <>
            <RowEditor
              title={tr('标签映射', 'Label mappings')}
              rows={labels}
              onChange={setLabels}
              fields={[
                { key: 'ci_attribute', placeholder: 'hostname' },
                { key: 'prom_label', placeholder: 'host' },
              ]}
              empty={{ ci_attribute: '', prom_label: '' }}
            />
            <MatcherEditor rows={matchers} onChange={setMatchers} />
          </>
        )}
      </div>
    </Modal>
  );
}

function RowEditor<T extends Record<string, string>>({
  title,
  rows,
  onChange,
  fields,
  empty,
}: {
  title: string;
  rows: T[];
  onChange(rows: T[]): void;
  fields: { key: keyof T & string; placeholder: string }[];
  empty: T;
}) {
  const { tr } = useI18n();
  return (
    <div className="rounded-lg border border-zinc-800 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-text">{title}</span>
        <Button variant="subtle" size="sm" type="button" onClick={() => onChange([...rows, empty])}>
          <Plus size={12} /> {tr('添加行', 'Add row')}
        </Button>
      </div>
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            {fields.map((field) => (
              <Input
                key={field.key}
                aria-label={field.placeholder}
                placeholder={field.placeholder}
                value={row[field.key] ?? ''}
                onChange={(e) => onChange(rows.map((item, i) => (i === index ? { ...item, [field.key]: e.target.value } : item)))}
                className="font-mono"
              />
            ))}
            <Button variant="dangerGhost" size="sm" type="button" aria-label={tr('删除行', 'Remove row')} onClick={() => onChange(rows.filter((_, i) => i !== index))}>
              <Trash2 size={12} />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function MatcherEditor({ rows, onChange }: { rows: Matcher[]; onChange(rows: Matcher[]): void }) {
  const { tr } = useI18n();
  return (
    <div className="rounded-lg border border-zinc-800 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-text">{tr('额外匹配条件', 'Extra matchers')}</span>
        <Button variant="subtle" size="sm" type="button" onClick={() => onChange([...rows, { label: '', op: 'eq', value: '' }])}>
          <Plus size={12} /> {tr('添加条件', 'Add matcher')}
        </Button>
      </div>
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={index} className="grid grid-cols-12 gap-2">
            <div className="col-span-4">
              <Input aria-label={tr('标签', 'Label')} placeholder="severity" value={row.label} onChange={(e) => onChange(rows.map((item, i) => (i === index ? { ...item, label: e.target.value } : item)))} className="font-mono" />
            </div>
            <div className="col-span-3">
              <Select aria-label={tr('操作符', 'Operator')} value={row.op} onValueChange={(v) => onChange(rows.map((item, i) => (i === index ? { ...item, op: v } : item)))} options={MATCHER_OPS} className="w-full" />
            </div>
            <div className="col-span-4">
              <Input aria-label={tr('值', 'Value')} placeholder="critical" value={row.value} onChange={(e) => onChange(rows.map((item, i) => (i === index ? { ...item, value: e.target.value } : item)))} />
            </div>
            <div className="col-span-1 flex items-center">
              <Button variant="dangerGhost" size="sm" type="button" aria-label={tr('删除条件', 'Remove matcher')} onClick={() => onChange(rows.filter((_, i) => i !== index))}>
                <Trash2 size={12} />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
