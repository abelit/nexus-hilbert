import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Download,
  ExternalLink,
  RefreshCw,
  Siren,
} from 'lucide-react';

import {
  Button,
  Chip,
  EmptyStateCard,
  Input,
  PageHeader,
  PaginationFooter,
  Select,
} from '@/components/ui';
import { Modal } from '@/components/Modal';
import { useDialogs } from '@/components/ui/useDialogs';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/format';
import { useI18n } from '@/i18n/locale';
import { usePermissions } from '@/store/me';
import { ApiError } from '@/api/client';
import {
  getColumns,
  listFilterSummaries,
  type DisplayColumn,
  type ExternalItem,
  type ExternalList,
  type ExternalListParams,
  type FederationKind,
  type FederationStats,
  type FilterSummary,
} from '@/api/federation';

const PAGE_SIZE = 50;
const EXPORT_PAGE_SIZE = 500;
const EXPORT_MAX_ROWS = 5000;

const DAY_OPTIONS = [
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
];

export type FederatedField = {
  key: string;
  path: string;
  zh: string;
  en: string;
  render: 'text' | 'time' | 'badge' | 'link';
};

export type FederatedApi = {
  list(params: ExternalListParams, signal?: AbortSignal): Promise<ExternalList>;
  mine(params: ExternalListParams, scope: string, signal?: AbortSignal): Promise<ExternalList>;
  stats(params: ExternalListParams, scope?: string): Promise<FederationStats>;
};

export type FederatedListPanelProps = {
  kind: FederationKind;
  titleZh: string;
  titleEn: string;
  subtitleZh: string;
  subtitleEn: string;
  nounZh: string;
  nounEn: string;
  defaultFields: FederatedField[];
  builtinPaths: Record<string, { path: string; zh: string; en: string }>;
  statusOptions: { value: string; label: string }[];
  severityOptions?: { value: string; label: string }[];
  settingsPath: string;
  defaultDays?: number;
  api: FederatedApi;
};

function fieldFromColumn(
  column: DisplayColumn,
  builtinPaths: FederatedListPanelProps['builtinPaths'],
  fallback: FederatedField[],
): FederatedField {
  const builtin = builtinPaths[column.key];
  const preset = fallback.find((field) => field.key === column.key);
  return {
    key: column.key,
    path: column.path || builtin?.path || preset?.path || column.key,
    zh: column.label_zh || builtin?.zh || preset?.zh || column.key,
    en: column.label_en || builtin?.en || preset?.en || column.key,
    render: column.render ?? preset?.render ?? 'text',
  };
}

function readPath(item: ExternalItem, path: string): unknown {
  let current: unknown = item;
  for (const segment of path.split('.')) {
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') return undefined;
    if (current && typeof current === 'object' && segment in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function text(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function severityTone(value: string): 'danger' | 'warning' | 'info' | undefined {
  switch (value.toLowerCase()) {
    case 'critical':
    case 'disaster':
      return 'danger';
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
    default:
      return undefined;
  }
}

function statusTone(value: string): 'success' | 'danger' | 'warning' | undefined {
  switch (value.toLowerCase()) {
    case 'firing':
    case 'error':
      return 'danger';
    case 'resolved':
    case 'completed':
      return 'success';
    case 'running':
    case 'acknowledged':
      return 'warning';
    default:
      return undefined;
  }
}

function safeLink(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function download(name: string, mime: string, content: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function FederatedListPanel({
  kind,
  titleZh,
  titleEn,
  subtitleZh,
  subtitleEn,
  nounZh,
  nounEn,
  defaultFields,
  builtinPaths,
  statusOptions,
  severityOptions,
  settingsPath,
  defaultDays = 7,
  api,
}: FederatedListPanelProps) {
  const { tr } = useI18n();
  const { isAdmin } = usePermissions();
  const { alertAction, dialog } = useDialogs();
  const [items, setItems] = useState<ExternalItem[]>([]);
  const [total, setTotal] = useState(0);
  const [configured, setConfigured] = useState(true);
  const [reason, setReason] = useState<string | undefined>();
  const [identity, setIdentity] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [days, setDays] = useState(String(defaultDays));
  const [status, setStatus] = useState('');
  const [severity, setSeverity] = useState('');
  const [keyword, setKeyword] = useState('');
  const [scope, setScope] = useState('');
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<ExternalItem | null>(null);
  const [summaries, setSummaries] = useState<FilterSummary[]>([]);
  const [columns, setColumns] = useState<DisplayColumn[]>([]);
  const [stats, setStats] = useState<FederationStats | null>(null);
  const requestSeq = useRef(0);

  // Metadata is best-effort: a failed columns/summaries fetch must not hide
  // the list behind an error page.
  useEffect(() => {
    let live = true;
    void Promise.all([
      listFilterSummaries(kind).catch(() => ({ items: [] as FilterSummary[], total: 0 })),
      getColumns(kind).catch(() => ({ items: [] as DisplayColumn[], total: 0 })),
    ]).then(([scopeRows, columnRows]) => {
      if (!live) return;
      setSummaries(scopeRows.items ?? []);
      setColumns(columnRows.items ?? []);
    });
    return () => {
      live = false;
    };
  }, [kind]);

  const fields = useMemo<FederatedField[]>(() => {
    const visible = columns.filter((column) => column.visible);
    return visible.length > 0
      ? visible.map((column) => fieldFromColumn(column, builtinPaths, defaultFields))
      : defaultFields;
  }, [columns, builtinPaths, defaultFields]);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    const params = {
      days: Number(days),
      status: status || undefined,
      severity: severity || undefined,
      keyword: keyword.trim() || undefined,
      page: page + 1,
      page_size: PAGE_SIZE,
    };
    try {
      const [res, stat] = await Promise.all([
        scope
          ? api.mine(params, scope)
          : api.list(params),
        api.stats({ days: Number(days) }, scope || undefined).catch(() => null),
      ]);
      if (seq !== requestSeq.current) return;
      setItems(res.items ?? []);
      setTotal(res.total ?? 0);
      setConfigured(res.configured);
      setReason(res.reason);
      setIdentity(res.identity);
      setStats(stat);
      setErr(null);
    } catch (e) {
      if (seq !== requestSeq.current || (e as Error).name === 'AbortError') return;
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [days, status, severity, keyword, page, scope, api]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = Boolean(status || severity || keyword.trim());
  const scopeSummary = summaries.find((summary) => summary.key === scope);
  const unbound = identity === 'unbound';

  async function exportRows(format: 'csv' | 'json') {
    const rows: ExternalItem[] = [];
    for (let pageIndex = 1; rows.length < EXPORT_MAX_ROWS; pageIndex += 1) {
      const params = {
        days: Number(days),
        status: status || undefined,
        severity: severity || undefined,
        keyword: keyword.trim() || undefined,
        page: pageIndex,
        page_size: EXPORT_PAGE_SIZE,
      };
      const res = scope
        ? await api.mine(params, scope)
        : await api.list(params);
      const chunk = res.items ?? [];
      rows.push(...chunk);
      if (chunk.length < EXPORT_PAGE_SIZE || rows.length >= res.total) break;
    }
    const capped = rows.slice(0, EXPORT_MAX_ROWS);
    if (rows.length >= EXPORT_MAX_ROWS) {
      await alertAction(tr(
        `导出达到 ${EXPORT_MAX_ROWS} 行上限，结果已截断。`,
        `Export reached the ${EXPORT_MAX_ROWS}-row cap and was truncated.`,
      ));
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    if (format === 'json') {
      download(`external-alerts-${stamp}.json`, 'application/json', JSON.stringify(capped, null, 2));
      return;
    }
    const header = fields.map((field) => csvCell(tr(field.zh, field.en))).join(',');
    const lines = capped.map((item) => fields.map((field) => csvCell(text(readPath(item, field.path)))).join(','));
    download(`external-alerts-${stamp}.csv`, 'text/csv;charset=utf-8', '﻿' + [header, ...lines].join('\n'));
  }

  return (
    <main className="anim-fade flex flex-1 flex-col overflow-hidden">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Siren size={14} /> {tr(titleZh, titleEn)}
          </span>
        }
        subtitle={tr(subtitleZh, subtitleEn)}
        actions={
          <div className="flex flex-wrap gap-2">
            {isAdmin && (
              <Link
                to={settingsPath}
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                <ExternalLink size={12} /> {tr('数据源设置', 'Source settings')}
              </Link>
            )}
            <Button variant="outline" size="sm" type="button" onClick={() => void exportRows('csv')} disabled={loading || items.length === 0}>
              <Download size={12} /> CSV
            </Button>
            <Button variant="outline" size="sm" type="button" onClick={() => void exportRows('json')} disabled={loading || items.length === 0}>
              <Download size={12} /> JSON
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5"
            >
              <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
              {tr('刷新', 'Refresh')}
            </Button>
          </div>
        }
        extra={
          <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
            <Select
              label={tr('范围', 'Scope')}
              value={scope}
              onValueChange={(next) => {
                setPage(0);
                setScope(next);
              }}
              options={[
                { value: '', label: tr('全部', 'All') },
                ...summaries.map((summary) => ({ value: summary.key, label: summary.name })),
              ]}
              className="w-40"
            />
            <Select
              label={tr('时间范围', 'Time range')}
              value={days}
              onValueChange={(next) => {
                setPage(0);
                setDays(next);
              }}
              options={DAY_OPTIONS}
              className="w-28"
            />
            <Select
              label={tr('状态', 'Status')}
              value={status}
              onValueChange={(next) => {
                setPage(0);
                setStatus(next);
              }}
              options={statusOptions.map((o) => ({
                ...o,
                label: o.value ? o.label : tr('全部', 'All'),
              }))}
              className="w-36"
            />
            {severityOptions && severityOptions.length > 0 && (
              <Select
                label={tr('级别', 'Severity')}
                value={severity}
                onValueChange={(next) => {
                  setPage(0);
                  setSeverity(next);
                }}
                options={severityOptions.map((o) => ({
                  ...o,
                  label: o.value ? o.label : tr('全部', 'All'),
                }))}
                className="w-36"
              />
            )}
            <Input
              type="search"
              aria-label={tr(`搜索${nounZh}`, `Search ${nounEn}`)}
              placeholder={tr(nounZh, nounEn)}
              value={keyword}
              onChange={(event) => {
                setPage(0);
                setKeyword(event.target.value);
              }}
              className="w-48"
            />
          </div>
        }
      />

      {stats?.configured && (
        <div className="mx-6 mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-1.5 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3.5 py-2 text-xs text-zinc-400">
          <Stat label={tr('总数', 'Total')} value={stats.total} />
          {Object.entries(stats.by_status ?? {}).map(([key, value]) => (
            <Stat key={key} label={key} value={value} />
          ))}
          {severityOptions && severityOptions.length > 0 &&
            Object.entries(stats.by_severity ?? {}).map(([key, value]) => (
              <Stat key={key} label={key} value={value} />
            ))}
          <span className="ms-auto text-text-faint">
            {tr(`窗口 ${stats.window_days} 天`, `Window ${stats.window_days}d`)}
          </span>
        </div>
      )}

      {scopeSummary?.identity_required && (
        <p className="mx-6 mt-2 text-[11px] text-text-faint">
          {tr('该范围按当前账号的身份字段筛选。', 'This scope filters by the current account identity.')}
        </p>
      )}

      <div className="flex-1 overflow-y-auto">
        {err && (
          <div className="m-6 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm text-red-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div>
              <div>{tr(`加载${nounZh}失败：`, `Could not load ${nounEn}: `)}{err}</div>
              <Button variant="subtle" size="sm" type="button" className="mt-2" onClick={() => void load()}>
                {tr('重试', 'Retry')}
              </Button>
            </div>
          </div>
        )}

        {!err && !loading && !configured && (
          <EmptyStateCard
            className="mx-6 my-4"
            icon={Siren}
            title={tr(`尚未接入${nounZh}源`, `No ${nounEn} source configured`)}
            hint={
              reason && reason !== 'not_configured'
                ? tr(`原因：${reason}`, `Reason: ${reason}`)
                : isAdmin
                  ? tr('在设置 → 外部数据源中添加连接与映射', 'Add a connection and mappings in Settings → Federated sources')
                  : tr(`请联系管理员配置${nounZh}源`, `Ask an admin to configure a ${nounEn} source`)
            }
            action={
              isAdmin ? (
                <Link
                  to={settingsPath}
                  className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500"
                >
                  {tr('去配置', 'Configure')}
                </Link>
              ) : undefined
            }
          />
        )}

        {!err && !loading && unbound && (
          <EmptyStateCard
            className="mx-6 my-4"
            icon={Siren}
            title={tr('你的账号未匹配该筛选条件', 'Your account does not match this filter')}
            hint={tr(
              '该范围使用了身份字段（如邮箱或手机号），但当前账号没有可匹配的值。',
              'This scope uses an identity field (email or phone), but the current account has no matching value.',
            )}
            action={
              <Button variant="outline" size="sm" onClick={() => setScope('')}>
                {tr('查看全部', 'View all')}
              </Button>
            }
          />
        )}

        {!err && loading && (
          <div className="flex h-40 items-center justify-center text-sm text-zinc-500">
            {tr('加载中…', 'Loading…')}
          </div>
        )}

        {!err && !loading && configured && !unbound && items.length === 0 && (
          <EmptyStateCard
            className="mx-6 my-4"
            icon={Siren}
            title={tr(`没有匹配的${nounZh}`, `No ${nounEn} match`)}
            hint={tr('调整时间范围或筛选条件后重试', 'Adjust the time range or filters')}
            action={
              filtered || scope ? (
                <Button
                  onClick={() => {
                    setPage(0);
                    setStatus('');
                    setSeverity('');
                    setKeyword('');
                    setScope('');
                  }}
                >
                  {tr('清除筛选', 'Clear filters')}
                </Button>
              ) : undefined
            }
          />
        )}

        {!err && !loading && configured && !unbound && items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-xs">
              <thead className="sticky top-0 bg-zinc-950 text-left text-[11px] uppercase tracking-wider text-zinc-500">
                <tr className="border-b border-zinc-800">
                  {fields.map((field) => (
                    <th key={field.key} className="px-4 py-2 font-medium">
                      {tr(field.zh, field.en)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => (
                  <tr
                    key={String(readPath(item, '_id') ?? index)}
                    role="button"
                    tabIndex={0}
                    aria-label={tr('查看告警详情', 'View alert detail')}
                    className="cursor-pointer border-b border-zinc-900/70 hover:bg-zinc-900/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500"
                    onClick={() => setDetail(item)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setDetail(item);
                      }
                    }}
                  >
                    {fields.map((field) => {
                      const value = text(readPath(item, field.path));
                      if (field.render === 'badge') {
                        const tone = field.key === 'status' ? statusTone(value) : severityTone(value);
                        return (
                          <td key={field.key} className="px-4 py-2">
                            <Chip tone={tone}>{value}</Chip>
                          </td>
                        );
                      }
                      if (field.render === 'time') {
                        return (
                          <td key={field.key} className="px-4 py-2 text-zinc-400">
                            {value === '—' ? value : relativeTime(value)}
                          </td>
                        );
                      }
                      if (field.render === 'link' && safeLink(value)) {
                        return (
                          <td key={field.key} className="max-w-[28rem] truncate px-4 py-2">
                            <a
                              href={value}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-indigo-400 hover:underline"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {value}
                            </a>
                          </td>
                        );
                      }
                      return (
                        <td key={field.key} className="max-w-[28rem] truncate px-4 py-2">
                          {value}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <PaginationFooter
          page={page}
          pageSize={PAGE_SIZE}
          shown={items.length}
          total={total}
          loading={loading}
          matchLabel={filtered || Boolean(scope)}
          className="px-6"
          onPageChange={setPage}
        />
      </div>

      {detail && (
        <Modal
          open
          onClose={() => setDetail(null)}
          title={tr(`${nounZh}详情`, `${nounEn} detail`)}
          size="xl"
        >
          <div className="space-y-3">
            <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
              {fields.map((field) => (
                <div key={field.key} className="min-w-0">
                  <dt className="text-zinc-500">{tr(field.zh, field.en)}</dt>
                  <dd className="break-words text-zinc-200">{text(readPath(detail, field.path))}</dd>
                </div>
              ))}
            </dl>
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wider text-zinc-500">
                {tr('原始数据', 'Raw data')}
              </div>
              <pre className="max-h-80 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 text-[11px] leading-relaxed text-zinc-300">
                {JSON.stringify(detail, null, 2)}
              </pre>
            </div>
          </div>
        </Modal>
      )}
      {dialog}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-text-muted">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-text">
        {value === null || value === undefined ? '—' : value}
      </span>
    </span>
  );
}
