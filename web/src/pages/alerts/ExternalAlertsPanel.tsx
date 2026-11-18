import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ExternalLink, RefreshCw, Siren } from 'lucide-react';

import {
  Button,
  EmptyStateCard,
  Input,
  PageHeader,
  PaginationFooter,
  Select,
  Chip,
} from '@/components/ui';
import { Modal } from '@/components/Modal';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/format';
import { useI18n } from '@/i18n/locale';
import { usePermissions } from '@/store/me';
import { ApiError } from '@/api/client';
import {
  listExternalAlerts,
  type ExternalItem,
  type ExternalList,
} from '@/api/federation';

const PAGE_SIZE = 50;

const DAY_OPTIONS = [
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
];

const STATUS_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'firing', label: 'Firing' },
  { value: 'resolved', label: 'Resolved' },
];

const SEVERITY_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' },
];

type Field = { key: string; path: string; zh: string; en: string };

const COLUMNS: Field[] = [
  { key: 'severity', path: 'alert.labels.severity', zh: '级别', en: 'Severity' },
  { key: 'status', path: 'status', zh: '状态', en: 'Status' },
  { key: 'alertname', path: 'alertname', zh: '告警', en: 'Alert' },
  { key: 'summary', path: 'annotations.summary', zh: '摘要', en: 'Summary' },
  { key: 'host', path: 'alert.labels.host', zh: '主机', en: 'Host' },
  { key: 'fired', path: 'created_at', zh: '触发', en: 'Fired' },
];

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

export function ExternalAlertsPanel() {
  const { tr } = useI18n();
  const { isAdmin } = usePermissions();
  const [items, setItems] = useState<ExternalItem[]>([]);
  const [total, setTotal] = useState(0);
  const [configured, setConfigured] = useState(true);
  const [reason, setReason] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [days, setDays] = useState('7');
  const [status, setStatus] = useState('');
  const [severity, setSeverity] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<ExternalItem | null>(null);
  // A late response must not overwrite a newer filter/page result.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const res: ExternalList = await listExternalAlerts({
        days: Number(days),
        status: status || undefined,
        severity: severity || undefined,
        keyword: keyword.trim() || undefined,
        page: page + 1,
        page_size: PAGE_SIZE,
      });
      if (seq !== requestSeq.current) return;
      setItems(res.items ?? []);
      setTotal(res.total ?? 0);
      setConfigured(res.configured);
      setReason(res.reason);
      setErr(null);
    } catch (e) {
      if (seq !== requestSeq.current || (e as Error).name === 'AbortError') return;
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [days, status, severity, keyword, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = Boolean(status || severity || keyword.trim());

  return (
    <main className="anim-fade flex flex-1 flex-col overflow-hidden">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Siren size={14} /> {tr('外部告警', 'External alerts')}
          </span>
        }
        subtitle={tr(
          '只读 · 数据来自已接入的外部告警源',
          'Read-only · sourced from a configured external alert source',
        )}
        actions={
          <div className="flex gap-2">
            {isAdmin && (
              <Link
                to="/settings/federation"
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                <ExternalLink size={12} /> {tr('数据源设置', 'Source settings')}
              </Link>
            )}
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
              options={STATUS_OPTIONS.map((o) => ({
                ...o,
                label: o.value ? o.label : tr('全部', 'All'),
              }))}
              className="w-36"
            />
            <Select
              label={tr('级别', 'Severity')}
              value={severity}
              onValueChange={(next) => {
                setPage(0);
                setSeverity(next);
              }}
              options={SEVERITY_OPTIONS.map((o) => ({
                ...o,
                label: o.value ? o.label : tr('全部', 'All'),
              }))}
              className="w-36"
            />
            <Input
              type="search"
              aria-label={tr('搜索告警', 'Search alerts')}
              placeholder={tr('告警名称', 'Alert name')}
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

      <div className="flex-1 overflow-y-auto">
        {err && (
          <div className="m-6 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm text-red-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div>
              <div>{tr('加载外部告警失败：', 'Could not load external alerts: ')}{err}</div>
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
            title={tr('尚未接入外部告警源', 'No external alert source configured')}
            hint={
              reason && reason !== 'not_configured'
                ? tr(`原因：${reason}`, `Reason: ${reason}`)
                : isAdmin
                  ? tr('在设置 → 外部数据源中添加连接与映射', 'Add a connection and mappings in Settings → Federated sources')
                  : tr('请联系管理员配置外部告警源', 'Ask an admin to configure an external alert source')
            }
            action={
              isAdmin ? (
                <Link
                  to="/settings/federation"
                  className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500"
                >
                  {tr('去配置', 'Configure')}
                </Link>
              ) : undefined
            }
          />
        )}

        {!err && loading && (
          <div className="flex h-40 items-center justify-center text-sm text-zinc-500">
            {tr('加载中…', 'Loading…')}
          </div>
        )}

        {!err && !loading && configured && items.length === 0 && (
          <EmptyStateCard
            className="mx-6 my-4"
            icon={Siren}
            title={tr('没有匹配的外部告警', 'No external alerts match')}
            hint={tr('调整时间范围或筛选条件后重试', 'Adjust the time range or filters')}
            action={
              filtered ? (
                <Button
                  onClick={() => {
                    setPage(0);
                    setStatus('');
                    setSeverity('');
                    setKeyword('');
                  }}
                >
                  {tr('清除筛选', 'Clear filters')}
                </Button>
              ) : undefined
            }
          />
        )}

        {!err && !loading && configured && items.length > 0 && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-zinc-950 text-left text-[11px] uppercase tracking-wider text-zinc-500">
              <tr className="border-b border-zinc-800">
                {COLUMNS.map((column) => (
                  <th key={column.key} className="px-4 py-2 font-medium">
                    {tr(column.zh, column.en)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => {
                const severityValue = text(readPath(item, 'alert.labels.severity'));
                return (
                  <tr
                    key={String(readPath(item, '_id') ?? index)}
                    className="cursor-pointer border-b border-zinc-900/70 hover:bg-zinc-900/40"
                    onClick={() => setDetail(item)}
                  >
                    {COLUMNS.map((column) => {
                      const value = text(readPath(item, column.path));
                      if (column.key === 'severity') {
                        return (
                          <td key={column.key} className="px-4 py-2">
                            <Chip tone={severityTone(severityValue)}>{value}</Chip>
                          </td>
                        );
                      }
                      if (column.key === 'fired') {
                        return (
                          <td key={column.key} className="px-4 py-2 text-zinc-400">
                            {value === '—' ? value : relativeTime(value)}
                          </td>
                        );
                      }
                      return (
                        <td key={column.key} className="max-w-[28rem] truncate px-4 py-2">
                          {value}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <PaginationFooter
          page={page}
          pageSize={PAGE_SIZE}
          shown={items.length}
          total={total}
          loading={loading}
          matchLabel={filtered}
          className="px-6"
          onPageChange={setPage}
        />
      </div>

      {detail && (
        <Modal
          open
          onClose={() => setDetail(null)}
          title={tr('外部告警详情', 'External alert detail')}
          size="xl"
        >
          <div className="space-y-3">
            <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
              {COLUMNS.map((column) => (
                <div key={column.key} className="min-w-0">
                  <dt className="text-zinc-500">{tr(column.zh, column.en)}</dt>
                  <dd className="break-words text-zinc-200">{text(readPath(detail, column.path))}</dd>
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
    </main>
  );
}
