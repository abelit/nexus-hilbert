import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, Search, X } from 'lucide-react';

import { Button } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { Input } from '@/components/ui/Input';
import { PaginationFooter } from '@/components/ui/PaginationFooter';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Popover';
import { Select } from '@/components/ui/Select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { useI18n } from '@/i18n/locale';
import { usePermissions } from '@/store/me';

import { listUsers } from '@/api/users';
import { describeError } from '../../api/http';
import {
  IPAM_OPERATE_TYPES,
  ipamHistory,
  ipamScanHistory,
  type IPAMHistoryRecord,
  type IPAMScanRecord,
} from '../../api/ipam';
import {
  operationLabel,
  operationTone,
  scanDuration,
  scanStatusLabel,
} from '../../lib/ipam';
import type { ExportColumn } from '../../lib/export';
import { DataTable, type Column } from '../DataTable';
import { ExportMenu } from './ExportMenu';
import { useIPAM } from './context';

const PAGE_SIZE = 50;

export function HistoryTab() {
  const { tr } = useI18n();
  const { tick } = useIPAM();
  const { isAdmin } = usePermissions();
  const [kind, setKind] = useState<'operations' | 'scans'>('operations');
  const [cidr, setCidr] = useState('');
  const [operate, setOperate] = useState('all');
  const [page, setPage] = useState(0);
  const [operations, setOperations] = useState<IPAMHistoryRecord[]>([]);
  const [scans, setScans] = useState<IPAMScanRecord[]>([]);
  const [numFound, setNumFound] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<Map<number, string>>(new Map());

  useEffect(() => {
    if (!isAdmin) return;
    let live = true;
    void listUsers()
      .then((got) => {
        if (!live) return;
        setUsers(new Map((got.items ?? []).map((user) => [user.id, user.display_name || user.email])));
      })
      .catch(() => live && setUsers(new Map()));
    return () => {
      live = false;
    };
  }, [isAdmin]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (kind === 'operations') {
        const got = await ipamHistory({
          ...(cidr.trim() ? { cidr: `*${cidr.trim()}*` } : {}),
          ...(operate !== 'all' ? { operate_type: [operate] } : {}),
          page: page + 1,
          count: PAGE_SIZE,
        });
        setOperations(got.result ?? []);
        setNumFound(got.numfound ?? 0);
      } else {
        const got = await ipamScanHistory({
          ...(cidr.trim() ? { cidr: `*${cidr.trim()}*` } : {}),
          page: page + 1,
          count: PAGE_SIZE,
        });
        setScans(got.result ?? []);
        setNumFound(got.numfound ?? 0);
      }
    } catch (failure) {
      setOperations([]);
      setScans([]);
      setNumFound(0);
      setError(describeError(failure, tr('无法读取历史', 'Could not load the history')));
    } finally {
      setLoading(false);
    }
  }, [cidr, kind, operate, page, tr]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  useEffect(() => {
    setPage(0);
  }, [kind, cidr, operate]);

  const operationColumns: Column<IPAMHistoryRecord>[] = [
    {
      key: 'time',
      header: tr('操作时间', 'Time'),
      cell: (row) => <span className="whitespace-nowrap text-xs text-text">{displayTime(row.created_at)}</span>,
    },
    {
      key: 'user',
      header: tr('操作人', 'Operator'),
      cell: (row) => (
        <span className="whitespace-nowrap text-xs text-text-muted">
          {row.uid == null ? '—' : users.get(row.uid) ?? `#${row.uid}`}
        </span>
      ),
    },
    {
      key: 'kind',
      header: tr('操作类型', 'Operation'),
      cell: (row) => <Chip tone={operationTone(row.operate_type)}>{operationLabel(row.operate_type, tr)}</Chip>,
    },
    {
      key: 'cidr',
      header: 'CIDR',
      hideable: true,
      cell: (row) => <span className="whitespace-nowrap font-mono text-[11px] text-text-muted">{row.cidr ?? '—'}</span>,
    },
    {
      key: 'description',
      header: tr('描述', 'Detail'),
      width: 'w-full max-sm:w-auto',
      hideable: true,
      cell: (row) => <span className="break-all text-[11px] text-text-muted">{row.description ?? '—'}</span>,
    },
  ];

  const scanColumns: Column<IPAMScanRecord>[] = [
    {
      key: 'cidr',
      header: 'CIDR',
      cell: (row) => <span className="font-mono text-xs text-text">{row.cidr ?? '—'}</span>,
    },
    {
      key: 'ipnum',
      header: tr('IP 数', 'IPs'),
      align: 'right',
      cell: (row) => <span className="tabular-nums text-xs text-text-muted">{row.ip_num ?? '—'}</span>,
    },
    {
      key: 'start',
      header: tr('开始时间', 'Start'),
      cell: (row) => <span className="whitespace-nowrap text-[11px] text-text-muted">{displayTime(row.start_at)}</span>,
    },
    {
      key: 'end',
      header: tr('结束时间', 'End'),
      cell: (row) => <span className="whitespace-nowrap text-[11px] text-text-muted">{displayTime(row.end_at)}</span>,
    },
    {
      key: 'duration',
      header: tr('耗时', 'Duration'),
      width: 'w-full max-sm:w-auto',
      cell: (row) => <span className="text-[11px] text-text-muted">{scanDuration(row.start_at, row.end_at) || '—'}</span>,
    },
    {
      key: 'status',
      header: tr('结果', 'Result'),
      cell: (row) => (
        <Chip tone={row.status === 0 ? 'success' : 'danger'}>{scanStatusLabel(row.status, tr)}</Chip>
      ),
    },
  ];

  const operationExport: ExportColumn<IPAMHistoryRecord>[] = [
    { key: 'time', header: tr('操作时间', 'Time'), value: (row) => displayTime(row.created_at) },
    { key: 'user', header: tr('操作人', 'Operator'), value: (row) => (row.uid == null ? '' : users.get(row.uid) ?? `#${row.uid}`) },
    { key: 'kind', header: tr('操作类型', 'Operation'), value: (row) => operationLabel(row.operate_type, tr) },
    { key: 'cidr', header: 'CIDR', value: (row) => row.cidr ?? '' },
    { key: 'description', header: tr('描述', 'Detail'), value: (row) => row.description ?? '' },
  ];

  const scanExport: ExportColumn<IPAMScanRecord>[] = [
    { key: 'cidr', header: 'CIDR', value: (row) => row.cidr ?? '' },
    { key: 'ipnum', header: tr('IP 数', 'IPs'), value: (row) => row.ip_num ?? '' },
    { key: 'start', header: tr('开始时间', 'Start'), value: (row) => displayTime(row.start_at) },
    { key: 'end', header: tr('结束时间', 'End'), value: (row) => displayTime(row.end_at) },
    { key: 'duration', header: tr('耗时', 'Duration'), value: (row) => scanDuration(row.start_at, row.end_at) },
    { key: 'status', header: tr('结果', 'Result'), value: (row) => scanStatusLabel(row.status, tr) },
  ];

  const rows: Array<IPAMHistoryRecord | IPAMScanRecord> = kind === 'operations' ? operations : scans;
  const exportMenu =
    kind === 'operations' ? (
      <ExportMenu<IPAMHistoryRecord>
        filename="cmdb-ipam-operations"
        columns={operationExport}
        rows={operations}
        disabled={operations.length === 0}
      />
    ) : (
      <ExportMenu<IPAMScanRecord>
        filename="cmdb-ipam-scans"
        columns={scanExport}
        rows={scans}
        disabled={scans.length === 0}
      />
    );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Tabs value={kind} onValueChange={(value) => setKind(value as 'operations' | 'scans')}>
        <TabsList>
          <TabsTrigger value="operations">{tr('操作日志', 'Operations')}</TabsTrigger>
          <TabsTrigger value="scans">{tr('扫描日志', 'Scans')}</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-72">
          <Search size={12} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint" />
          <Input
            value={cidr}
            onChange={(event) => setCidr(event.target.value)}
            placeholder={tr('搜索 CIDR…', 'Search CIDR…')}
            aria-label={tr('搜索 CIDR', 'Search CIDR')}
            className="h-8 w-full pl-7 pr-7 text-xs font-mono"
          />
          {cidr && (
            <button
              type="button"
              onClick={() => setCidr('')}
              aria-label={tr('清除搜索', 'Clear the search')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-text-faint hover:text-text"
            >
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </div>
        {kind === 'operations' && (
          <Select
            label={tr('操作类型', 'Operation')}
            value={operate}
            onValueChange={setOperate}
            options={[
              { value: 'all', label: tr('全部类型', 'Every operation') },
              ...IPAM_OPERATE_TYPES.map((code) => ({ value: code, label: operationLabel(code, tr) })),
            ]}
            className="h-8 w-40"
          />
        )}
        <div className="ms-auto">{exportMenu}</div>
      </div>

      <Card className="min-w-0">
        {kind === 'operations' ? (
          <DataTable
            columns={operationColumns}
            rows={operations}
            rowKey={(row) => row._id}
            loading={loading}
            error={error}
            onRetry={() => void load()}
            storageKey="ipam-operations"
            empty={tr('还没有操作记录', 'No operations yet')}
          />
        ) : (
          <DataTable
            columns={scanColumns}
            rows={scans}
            rowKey={(row) => row._id}
            loading={loading}
            error={error}
            onRetry={() => void load()}
            storageKey="ipam-scans"
            empty={tr('还没有扫描记录', 'No scans yet')}
            actions={(row) => <ScanDetail row={row} />}
          />
        )}
        <PaginationFooter
          page={page}
          pageSize={PAGE_SIZE}
          shown={rows.length}
          total={numFound}
          onPageChange={setPage}
          className="mt-3"
        />
      </Card>
    </div>
  );
}

function ScanDetail({ row }: { row: IPAMScanRecord }) {
  const { tr } = useI18n();
  const ips = useMemo(() => {
    if (!row.ips) return '';
    try {
      return JSON.stringify(row.ips, null, 2);
    } catch {
      return String(row.ips);
    }
  }, [row.ips]);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="plain"
            size="sm"
            type="button"
            aria-label={tr('查看扫描结果', 'View the scan result')}
            title={tr('查看结果', 'View result')}
            className="inline-flex items-center gap-1 p-1 text-[11px] text-text-faint hover:text-text"
          />
        }
      >
        <Eye size={12} aria-hidden="true" /> {tr('查看', 'View')}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[90vw] p-3">
        <div className="flex flex-col gap-2 text-xs">
          <div className="font-medium text-text">{tr('扫描结果', 'Scan result')}</div>
          {row.exec_id && <div className="font-mono text-[11px] text-text-faint">exec_id: {row.exec_id}</div>}
          {row.stdout && (
            <div>
              <div className="mb-1 text-[11px] text-text-faint">{tr('输出', 'Output')}</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-card p-2 text-[11px] text-text-muted">
                {row.stdout}
              </pre>
            </div>
          )}
          {ips && (
            <div>
              <div className="mb-1 text-[11px] text-text-faint">{tr('地址', 'Addresses')}</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-card p-2 text-[11px] text-text-muted">
                {ips}
              </pre>
            </div>
          )}
          {!row.stdout && !ips && (
            <p className="text-[11px] text-text-faint">{tr('这条记录没有输出。', 'This record has no output.')}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function displayTime(raw?: string | null): string {
  if (!raw) return '—';
  const date = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
  if (!Number.isFinite(date.getTime())) return raw;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
