import { useCallback, useEffect, useRef, useState } from 'react';

import { Chip } from '@/components/ui/Chip';
import { PaginationFooter } from '@/components/ui/PaginationFooter';
import { Select } from '@/components/ui/Select';
import { useI18n } from '@/i18n/locale';
import { usePermissions } from '@/store/me';

import { listUsers } from '@/api/users';
import { describeError } from '../../api/http';
import { rackHistory, type RackHistory, type RackOperation } from '../../api/dcim';
import {
  DCIM_OPERATIONS,
  operationKind,
  operationTone,
} from '../../lib/dcim';
import type { ExportColumn } from '../../lib/export';
import { DataTable, type Column } from '../DataTable';
import { ExportMenu } from '../ipam/ExportMenu';

const PAGE_SIZE = 50;

export function OperationLogTab({ rackID, tick }: { rackID: number; tick: number }) {
  const { tr } = useI18n();
  const { isAdmin } = usePermissions();
  const [page, setPage] = useState(0);
  const [kind, setKind] = useState('all');
  const [history, setHistory] = useState<RackHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<Map<number, string>>(new Map());
  const request = useRef(0);

  useEffect(() => {
    if (!isAdmin) return;
    let live = true;
    void listUsers()
      .then((got) => {
        if (live) setUsers(new Map((got.items ?? []).map((user) => [user.id, user.display_name || user.email])));
      })
      .catch(() => live && setUsers(new Map()));
    return () => {
      live = false;
    };
  }, [isAdmin]);

  const load = useCallback(async () => {
    const sequence = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const got = await rackHistory({
        rack_id: rackID,
        ...(kind === 'all' ? {} : { operate_type: [kind] }),
        page: page + 1,
        count: PAGE_SIZE,
      });
      if (sequence === request.current) setHistory(got);
    } catch (failure) {
      if (sequence !== request.current) return;
      setHistory(null);
      setError(describeError(failure, tr('无法读取操作记录', 'Could not load the operation log')));
    } finally {
      if (sequence === request.current) setLoading(false);
    }
  }, [kind, page, rackID, tr]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  useEffect(() => {
    setPage(0);
  }, [kind, rackID]);

  const rows = history?.result ?? [];
  const userLabel = (uid?: number) => (uid == null ? '—' : users.get(uid) ?? `#${uid}`);

  const deviceOf = (row: RackOperation): { type: string; name: string } => {
    const ci = row.ci_id != null ? history?.id2ci?.[String(row.ci_id)] : undefined;
    if (!ci) return { type: '—', name: row.ci_id != null ? `#${row.ci_id}` : '—' };
    const typeID = String(ci._type ?? '');
    const showKey = history?.type2show_key?.[typeID];
    const name =
      (showKey && ci[showKey] != null ? String(ci[showKey]) : '') ||
      (ci.name != null ? String(ci.name) : '') ||
      (row.ci_id != null ? `#${row.ci_id}` : '—');
    return {
      type: String(ci.ci_type_alias ?? ci.ci_type ?? '—'),
      name,
    };
  };

  const columns: Column<RackOperation>[] = [
    {
      key: 'time',
      header: tr('操作时间', 'Time'),
      cell: (row) => <span className="whitespace-nowrap text-xs text-text">{row.created_at}</span>,
    },
    {
      key: 'user',
      header: tr('操作人', 'Operator'),
      cell: (row) => <span className="whitespace-nowrap text-xs text-text-muted">{userLabel(row.uid)}</span>,
    },
    {
      key: 'kind',
      header: tr('操作类型', 'Operation'),
      cell: (row) => {
        const record = DCIM_OPERATIONS.find((item) => item.value === operationKind(row.operate_type));
        return <Chip tone={operationTone(row.operate_type)}>{record ? tr(record.zh, record.en) : row.operate_type}</Chip>;
      },
    },
    {
      key: 'device_type',
      header: tr('设备类型', 'Device type'),
      cell: (row) => <span className="text-xs text-text-muted">{deviceOf(row).type}</span>,
    },
    {
      key: 'device',
      header: tr('设备', 'Device'),
      cell: (row) => <span className="block max-w-64 truncate text-xs text-text" title={deviceOf(row).name}>{deviceOf(row).name}</span>,
    },
  ];

  const exportColumns: ExportColumn<RackOperation>[] = [
    { key: 'time', header: tr('操作时间', 'Time'), value: (row) => row.created_at },
    { key: 'user', header: tr('操作人', 'Operator'), value: (row) => userLabel(row.uid) },
    {
      key: 'kind',
      header: tr('操作类型', 'Operation'),
      value: (row) => {
        const record = DCIM_OPERATIONS.find((item) => item.value === operationKind(row.operate_type));
        return record ? tr(record.zh, record.en) : row.operate_type;
      },
    },
    { key: 'device_type', header: tr('设备类型', 'Device type'), value: (row) => deviceOf(row).type },
    { key: 'device', header: tr('设备', 'Device'), value: (row) => deviceOf(row).name },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select
          label={tr('操作类型', 'Operation')}
          value={kind}
          onValueChange={(next) => {
            setKind(next);
            setPage(0);
          }}
          options={[
            { value: 'all', label: tr('全部操作', 'All operations') },
            ...DCIM_OPERATIONS.map((item) => ({ value: item.value, label: tr(item.zh, item.en) })),
          ]}
          className="w-40"
        />
        <ExportMenu filename="dcim-operation-log" columns={exportColumns} rows={rows} disabled={rows.length === 0} />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row._id}
        loading={loading}
        error={error}
        onRetry={() => void load()}
        storageKey={`dcim-operation-log-${rackID}`}
        empty={tr('还没有操作记录', 'No operations yet')}
      />
      <PaginationFooter
        page={page}
        pageSize={PAGE_SIZE}
        shown={rows.length}
        total={history?.numfound ?? 0}
        onPageChange={setPage}
        sticky={false}
        className="bg-transparent"
      />
    </div>
  );
}
