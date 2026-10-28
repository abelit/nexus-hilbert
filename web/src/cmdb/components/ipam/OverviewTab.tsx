import { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderTree, Pencil, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { PaginationFooter } from '@/components/ui/PaginationFooter';
import { useI18n } from '@/i18n/locale';

import { describeError } from '../../api/http';
import { ipamStats, type IPAMNode, type SubnetSummary } from '../../api/ipam';
import { toSubnetRow, type SubnetRow } from '../../lib/ipam';
import type { ExportColumn } from '../../lib/export';
import { DataTable, type Column } from '../DataTable';
import { ExportMenu } from './ExportMenu';
import { useIPAM } from './context';

const PAGE_SIZE = 50;

export function OverviewTab({
  onEdit,
  onDelete,
  onOpenAddresses,
}: {
  onEdit(node: IPAMNode): void;
  onDelete(node: IPAMNode): void;
  onOpenAddresses(id: number): void;
}) {
  const { tr } = useI18n();
  const { selectedID, selectedNode, tree, subnetTypeID, subnetNameKey, tick, canMutate, setTab, selectNode } = useIPAM();
  const [summary, setSummary] = useState<SubnetSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const got = await ipamStats(selectedID === 'all' ? undefined : Number(selectedID));
      setSummary(got);
    } catch (failure) {
      setError(describeError(failure, tr('无法读取统计', 'Could not load the summary')));
    } finally {
      setLoading(false);
    }
  }, [selectedID, tr]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  useEffect(() => {
    setPage(0);
  }, [selectedID]);

  const rows = useMemo(
    () => (summary?.subnets ?? []).map((row) => toSubnetRow(row, subnetNameKey)),
    [summary, subnetNameKey],
  );
  const pageRows = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const nodeOf = (row: SubnetRow): IPAMNode => {
    const existing = tree.raw.get(String(row.id));
    if (existing) return existing;
    return {
      _id: row.id,
      _type: subnetTypeID ?? 0,
      ci_type: 'ipam_subnet',
      ci_type_alias: 'subnet',
      name: row.name,
      cidr: row.cidr,
    };
  };

  const columns: Column<SubnetRow>[] = [
    {
      key: 'name',
      header: tr('名称', 'Name'),
      width: 'w-full max-sm:w-auto',
      cell: (row) => (
        <button
          type="button"
          onClick={() => {
            selectNode(String(row.id));
            setTab('address');
          }}
          className="min-w-0 text-left"
        >
          <div className="truncate text-xs font-medium text-text hover:underline">{row.name}</div>
          <div className="truncate font-mono text-[11px] text-text-muted">{row.cidr || '—'}</div>
        </button>
      ),
    },
    {
      key: 'hosts',
      header: tr('主机数', 'Hosts'),
      align: 'right',
      cell: (row) => <span className="tabular-nums text-xs text-text-muted">{row.hostsCount}</span>,
    },
    {
      key: 'online',
      header: tr('在线率', 'Online rate'),
      sortable: true,
      sortValue: (row) => (row.hostsCount ? row.usedCount / row.hostsCount : 0),
      cell: (row) => {
        const ratio = row.hostsCount ? Math.round((row.usedCount / row.hostsCount) * 100) : 0;
        return (
          <div className="flex min-w-32 items-center gap-2">
            <div className="h-1.5 w-20 overflow-hidden rounded-full bg-card">
              <div className="h-full rounded-full bg-indigo-500" style={{ width: `${Math.min(100, ratio)}%` }} />
            </div>
            <span className="whitespace-nowrap text-[11px] tabular-nums text-text-muted">
              {ratio}% ({row.usedCount}/{row.hostsCount})
            </span>
          </div>
        );
      },
    },
    {
      key: 'assigned',
      header: tr('已分配', 'Assigned'),
      align: 'right',
      cell: (row) => <span className="tabular-nums text-xs text-text-muted">{row.assignCount}</span>,
    },
    {
      key: 'used',
      header: tr('已使用', 'Used'),
      align: 'right',
      hideable: true,
      defaultHidden: true,
      cell: (row) => <span className="tabular-nums text-xs text-text-muted">{row.usedCount}</span>,
    },
    {
      key: 'free',
      header: tr('空闲', 'Free'),
      align: 'right',
      cell: (row) => (
        <Chip tone={row.freeCount <= 0 ? 'danger' : row.hostsCount > 0 && row.freeCount / row.hostsCount < 0.15 ? 'warning' : 'success'}>
          {row.freeCount}
        </Chip>
      ),
    },
    {
      key: 'scan',
      header: tr('扫描', 'Scan'),
      hideable: true,
      cell: (row) => (
        <Chip tone={row.scanEnabled ? 'info' : 'default'}>{row.scanEnabled ? tr('开', 'On') : tr('关', 'Off')}</Chip>
      ),
    },
    {
      key: 'last',
      header: tr('最近扫描', 'Last scan'),
      hideable: true,
      defaultHidden: true,
      cell: (row) => (
        <span className="whitespace-nowrap text-[11px] text-text-faint">{row.lastScanTime ?? '—'}</span>
      ),
    },
  ];

  const exportColumns: ExportColumn<SubnetRow>[] = [
    { key: 'name', header: tr('名称', 'Name'), value: (row) => row.name },
    { key: 'cidr', header: 'CIDR', value: (row) => row.cidr },
    { key: 'hosts', header: tr('主机数', 'Hosts'), value: (row) => row.hostsCount },
    { key: 'assigned', header: tr('已分配', 'Assigned'), value: (row) => row.assignCount },
    { key: 'used', header: tr('已使用', 'Used'), value: (row) => row.usedCount },
    { key: 'free', header: tr('空闲', 'Free'), value: (row) => row.freeCount },
    { key: 'scan', header: tr('扫描', 'Scan'), value: (row) => (row.scanEnabled ? tr('开', 'On') : tr('关', 'Off')) },
    { key: 'last', header: tr('最近扫描', 'Last scan'), value: (row) => row.lastScanTime ?? '' },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 min-[1400px]:grid-cols-4">
        <SubnetCountCard count={summary?.subnet_num ?? 0} />
        <RatioCard
          title={tr('地址统计', 'Address space')}
          ratio={ratio(summary?.address_free_num, summary?.address_num)}
          center={`${ratio(summary?.address_free_num, summary?.address_num)}%`}
          legend={[
            { label: tr('空闲', 'Free'), value: summary?.address_free_num ?? 0, color: 'bg-sky-500' },
            { label: tr('使用', 'Used'), value: summary?.address_num ? summary.address_num - summary.address_free_num : 0, color: 'bg-indigo-500' },
          ]}
        />
        <RatioCard
          title={tr('分配统计', 'Allocation')}
          ratio={ratio(summary?.address_assign_num, summary?.address_num)}
          center={`${ratio(summary?.address_assign_num, summary?.address_num)}%`}
          legend={[
            { label: tr('已分配', 'Assigned'), value: summary?.address_assign_num ?? 0, color: 'bg-emerald-500' },
            { label: tr('未分配', 'Unassigned'), value: summary?.address_unassign_num ?? 0, color: 'bg-zinc-500' },
          ]}
        />
        <RatioCard
          title={tr('在线统计', 'Online')}
          ratio={ratio(summary?.address_used_num, summary?.address_num)}
          center={`${ratio(summary?.address_used_num, summary?.address_num)}%`}
          legend={[
            { label: tr('在线', 'Online'), value: summary?.address_used_num ?? 0, color: 'bg-emerald-500' },
            { label: tr('离线', 'Offline'), value: summary?.address_used_free_num ?? 0, color: 'bg-zinc-500' },
          ]}
        />
      </div>

      <Card className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-text">
              {selectedNode ? tree.label(selectedNode) : tr('子网在线统计', 'Ranges')}
            </h3>
            <p className="mt-0.5 text-[11px] text-text-faint">
              {tr(
                '统计按叶子子网求和；选择分组时会汇总它下面的网段。',
                'Totals are summed over leaf ranges; a selected group includes the ranges below it.',
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ExportMenu filename="cmdb-ipam-subnets" columns={exportColumns} rows={rows} disabled={rows.length === 0} />
          </div>
        </div>
        <DataTable
          columns={columns}
          rows={pageRows}
          rowKey={(row) => row.id}
          loading={loading}
          error={error}
          onRetry={() => void load()}
          storageKey="ipam-overview"
          empty={tr('这个节点下还没有网段', 'No ranges under this node yet')}
          actions={(row) => (
            <div className="flex items-center gap-1">
              <Button
                variant="subtle"
                size="sm"
                type="button"
                onClick={() => onOpenAddresses(row.id)}
                aria-label={tr(`查看 ${row.name} 的地址`, `Open the addresses of ${row.name}`)}
                title={tr('查看地址', 'Addresses')}
              >
                {tr('地址', 'Addresses')}
              </Button>
              {canMutate && (
                <>
                  <Button
                    variant="plain"
                    size="sm"
                    type="button"
                    onClick={() => onEdit(nodeOf(row))}
                    aria-label={tr(`编辑 ${row.name}`, `Edit ${row.name}`)}
                    title={tr('编辑', 'Edit')}
                    className="inline-flex size-7 items-center justify-center p-0 text-text-faint hover:text-text"
                  >
                    <Pencil size={12} aria-hidden="true" />
                  </Button>
                  <Button
                    variant="plain"
                    size="sm"
                    type="button"
                    onClick={() => onDelete(nodeOf(row))}
                    aria-label={tr(`删除 ${row.name}`, `Delete ${row.name}`)}
                    title={tr('删除', 'Delete')}
                    className="inline-flex size-7 items-center justify-center p-0 text-text-faint hover:text-red-400"
                  >
                    <Trash2 size={12} aria-hidden="true" />
                  </Button>
                </>
              )}
            </div>
          )}
        />
        <PaginationFooter
          page={page}
          pageSize={PAGE_SIZE}
          shown={pageRows.length}
          total={rows.length}
          onPageChange={setPage}
          className="mt-3 bg-transparent"
        />
      </Card>
    </div>
  );
}

function ratio(part: number | undefined, total: number | undefined): number {
  if (!part || !total || total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function SubnetCountCard({ count }: { count: number }) {
  const { tr } = useI18n();
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-400">
        <FolderTree size={20} aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-[11px] text-text-faint">{tr('子网统计', 'Ranges')}</div>
        <div className="mt-0.5 text-2xl font-semibold tabular-nums text-text">{count}</div>
        <div className="text-[10px] text-text-faint">{tr('叶子子网总数', 'leaf ranges')}</div>
      </div>
    </div>
  );
}

function RatioCard({
  title,
  ratio: value,
  center,
  legend,
}: {
  title: string;
  ratio: number;
  center: string;
  legend: Array<{ label: string; value: number; color: string }>;
}) {
  const { tr } = useI18n();
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="text-[11px] text-text-faint">{title}</div>
      <div className="mt-1 flex items-center gap-3">
        <svg viewBox="0 0 36 36" className="size-14 shrink-0" role="img" aria-label={tr(`${title} ${center}`, `${title} ${center}`)}>
          <circle cx="18" cy="18" r="15.5" fill="none" stroke="currentColor" strokeWidth="4" className="text-border" />
          <circle
            cx="18"
            cy="18"
            r="15.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={`${(clamped / 100) * 97.4} 97.4`}
            transform="rotate(-90 18 18)"
            className="text-indigo-500"
          />
        </svg>
        <div className="min-w-0 flex-1">
          <div className="text-lg font-semibold tabular-nums text-text">{center}</div>
          <div className="mt-1 flex flex-col gap-0.5">
            {legend.map((item) => (
              <div key={item.label} className="flex items-center gap-1.5 text-[10px] text-text-faint">
                <span className={`size-2 rounded-full ${item.color}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <span className="tabular-nums text-text-muted">{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
