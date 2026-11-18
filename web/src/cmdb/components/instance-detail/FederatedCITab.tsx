import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, RefreshCw, Siren, Ticket } from 'lucide-react';

import { Button, Chip, EmptyState } from '@/components/ui';
import { relativeTime } from '@/lib/format';
import { useI18n } from '@/i18n/locale';
import { ApiError } from '@/api/client';
import { listCIItems, type CIItems, type ExternalItem } from '@/api/federation';

type Kind = 'alerts' | 'tickets';

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

function tone(value: string): 'danger' | 'success' | 'warning' | 'info' | undefined {
  switch (value.toLowerCase()) {
    case 'firing':
    case 'error':
    case 'critical':
    case 'disaster':
      return 'danger';
    case 'resolved':
    case 'completed':
      return 'success';
    case 'running':
    case 'acknowledged':
      return 'warning';
    case 'info':
    case 'warning':
      return 'info';
    default:
      return undefined;
  }
}

export function FederatedCITab({ kind, ciID }: { kind: Kind; ciID: number }) {
  const { tr } = useI18n();
  const [data, setData] = useState<CIItems | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listCIItems(kind, ciID, kind === 'alerts' ? 7 : 30);
      setData(res);
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [kind, ciID]);

  useEffect(() => {
    void load();
  }, [load]);

  const fullPage = kind === 'alerts' ? '/alerts?source=external' : '/tickets';
  const fullLabel = kind === 'alerts' ? tr('打开外部告警', 'Open external alerts') : tr('打开事件中心', 'Open event center');

  if (loading) {
    return <p className="py-6 text-center text-xs text-text-faint">{tr('加载中…', 'Loading…')}</p>;
  }
  if (err) {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
        <div>{tr('加载失败：', 'Load failed: ')}{err}</div>
        <Button variant="subtle" size="sm" type="button" className="mt-2" onClick={() => void load()}>
          {tr('重试', 'Retry')}
        </Button>
      </div>
    );
  }
  if (!data || !data.configured) {
    return (
      <EmptyState
        icon={kind === 'alerts' ? Siren : Ticket}
        title={tr('CMDB 不可用', 'CMDB unavailable')}
        hint={tr('无法解析该 CI 的映射；请确认 CMDB 服务已部署。', 'The CI mapping cannot be resolved; confirm the CMDB service is deployed.')}
      />
    );
  }
  if (!data.has_mapping) {
    return (
      <EmptyState
        icon={kind === 'alerts' ? Siren : Ticket}
        title={tr('该模型未配置外部源映射', 'No external mapping for this model')}
        hint={tr('管理员可在设置 → 外部数据源中配置 CI 映射。', 'An admin can configure a CI mapping in Settings → Federated sources.')}
      />
    );
  }
  if (data.items.length === 0) {
    const reason = data.reason;
    return (
      <EmptyState
        icon={kind === 'alerts' ? Siren : Ticket}
        title={
          reason === 'no_ci_value'
            ? tr('该 CI 没有可匹配的映射属性值', 'This CI has no value for the mapped attribute')
            : reason === 'connection_unreachable'
              ? tr('上游暂不可达', 'The upstream is unreachable')
              : tr('没有关联记录', 'No related records')
        }
        hint={
          reason === 'no_ci_value'
            ? tr('请检查映射使用的 CI 属性是否已填写。', 'Check whether the CI attribute used by the mapping is filled in.')
            : reason === 'connection_unreachable'
              ? tr('请检查连接配置与上游状态后重试。', 'Check the connection configuration and upstream, then retry.')
              : tr('该 CI 在当前时间窗内没有关联记录。', 'This CI has no related records in the current window.')
        }
      />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[11px] text-text-faint">
        <span>{tr(`共 ${data.total} 条`, `${data.total} record(s)`)}</span>
        <div className="flex gap-1">
          <Button variant="subtle" size="sm" type="button" onClick={() => void load()}>
            <RefreshCw size={12} /> {tr('刷新', 'Refresh')}
          </Button>
          <Link
            to={fullPage}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
          >
            <ExternalLink size={11} /> {fullLabel}
          </Link>
        </div>
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {data.items.map((item, index) => {
          const titlePath = kind === 'alerts' ? 'alertname' : 'form_data.title';
          const summaryPath = kind === 'alerts' ? 'annotations.summary' : 'form_data.priority';
          const statusPath = kind === 'alerts' ? 'status' : 'form_data.instanceStatus';
          const status = text(readPath(item, statusPath));
          return (
            <li key={String(readPath(item, '_id') ?? index)} className="flex items-start justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-text">{text(readPath(item, titlePath))}</div>
                <div className="mt-0.5 truncate text-[11px] text-text-muted">{text(readPath(item, summaryPath))}</div>
                <div className="mt-0.5 text-[11px] text-text-faint">
                  {relativeTime(text(readPath(item, 'created_at')))}
                </div>
              </div>
              <Chip tone={tone(status)}>{status}</Chip>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
