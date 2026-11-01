import { useCallback, useEffect, useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui';
import { Chip } from '@/components/ui/Chip';
import { PaginationFooter } from '@/components/ui/PaginationFooter';
import { useI18n } from '@/i18n/locale';
import { fullDateTime } from '@/lib/format';

import { describeError } from '../../api/http';
import { listCIHistory, type AttributeChange } from '../../api/history';
import { DataTable, type Column } from '../DataTable';
import { RollbackDialog } from './RollbackDialog';

const PAGE_SIZE = 20;

function operateTone(value?: string): 'success' | 'warning' | 'danger' | 'default' {
  if (value === '0') return 'success';
  if (value === '1') return 'danger';
  if (value === '2') return 'warning';
  return 'default';
}

export function InstanceHistory({
  ciID,
  userLabel,
  canRollback = false,
  onRolledBack,
}: {
  ciID: number;
  userLabel(uid?: number): string;
  /** The viewer may write this instance; a read-only peek stays read-only. */
  canRollback?: boolean;
  /** Lets the detail drawer and the list behind refresh after a rollback. */
  onRolledBack?(): void;
}) {
  const { tr } = useI18n();
  const [rows, setRows] = useState<AttributeChange[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  // null closes the dialog; an empty object opens the manual time picker.
  const [rollbackTarget, setRollbackTarget] = useState<{ before?: string; recordID?: number } | null>(null);

  // ONE ACTION PER WRITE, NOT PER CHANGED ATTRIBUTE. A single save can touch
  // several rows with the same record_id; offering the same rollback on each
  // would imply they restore different things.
  const groupStarts = useMemo(() => {
    const seen = new Set<number>();
    const starts = new Set<number>();
    for (const row of rows) {
      if (seen.has(row.record_id)) continue;
      seen.add(row.record_id);
      starts.add(row.id);
    }
    return starts;
  }, [rows]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const got = await listCIHistory(ciID, page + 1, PAGE_SIZE);
      setRows(got.items ?? []);
      setTotal(got.total ?? 0);
    } catch (err) {
      setError(describeError(err, tr('无法读取变更历史', 'Could not load the change history')));
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [ciID, page, tr]);

  useEffect(() => {
    void load();
  }, [load, retryKey]);

  const operateLabel = (value?: string): string => {
    switch (value) {
      case '0': return tr('新增', 'Added');
      case '1': return tr('删除', 'Deleted');
      case '2': return tr('修改', 'Updated');
      default: return '—';
    }
  };

  const columns: Column<AttributeChange>[] = [
    {
      key: 'time',
      header: tr('时间', 'Time'),
      cell: (row) => <span className="whitespace-nowrap font-mono text-[11px] text-text-muted">{fullDateTime(row.created_at)}</span>,
    },
    {
      key: 'user',
      header: tr('用户', 'User'),
      cell: (row) => <span className="text-xs text-text-muted">{userLabel(row.uid)}</span>,
    },
    {
      key: 'action',
      header: tr('操作', 'Action'),
      cell: (row) => <Chip tone={operateTone(row.operate_type)} dense>{operateLabel(row.operate_type)}</Chip>,
    },
    {
      key: 'attribute',
      header: tr('属性', 'Attribute'),
      cell: (row) => (
        <span className="text-xs">
          <span className="font-medium text-text">{row.attr_alias || row.attr_name || `#${row.attr_id}`}</span>
          {row.attr_name && row.attr_alias && (
            <code className="ml-1.5 font-mono text-[10px] text-text-faint">{row.attr_name}</code>
          )}
        </span>
      ),
    },
    {
      key: 'change',
      header: tr('变更前 → 变更后', 'Before → after'),
      width: 'w-full',
      cell: (row) => (
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-[11px]">
          <code className="max-w-[10rem] truncate rounded bg-bg/60 px-1.5 py-0.5 text-text-muted" title={row.old || '—'}>
            {row.old || '—'}
          </code>
          <span className="text-text-faint" aria-hidden="true">→</span>
          <code className="max-w-[10rem] truncate rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-300" title={row.new || '—'}>
            {row.new || '—'}
          </code>
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-2">
      {canRollback && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] text-text-muted">
            {tr(
              '可回滚到某次写入之前，或选择任意时间点。',
              'Roll back to before a write, or pick any point in time.',
            )}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRollbackTarget({})}
            className="inline-flex items-center gap-1.5"
          >
            <RotateCcw size={12} aria-hidden="true" />
            {tr('回滚', 'Roll back')}
          </Button>
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-border bg-card/40">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          loading={loading}
          error={error}
          onRetry={() => setRetryKey((key) => key + 1)}
          empty={tr('这个资源还没有变更记录', 'This resource has no change history yet')}
          actionsHeader={tr('操作', 'Actions')}
          actions={
            canRollback
              ? (row) =>
                  groupStarts.has(row.id) ? (
                    <Button
                      type="button"
                      variant="plain"
                      size="sm"
                      aria-label={tr('回滚到此变更之前', 'Roll back to before this change')}
                      title={tr('回滚到此变更之前', 'Roll back to before this change')}
                      onClick={() =>
                        setRollbackTarget({ before: row.created_at, recordID: row.record_id })
                      }
                      className="inline-flex size-7 items-center justify-center p-0 text-text-faint hover:text-text"
                    >
                      <RotateCcw size={13} aria-hidden="true" />
                    </Button>
                  ) : null
              : undefined
          }
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
      {canRollback && (
        <RollbackDialog
          open={rollbackTarget !== null}
          ciID={ciID}
          initialBefore={rollbackTarget?.before}
          initialRecordID={rollbackTarget?.recordID}
          onOpenChange={(next) => {
            if (!next) setRollbackTarget(null);
          }}
          onRolledBack={() => {
            // The rollback writes a new record at the top of the log; return to
            // the first page so the operator can see what they just did.
            setPage(0);
            setRetryKey((key) => key + 1);
            onRolledBack?.();
          }}
        />
      )}
    </div>
  );
}
