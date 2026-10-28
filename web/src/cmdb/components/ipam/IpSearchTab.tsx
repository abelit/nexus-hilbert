import { useCallback, useEffect, useMemo, useState } from 'react';
import { PlusCircle, RotateCcw, Search, X } from 'lucide-react';

import { Button } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { Input } from '@/components/ui/Input';
import { PaginationFooter } from '@/components/ui/PaginationFooter';
import { Select } from '@/components/ui/Select';
import { useI18n } from '@/i18n/locale';

import { describeError } from '../../api/http';
import { searchInstances } from '../../api/instance';
import {
  ADDRESS_ASSIGNED,
  ADDRESS_RESERVED,
  ADDRESS_UNASSIGNED,
  assignAddresses,
  type IPAMNode,
} from '../../api/ipam';
import {
  addressFromRow,
  derivedStatus,
  derivedStatusLabel,
  derivedStatusTone,
  findSubnetForIP,
  isSubnet,
  type AddressRecord,
  type DerivedStatus,
} from '../../lib/ipam';
import { instanceSearchQuery } from '../../lib/instance-search';
import type { ExportColumn } from '../../lib/export';
import { DataTable, type Column } from '../DataTable';
import { useToast } from '../Toast';
import { AddressEditor } from './AddressEditor';
import { ExportMenu } from './ExportMenu';
import { useIPAM } from './context';

const PAGE_SIZE = 50;

type Row = AddressRecord & { subnet?: IPAMNode };

export function IpSearchTab() {
  const { tr } = useI18n();
  const toast = useToast();
  const { tree, addressTypeID, tick, bump, canMutate } = useIPAM();
  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string>('all');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [numFound, setNumFound] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ row: Row; subnetID: number } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(term.trim()), 300);
    return () => clearTimeout(timer);
  }, [term]);

  useEffect(() => {
    setPage(0);
  }, [query]);

  const load = useCallback(async () => {
    if (!addressTypeID) return;
    setLoading(true);
    setError(null);
    try {
      const got = await searchInstances({
        q: instanceSearchQuery(addressTypeID, query),
        page: page + 1,
        count: PAGE_SIZE,
      });
      setNumFound(got.numfound ?? 0);
      setRows(
        (got.result ?? [])
          .filter((row) => String(row.ci_type) === 'ipam_address' || Number(row._type) === addressTypeID)
          .map((row) => {
            const address = addressFromRow(row);
            const subnet = findSubnetForIP(
              tree.flat.filter(isSubnet),
              address.ip,
            );
            return { ...address, subnet };
          }),
      );
    } catch (failure) {
      setRows([]);
      setNumFound(0);
      setError(describeError(failure, tr('搜索地址失败', 'Could not search the addresses')));
    } finally {
      setLoading(false);
    }
  }, [addressTypeID, page, query, tree.flat, tr]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  const filtered = useMemo(() => {
    if (status === 'all') return rows;
    return rows.filter((row) => derivedStatus(row) === status);
  }, [rows, status]);

  const openEditor = (row: Row) => {
    if (!row.subnet) {
      toast.error(tr('这个地址不在已知网段内，无法写入', 'This address is not inside a known range'));
      return;
    }
    setEditing({ row, subnetID: row.subnet._id });
  };

  const recycle = async (row: Row) => {
    if (!row.subnet) {
      toast.error(tr('这个地址不在已知网段内，无法回收', 'This address is not inside a known range'));
      return;
    }
    try {
      await assignAddresses({
        subnet_id: row.subnet._id,
        ips: [row.ip],
        assign_status: ADDRESS_UNASSIGNED,
      });
      toast.success(tr(`已回收 ${row.ip}`, `Recycled ${row.ip}`));
      bump();
    } catch (failure) {
      toast.error(describeError(failure, tr('回收失败', 'Could not recycle it')));
    }
  };

  const columns: Column<Row>[] = [
    {
      key: 'ip',
      header: 'IP',
      sortable: true,
      sortValue: (row) => row.ip,
      width: 'w-full max-sm:w-auto',
      cell: (row) => <span className="font-mono text-xs text-text">{row.ip}</span>,
    },
    {
      key: 'status',
      header: tr('状态', 'State'),
      sortable: true,
      sortValue: (row) => derivedStatus(row),
      cell: (row) => {
        const derived = derivedStatus(row);
        return <Chip tone={derivedStatusTone(derived)}>{derivedStatusLabel(derived, tr)}</Chip>;
      },
    },
    {
      key: 'cidr',
      header: tr('子网', 'Range'),
      sortable: true,
      sortValue: (row) => String(row.subnet?.cidr ?? ''),
      cell: (row) => <span className="font-mono text-[11px] text-text-muted">{String(row.subnet?.cidr ?? '—')}</span>,
    },
    {
      key: 'name',
      header: tr('名称', 'Name'),
      sortable: true,
      sortValue: (row) => row.name ?? '',
      hideable: true,
      cell: (row) => <span className="text-xs text-text-muted">{row.name ?? '—'}</span>,
    },
    {
      key: 'mac',
      header: tr('MAC', 'MAC'),
      sortable: true,
      sortValue: (row) => row.macAddress ?? '',
      hideable: true,
      cell: (row) => <span className="font-mono text-[11px] text-text-muted">{row.macAddress ?? '—'}</span>,
    },
  ];

  const exportColumns: ExportColumn<Row>[] = [
    { key: 'ip', header: 'IP', value: (row) => row.ip },
    { key: 'status', header: tr('状态', 'State'), value: (row) => derivedStatusLabel(derivedStatus(row), tr) },
    { key: 'subnet', header: tr('子网', 'Range'), value: (row) => row.subnet?.cidr ?? '' },
    { key: 'name', header: tr('名称', 'Name'), value: (row) => row.name ?? '' },
    { key: 'mac', header: tr('MAC', 'MAC'), value: (row) => row.macAddress ?? '' },
  ];

  if (!addressTypeID) {
    return (
      <p className="py-10 text-center text-xs text-text-muted">
        {tr('这个部署还没有 ipam_address 模型，无法搜索地址。', 'This deployment has no ipam_address model, so addresses cannot be searched.')}
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
            placeholder={tr('搜索 IP、名称或 MAC…', 'Search IP, name or MAC…')}
            aria-label={tr('搜索地址', 'Search addresses')}
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
        <Select
          label={tr('状态', 'State')}
          value={status}
          onValueChange={setStatus}
          options={[
            { value: 'all', label: tr('全部状态', 'Every state') },
            ...(['0', '1', '2', '3'] as DerivedStatus[]).map((item) => ({
              value: item,
              label: derivedStatusLabel(item, tr),
            })),
          ]}
          className="h-8 w-40"
        />
        <div className="ms-auto flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => {
              setTerm('');
              setStatus('all');
              setQuery('');
            }}
          >
            {tr('重置', 'Reset')}
          </Button>
          <ExportMenu filename="cmdb-ipam-ip-search" columns={exportColumns} rows={filtered} disabled={filtered.length === 0} />
        </div>
      </div>

      <Card className="min-w-0">
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(row) => row.ip}
          loading={loading}
          error={error}
          onRetry={() => void load()}
          storageKey="ipam-ip-search"
          empty={query ? tr('没有匹配的地址', 'No address matches') : tr('还没有地址记录', 'No addresses yet')}
          actions={(row) => (
            <div className="flex items-center gap-1">
              {canMutate && (
                <Button
                  variant="plain"
                  size="sm"
                  type="button"
                  onClick={() => openEditor(row)}
                  disabled={!row.subnet}
                  aria-label={tr(`编辑 ${row.ip}`, `Edit ${row.ip}`)}
                  title={row.subnet ? tr('编辑', 'Edit') : tr('不在已知网段内', 'Not inside a known range')}
                  className="inline-flex size-7 items-center justify-center p-0 text-text-faint hover:text-text disabled:opacity-40"
                >
                  <PlusCircle size={13} aria-hidden="true" />
                </Button>
              )}
              {canMutate && (row.assignStatus === ADDRESS_ASSIGNED || row.assignStatus === ADDRESS_RESERVED) && (
                <Button
                  variant="plain"
                  size="sm"
                  type="button"
                  onClick={() => void recycle(row)}
                  disabled={!row.subnet}
                  aria-label={tr(`回收 ${row.ip}`, `Recycle ${row.ip}`)}
                  title={tr('回收', 'Recycle')}
                  className="inline-flex size-7 items-center justify-center p-0 text-text-faint hover:text-amber-400 disabled:opacity-40"
                >
                  <RotateCcw size={13} aria-hidden="true" />
                </Button>
              )}
            </div>
          )}
        />
        <PaginationFooter
          page={page}
          pageSize={PAGE_SIZE}
          // The status facet is local to the loaded page, as cantor's was; the
          // pager still walks the server's whole match set.
          shown={filtered.length}
          total={numFound}
          onPageChange={setPage}
          className="mt-3"
        />
      </Card>

      {editing && (
        <AddressEditor
          rows={[editing.row]}
          subnetID={editing.subnetID}
          onClose={() => setEditing(null)}
          onSaved={async (message) => {
            setEditing(null);
            toast.success(message);
            bump();
          }}
        />
      )}
    </div>
  );
}
