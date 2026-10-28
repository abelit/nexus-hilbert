import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pencil, Search, Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { Input } from '@/components/ui/Input';
import { PaginationFooter } from '@/components/ui/PaginationFooter';
import { useI18n } from '@/i18n/locale';

import { describeError } from '../../api/http';
import { searchInstances } from '../../api/instance';
import type { IPAMNode } from '../../api/ipam';
import { cidrHostCount, toSubnetRow, type SubnetRow } from '../../lib/ipam';
import { instanceSearchQuery } from '../../lib/instance-search';
import type { ExportColumn } from '../../lib/export';
import { DataTable, type Column } from '../DataTable';
import { ExportMenu } from './ExportMenu';
import { useIPAM } from './context';

const PAGE_SIZE = 50;

export function SubnetListTab({
  onEdit,
  onDelete,
  onOpenAddresses,
}: {
  onEdit(node: IPAMNode): void;
  onDelete(node: IPAMNode): void;
  onOpenAddresses(node: IPAMNode): void;
}) {
  const { tr } = useI18n();
  const { tree, subnetTypeID, subnetNameKey, tick, canMutate } = useIPAM();
  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<SubnetRow[]>([]);
  const [numFound, setNumFound] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(term.trim()), 300);
    return () => clearTimeout(timer);
  }, [term]);

  useEffect(() => {
    setPage(0);
  }, [query]);

  const load = useCallback(async () => {
    if (!subnetTypeID) return;
    setLoading(true);
    setError(null);
    try {
      const got = await searchInstances({
        q: instanceSearchQuery(subnetTypeID, query),
        page: page + 1,
        count: PAGE_SIZE,
      });
      setNumFound(got.numfound ?? 0);
      setRows((got.result ?? []).map((row) => toSubnetRow(row, subnetNameKey)));
    } catch (failure) {
      setRows([]);
      setNumFound(0);
      setError(describeError(failure, tr('无法读取子网列表', 'Could not load the ranges')));
    } finally {
      setLoading(false);
    }
  }, [page, query, subnetNameKey, subnetTypeID, tr]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  const nodeOf = (row: SubnetRow): IPAMNode =>
    tree.raw.get(String(row.id)) ?? {
      _id: row.id,
      _type: subnetTypeID ?? 0,
      ci_type: 'ipam_subnet',
      ci_type_alias: 'subnet',
      name: row.name,
      cidr: row.cidr,
    };

  const columns: Column<SubnetRow>[] = [
    {
      key: 'name',
      header: tr('名称', 'Name'),
      sortable: true,
      sortValue: (row) => row.name,
      width: 'w-full max-sm:w-auto',
      cell: (row) => (
        <button
          type="button"
          onClick={() => onOpenAddresses(nodeOf(row))}
          className="min-w-0 text-left text-xs font-medium text-text hover:underline"
        >
          {row.name}
        </button>
      ),
    },
    {
      key: 'cidr',
      header: 'CIDR',
      sortable: true,
      sortValue: (row) => row.cidr,
      cell: (row) => <span className="font-mono text-[11px] text-text-muted">{row.cidr || '—'}</span>,
    },
    {
      key: 'hosts',
      header: tr('主机数', 'Hosts'),
      align: 'right',
      sortable: true,
      sortValue: (row) => row.hostsCount || cidrHostCount(row.cidr),
      cell: (row) => (
        <span className="tabular-nums text-xs text-text-muted">{row.hostsCount || cidrHostCount(row.cidr)}</span>
      ),
    },
    {
      key: 'assigned',
      header: tr('已分配', 'Assigned'),
      align: 'right',
      sortable: true,
      sortValue: (row) => row.assignCount,
      cell: (row) => <span className="tabular-nums text-xs text-text-muted">{row.assignCount}</span>,
    },
    {
      key: 'used',
      header: tr('已使用', 'Used'),
      align: 'right',
      sortable: true,
      sortValue: (row) => row.usedCount,
      cell: (row) => <span className="tabular-nums text-xs text-text-muted">{row.usedCount}</span>,
    },
    {
      key: 'free',
      header: tr('空闲', 'Free'),
      align: 'right',
      sortable: true,
      sortValue: (row) => row.freeCount,
      cell: (row) => (
        <Chip tone={row.freeCount <= 0 ? 'danger' : row.hostsCount > 0 && row.freeCount / row.hostsCount < 0.15 ? 'warning' : 'success'}>
          {row.freeCount}
        </Chip>
      ),
    },
  ];

  const exportColumns: ExportColumn<SubnetRow>[] = [
    { key: 'name', header: tr('名称', 'Name'), value: (row) => row.name },
    { key: 'cidr', header: 'CIDR', value: (row) => row.cidr },
    { key: 'hosts', header: tr('主机数', 'Hosts'), value: (row) => row.hostsCount || cidrHostCount(row.cidr) },
    { key: 'assigned', header: tr('已分配', 'Assigned'), value: (row) => row.assignCount },
    { key: 'used', header: tr('已使用', 'Used'), value: (row) => row.usedCount },
    { key: 'free', header: tr('空闲', 'Free'), value: (row) => row.freeCount },
  ];

  const pageRows = useMemo(() => rows, [rows]);

  if (!subnetTypeID) {
    return (
      <p className="py-10 text-center text-xs text-text-muted">
        {tr('这个部署还没有 ipam_subnet 模型，无法列出网段。', 'This deployment has no ipam_subnet model, so ranges cannot be listed.')}
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-80">
          <Search size={12} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint" />
          <Input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder={tr('搜索名称或 CIDR…', 'Search name or CIDR…')}
            aria-label={tr('搜索子网', 'Search ranges')}
            className="h-8 w-full pl-7 pr-7 text-xs"
          />
          {term && (
            <button
              type="button"
              onClick={() => setTerm('')}
              aria-label={tr('清除搜索', 'Clear the search')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-text-faint hover:text-text"
            >
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="ms-auto flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => {
              setTerm('');
              setQuery('');
              setPage(0);
            }}
          >
            {tr('重置', 'Reset')}
          </Button>
          <ExportMenu filename="cmdb-ipam-subnets" columns={exportColumns} rows={rows} disabled={rows.length === 0} />
        </div>
      </div>

      <Card className="min-w-0">
        <DataTable
          columns={columns}
          rows={pageRows}
          rowKey={(row) => row.id}
          loading={loading}
          error={error}
          onRetry={() => void load()}
          storageKey="ipam-subnet-list"
          empty={query ? tr('没有匹配的网段', 'No range matches') : tr('还没有网段', 'No ranges yet')}
          actions={(row) => (
            <div className="flex items-center gap-1">
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
          shown={rows.length}
          total={numFound}
          onPageChange={setPage}
          className="mt-3"
        />
      </Card>
    </div>
  );
}
