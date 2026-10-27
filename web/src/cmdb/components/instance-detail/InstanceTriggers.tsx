import { useCallback, useEffect, useState } from 'react';

import { Chip } from '@/components/ui/Chip';
import { PaginationFooter } from '@/components/ui/PaginationFooter';
import { useI18n } from '@/i18n/locale';
import { fullDateTime } from '@/lib/format';

import { describeError } from '../../api/http';
import { listCITriggerHistory, type TriggerHistoryItem } from '../../api/history';
import { DataTable, type Column } from '../DataTable';

const PAGE_SIZE = 20;

export function InstanceTriggers({
  ciID,
  userLabel,
}: {
  ciID: number;
  userLabel(uid?: number): string;
}) {
  const { tr } = useI18n();
  const [rows, setRows] = useState<TriggerHistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const got = await listCITriggerHistory(ciID, page + 1, PAGE_SIZE);
      setRows(got.items ?? []);
      setTotal(got.total ?? 0);
    } catch (err) {
      setError(describeError(err, tr('无法读取触发记录', 'Could not load the trigger records')));
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [ciID, page, tr]);

  useEffect(() => {
    void load();
  }, [load, retryKey]);

  const eventLabel = (value?: string): string => {
    switch (value) {
      case '0': return tr('新增', 'Added');
      case '1': return tr('删除', 'Deleted');
      case '2': return tr('修改', 'Updated');
      default: return value || '—';
    }
  };

  const columns: Column<TriggerHistoryItem>[] = [
    {
      key: 'time',
      header: tr('时间', 'Time'),
      cell: (row) => <span className="whitespace-nowrap font-mono text-[11px] text-text-muted">{fullDateTime(row.created_at)}</span>,
    },
    {
      key: 'trigger',
      header: tr('触发器', 'Trigger'),
      cell: (row) => <span className="text-xs text-text">{row.trigger_name || (row.trigger_id ? `#${row.trigger_id}` : '—')}</span>,
    },
    {
      key: 'event',
      header: tr('事件', 'Event'),
      cell: (row) => <span className="text-xs text-text-muted">{eventLabel(row.operate_type)}</span>,
    },
    {
      key: 'result',
      header: tr('结果', 'Result'),
      cell: (row) => (
        <Chip tone={row.is_ok ? 'success' : 'danger'} dense>
          {row.is_ok ? tr('成功', 'Succeeded') : tr('失败', 'Failed')}
        </Chip>
      ),
    },
    {
      key: 'user',
      header: tr('用户', 'User'),
      cell: (row) => <span className="text-xs text-text-muted">{userLabel(row.uid)}</span>,
    },
    {
      key: 'delivery',
      header: tr('投递', 'Delivery'),
      width: 'w-full',
      cell: (row) => {
        const delivery = row.webhook || row.notify || '';
        return (
          <code className="block max-w-[14rem] truncate text-[11px] text-text-muted" title={delivery || '—'}>
            {delivery || '—'}
          </code>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-xl border border-border bg-card/40">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          loading={loading}
          error={error}
          onRetry={() => setRetryKey((key) => key + 1)}
          empty={tr('这个资源还没有触发记录', 'This resource has no trigger records yet')}
        />
      </div>
      {total > PAGE_SIZE && (
        <div className="border-t border-border/60 py-1.5">
          <PaginationFooter
            page={page}
            pageSize={PAGE_SIZE}
            shown={rows.length}
            total={total}
            loading={loading}
            onPageChange={setPage}
            className="border-0 bg-transparent py-0"
          />
        </div>
      )}
    </div>
  );
}
