import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutGrid, List, PlusCircle, RotateCcw, Search, X } from 'lucide-react';

import { Button } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PaginationFooter } from '@/components/ui/PaginationFooter';
import { Select } from '@/components/ui/Select';
import { cn } from '@/lib/cn';
import { useI18n } from '@/i18n/locale';

import { describeError } from '../../api/http';
import {
  ADDRESS_ASSIGNED,
  ADDRESS_RESERVED,
  ADDRESS_UNASSIGNED,
  assignAddresses,
  isSubnet,
  listAllAddresses,
  subnetHosts,
} from '../../api/ipam';
import {
  addressFromRow,
  applySelection,
  derivedStatus,
  derivedStatusLabel,
  derivedStatusTone,
  mergeAddresses,
  scopesOf,
  type AddressRecord,
  type DerivedStatus,
} from '../../lib/ipam';
import type { ExportColumn } from '../../lib/export';
import { DataTable, type Column } from '../DataTable';
import { useToast } from '../Toast';
import { AddressEditor } from './AddressEditor';
import { AddressGrid, AddressLegend } from './AddressGrid';
import { ExportMenu } from './ExportMenu';
import { useIPAM } from './context';

const STATUS_ALL = 'all';
const TABLE_PAGE = 50;
const GRID_PAGE = 256;

export function AddressesTab() {
  const { tr } = useI18n();
  const toast = useToast();
  const { selectedNode, selectedIsSubnet, tick, bump, canMutate } = useIPAM();

  const leaf = Boolean(
    selectedIsSubnet &&
      selectedNode &&
      isSubnet(selectedNode) &&
      String(selectedNode.cidr ?? '').trim() &&
      (selectedNode.children ?? []).length === 0,
  );

  const [rows, setRows] = useState<AddressRecord[]>([]);
  const [totalHosts, setTotalHosts] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>(STATUS_ALL);
  const [scope, setScope] = useState(STATUS_ALL);
  const [layout, setLayout] = useState<'table' | 'grid'>('table');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [editing, setEditing] = useState<AddressRecord[] | null>(null);
  // A quick node switch can leave the previous range's request in flight; only
  // the newest request may write state.
  const requestRef = useRef(0);

  const nodeID = selectedNode?._id ?? 0;

  const load = useCallback(async () => {
    if (!leaf || !selectedNode || !selectedIsSubnet) return;
    const request = ++requestRef.current;
    const cidr = String(selectedNode.cidr ?? '');
    setLoading(true);
    setError(null);
    try {
      const [hosts, addresses] = await Promise.all([
        subnetHosts(cidr, 4096),
        listAllAddresses(selectedNode._id, 4096),
      ]);
      if (request !== requestRef.current) return;
      const records = (addresses.result ?? []).map(addressFromRow).filter((row) => row.ip);
      const merged = mergeAddresses(hosts.hosts ?? [], records, cidr, 4096);
      setRows(merged.rows);
      setTotalHosts(merged.totalHosts || merged.rows.length);
      setTruncated(merged.truncated || hosts.truncated);
    } catch (failure) {
      if (request !== requestRef.current) return;
      setRows([]);
      setError(describeError(failure, tr('无法读取地址', 'Could not load the addresses')));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [leaf, selectedNode, selectedIsSubnet, tr]);

  // A different range is a different set of filters. Keeping a status pill or
  // a /24 scope across the switch can leave the new range filtered to nothing.
  // This runs BEFORE the loader so the loader's request is the current one.
  useEffect(() => {
    // THE PREVIOUS RANGE'S ROWS ARE NOT THIS RANGE'S. Keeping them while the
    // new request is in flight would show one subnet's addresses under another.
    requestRef.current += 1;
    setRows([]);
    setTotalHosts(0);
    setTruncated(false);
    setError(null);
    setSearch('');
    setStatusFilter(STATUS_ALL);
    setScope(STATUS_ALL);
    setPage(0);
    setSelected(new Set());
    setAnchor(null);
    setEditing(null);
  }, [nodeID]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  useEffect(() => {
    setPage(0);
  }, [search, statusFilter, scope, layout]);

  const scopeOptions = useMemo(
    () => (selectedNode?.cidr ? scopesOf(selectedNode.cidr) : []),
    [selectedNode?.cidr],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (scope !== STATUS_ALL && !row.ip.startsWith(`${scope}.`)) return false;
      if (statusFilter !== STATUS_ALL && derivedStatus(row) !== statusFilter) return false;
      if (!needle) return true;
      return (
        row.ip.includes(search.trim()) ||
        (row.usage ?? '').toLowerCase().includes(needle) ||
        (row.useObj ?? '').toLowerCase().includes(needle)
      );
    });
  }, [rows, search, scope, statusFilter]);

  // THE SELECTION FOLLOWS WHAT IS FILTERED. Otherwise the footer counts rows
  // the operator cannot see and the editor would save addresses that are not
  // on screen.
  useEffect(() => {
    const visible = new Set(filtered.map((row) => row.ip));
    setSelected((current) => {
      let changed = false;
      const next = new Set<string>();
      current.forEach((ip) => {
        if (visible.has(ip)) next.add(ip);
        else changed = true;
      });
      return changed ? next : current;
    });
    setAnchor((current) => (current && visible.has(current) ? current : null));
  }, [filtered]);

  const counts = useMemo(() => {
    const out: Record<DerivedStatus, number> = { '0': 0, '1': 0, '2': 0, '3': 0 };
    for (const row of rows) out[derivedStatus(row)] += 1;
    const total = totalHosts || rows.length;
    out['3'] = Math.max(0, total - out['0'] - out['1'] - out['2']);
    return out;
  }, [rows, totalHosts]);

  const total = totalHosts || rows.length;
  const allocated = rows.filter((row) => row.assignStatus === ADDRESS_ASSIGNED || row.assignStatus === ADDRESS_RESERVED).length;
  const available = Math.max(0, total - allocated);
  const rate = total > 0 ? Math.round((allocated / total) * 1000) / 10 : 0;

  const pageSize = layout === 'table' ? TABLE_PAGE : GRID_PAGE;
  const pageRows = filtered.slice(page * pageSize, page * pageSize + pageSize);
  const pageIPs = pageRows.map((row) => row.ip);

  const clearSelection = () => {
    setSelected(new Set());
    setAnchor(null);
  };

  const selectRow = (ip: string, gesture: { shift: boolean; toggle: boolean }) => {
    const got = applySelection(selected, pageIPs, ip, {
      shift: gesture.shift,
      // A shift range is never also a toggle; otherwise a checkbox toggles and
      // a plain grid click replaces.
      toggle: gesture.shift ? false : gesture.toggle,
      anchor,
    });
    setSelected(got.next);
    setAnchor(got.anchor);
  };

  const openEditor = (selection: AddressRecord[]) => {
    if (selection.length === 0 || !canMutate) return;
    setEditing(selection);
  };

  const quickRecycle = async (row: AddressRecord) => {
    if (!selectedNode) return;
    try {
      await assignAddresses({
        subnet_id: selectedNode._id,
        ips: [row.ip],
        assign_status: ADDRESS_UNASSIGNED,
      });
      toast.success(tr(`已回收 ${row.ip}`, `Recycled ${row.ip}`));
      clearSelection();
      // `bump` re-runs the load effect; calling load here too would send the
      // same two requests twice.
      bump();
    } catch (failure) {
      toast.error(describeError(failure, tr('回收失败', 'Could not recycle it')));
    }
  };

  const columns: Column<AddressRecord>[] = [
    {
      key: 'ip',
      header: 'IP',
      // At phone width the table is a horizontally scrolling strip; a full-width
      // IP column would push every other column out of the only visible space.
      width: 'w-full max-sm:w-auto',
      cell: (row) => <span className="font-mono text-xs text-text">{row.ip}</span>,
    },
    {
      key: 'status',
      header: tr('状态', 'State'),
      cell: (row) => {
        const status = derivedStatus(row);
        return <Chip tone={derivedStatusTone(status)}>{derivedStatusLabel(status, tr)}</Chip>;
      },
    },
    {
      key: 'usage',
      header: tr('用途', 'Usage'),
      hideable: true,
      cell: (row) => <span className="text-xs text-text-muted">{row.usage ?? '—'}</span>,
    },
    {
      key: 'useObj',
      header: tr('使用对象', 'Used by'),
      hideable: true,
      cell: (row) => <span className="text-xs text-text-muted">{row.useObj ?? '—'}</span>,
    },
    {
      key: 'mac',
      header: tr('MAC', 'MAC'),
      hideable: true,
      cell: (row) => <span className="font-mono text-[11px] text-text-muted">{row.macAddress ?? '—'}</span>,
    },
    {
      key: 'description',
      header: tr('描述', 'Description'),
      hideable: true,
      defaultHidden: true,
      cell: (row) => <span className="break-all text-[11px] text-text-muted">{row.description ?? '—'}</span>,
    },
  ];

  const exportColumns: ExportColumn<AddressRecord>[] = [
    { key: 'ip', header: 'IP', value: (row) => row.ip },
    { key: 'status', header: tr('状态', 'State'), value: (row) => derivedStatusLabel(derivedStatus(row), tr) },
    { key: 'usage', header: tr('用途', 'Usage'), value: (row) => row.usage ?? '' },
    { key: 'useObj', header: tr('使用对象', 'Used by'), value: (row) => row.useObj ?? '' },
    { key: 'mac', header: tr('MAC', 'MAC'), value: (row) => row.macAddress ?? '' },
    { key: 'description', header: tr('描述', 'Description'), value: (row) => row.description ?? '' },
  ];

  if (!leaf) {
    return (
      <EmptyState
        title={tr('未选择子网', 'No range selected')}
        hint={tr(
          '在左侧树中选择一个没有子网段的叶子网段，或从总览里打开一个网段。',
          'Select a leaf range (one without sub-ranges) in the tree, or open one from the overview.',
        )}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {error && rows.length === 0 && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <Button variant="outline" size="sm" type="button" onClick={() => void load()}>
            {tr('重试', 'Retry')}
          </Button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={tr('总地址数', 'Total')} value={total} />
        <Stat label={tr('已分配/使用', 'Allocated')} value={allocated} tone="success" />
        <Stat label={tr('闲置/可用', 'Available')} value={available} tone="info" />
        <Stat label={tr('分配使用率', 'Allocation rate')} value={`${rate}%`} />
      </div>

      {truncated && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300">
          {tr(
            `范围过大，只显示前 4096 个主机；已登记的地址仍全部包含。共 ${total} 个地址。`,
            `This range is too large to list in full: the first 4096 hosts are shown, plus every registered address. ${total} addresses in total.`,
          )}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-72">
          <Search
            size={12}
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint"
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={tr('搜索 IP / 用途 / 使用对象…', 'Search IP, usage or used-by…')}
            aria-label={tr('搜索地址', 'Search addresses')}
            className="h-8 w-full pl-7 pr-7 text-xs"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label={tr('清除搜索', 'Clear the search')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-text-faint hover:text-text"
            >
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </div>

        {scopeOptions.length > 1 && (
          <Select
            label={tr('网段范围', 'Scope')}
            value={scope}
            onValueChange={setScope}
            options={[
              { value: STATUS_ALL, label: tr('全部 /24', 'Every /24') },
              ...scopeOptions.map((item) => ({ value: item, label: `${item}.0/24` })),
            ]}
            className="h-8 w-36"
          />
        )}

        <div className="ms-auto flex items-center gap-1.5">
          {selected.size > 0 && canMutate && (
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => openEditor(filtered.filter((row) => selected.has(row.ip)))}
              className="inline-flex items-center gap-1.5"
            >
              {tr(`编辑选中 (${selected.size})`, `Edit selected (${selected.size})`)}
            </Button>
          )}
          <ExportMenu
            filename="cmdb-ipam-address"
            columns={exportColumns}
            rows={filtered}
            disabled={filtered.length === 0}
          />
          <div className="flex items-center rounded-md border border-border">
            <Button
              variant="plain"
              size="sm"
              type="button"
              aria-label={tr('表格视图', 'Table view')}
              aria-pressed={layout === 'table'}
              onClick={() => setLayout('table')}
              className={cn('inline-flex size-8 items-center justify-center p-0', layout === 'table' ? 'bg-card text-text' : 'text-text-faint')}
            >
              <List size={13} aria-hidden="true" />
            </Button>
            <Button
              variant="plain"
              size="sm"
              type="button"
              aria-label={tr('网格视图', 'Grid view')}
              aria-pressed={layout === 'grid'}
              onClick={() => {
                setLayout('grid');
                clearSelection();
              }}
              className={cn('inline-flex size-8 items-center justify-center p-0', layout === 'grid' ? 'bg-card text-text' : 'text-text-faint')}
            >
              <LayoutGrid size={13} aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>

      <div role="group" aria-label={tr('按状态筛选', 'Filter by state')} className="flex flex-wrap items-center gap-1.5">
        <Pill
          active={statusFilter === STATUS_ALL}
          label={`${tr('全部', 'All')} (${total})`}
          onClick={() => setStatusFilter(STATUS_ALL)}
        />
        {(['0', '1', '2', '3'] as DerivedStatus[]).map((status) => (
          <Pill
            key={status}
            active={statusFilter === status}
            label={`${derivedStatusLabel(status, tr)} (${counts[status]})`}
            onClick={() => setStatusFilter(statusFilter === status ? STATUS_ALL : status)}
          />
        ))}
      </div>

      <Card className="min-w-0">
        {layout === 'table' ? (
          <>
            <DataTable
              columns={columns}
              rows={pageRows}
              rowKey={(row) => row.ip}
              loading={loading}
              error={error}
              onRetry={() => void load()}
              storageKey="ipam-addresses"
              selection={{
                selected,
                onChange: (next) => setSelected(new Set([...next].map(String))),
                onSelect: (key, gesture) => selectRow(String(key), { shift: gesture.shift, toggle: true }),
              }}
              onRowClick={(row) => {
                setSelected(new Set([row.ip]));
                setAnchor(row.ip);
                openEditor([row]);
              }}
              empty={tr('这个网段还没有登记地址', 'No addresses registered in this range yet')}
              actions={(row) => {
                const status = derivedStatus(row);
                const assigned = row.assignStatus === ADDRESS_ASSIGNED || row.assignStatus === ADDRESS_RESERVED;
                return (
                  <div className="flex items-center gap-1">
                    {canMutate && (
                      <Button
                        variant="plain"
                        size="sm"
                        type="button"
                        onClick={() => openEditor([row])}
                        aria-label={tr(`编辑 ${row.ip}`, `Edit ${row.ip}`)}
                        title={tr('编辑', 'Edit')}
                        className="inline-flex size-7 items-center justify-center p-0 text-text-faint hover:text-text"
                      >
                        <PlusCircle size={13} aria-hidden="true" />
                      </Button>
                    )}
                    {canMutate && assigned && (
                      <Button
                        variant="plain"
                        size="sm"
                        type="button"
                        onClick={() => void quickRecycle(row)}
                        aria-label={tr(`回收 ${row.ip}`, `Recycle ${row.ip}`)}
                        title={tr('回收', 'Recycle')}
                        className="inline-flex size-7 items-center justify-center p-0 text-text-faint hover:text-amber-400"
                      >
                        <RotateCcw size={13} aria-hidden="true" />
                      </Button>
                    )}
                    {!canMutate && status === '3' && <span className="text-[11px] text-text-faint">—</span>}
                  </div>
                );
              }}
            />
            <PaginationFooter
              page={page}
              pageSize={pageSize}
              shown={pageRows.length}
              total={filtered.length}
              onPageChange={setPage}
              className="mt-3"
            />
          </>
        ) : (
          <>
            <AddressGrid
              rows={pageRows}
              selected={selected}
              onSelect={(row, gesture) => {
                selectRow(row.ip, { shift: gesture.shift, toggle: gesture.toggle });
                if (!gesture.shift && !gesture.toggle) openEditor([row]);
              }}
            />
            <AddressLegend />
            <PaginationFooter
              page={page}
              pageSize={pageSize}
              shown={pageRows.length}
              total={filtered.length}
              onPageChange={setPage}
              className="mt-3"
            />
          </>
        )}
      </Card>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-text-muted">
          <span>{tr(`已选择 ${selected.size} 个地址`, `${selected.size} address(es) selected`)}</span>
          <Button variant="plain" size="sm" type="button" onClick={clearSelection} className="text-text-faint hover:text-text">
            {tr('清除选择', 'Clear selection')}
          </Button>
        </div>
      )}

      {editing && selectedNode && (
        <AddressEditor
          rows={editing}
          subnetID={selectedNode._id}
          onClose={() => setEditing(null)}
          onSaved={async (message) => {
            setEditing(null);
            clearSelection();
            toast.success(message);
            bump();
          }}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: 'success' | 'info';
}) {
  const color = tone === 'success' ? 'text-emerald-400' : tone === 'info' ? 'text-sky-400' : 'text-text';
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="truncate text-[11px] text-text-faint">{label}</div>
      <div className={`mt-0.5 text-xl font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function Pill({ active, label, onClick }: { active: boolean; label: string; onClick(): void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
        active
          ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
          : 'border-border text-text-muted hover:bg-card hover:text-text',
      )}
    >
      {label}
    </button>
  );
}
