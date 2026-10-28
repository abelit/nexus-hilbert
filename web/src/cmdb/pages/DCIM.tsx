import { useEffect, useMemo, useState } from 'react';
import { LayoutGrid, Plus, RefreshCw, Rows3, Search, X } from 'lucide-react';

import { Button } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { EmptyStateCard } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { useDialogs } from '@/components/ui/useDialogs';
import { useI18n } from '@/i18n/locale';

import { deleteDCIMNode, recalcRackUnits, type DCIMNode } from '../api/dcim';
import { describeError } from '../api/http';
import { DcimStats } from '../components/dcim/DcimStats';
import { DcimTreePanel } from '../components/dcim/DcimTreePanel';
import { NodeDialog, type NodeDialogState } from '../components/dcim/Dialogs';
import { RackDrawer } from '../components/dcim/RackDrawer';
import { RackGrid } from '../components/dcim/RackGrid';
import { RackTable } from '../components/dcim/RackTable';
import { DcimProvider, useDCIM } from '../components/dcim/context';
import { ExportMenu } from '../components/ipam/ExportMenu';
import { useToast } from '../components/Toast';
import {
  attributeDisplay,
  attributeLabel,
  type DCIMType,
  type RackRow,
} from '../lib/dcim';
import type { ExportColumn } from '../lib/export';

const TABLE_PAGE_SIZE = 20;

export default function DCIMPage() {
  return (
    <DcimProvider>
      <DcimShell />
    </DcimProvider>
  );
}

function DcimShell() {
  const { tr } = useI18n();
  const toast = useToast();
  const { confirmAction, dialog } = useDialogs();
  const {
    tree,
    treeLoading,
    reloadTree,
    selectedRoomID,
    selectedRoom,
    selectRoom,
    rackType,
    rackAttributes,
    rackFields,
    models,
    racks,
    stats,
    racksLoading,
    racksError,
    reloadRacks,
    bump,
    canMutate,
  } = useDCIM();

  const [layout, setLayout] = useState<'grid' | 'table'>('grid');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string | number>>(new Set());
  const [openRackID, setOpenRackID] = useState<number | null>(null);
  const [nodeDialog, setNodeDialog] = useState<NodeDialogState | null>(null);

  const roomID = selectedRoomID ? Number(selectedRoomID) : null;
  const openRack = useMemo(
    () => (openRackID == null ? null : racks.find((rack) => rack.id === openRackID) ?? null),
    [openRackID, racks],
  );

  useEffect(() => {
    if (openRackID != null && !racksLoading && !openRack) setOpenRackID(null);
  }, [openRackID, openRack, racksLoading]);

  useEffect(() => {
    setSearch('');
    setTypeFilter('all');
    setPage(0);
    setSelected(new Set());
    setOpenRackID(null);
  }, [selectedRoomID]);

  useEffect(() => {
    setPage(0);
    setSelected(new Set());
  }, [search, typeFilter, layout]);

  const typeAttribute = rackAttributes.find((attribute) => attribute.name === 'rack_type');
  const typeOptions = [
    { value: 'all', label: tr('全部机柜', 'All racks') },
    ...(typeAttribute?.choice_value ?? []).map((choice) => ({
      value: String(choice.value ?? ''),
      label: typeof choice.option?.label === 'string' && choice.option.label
        ? choice.option.label
        : String(choice.value ?? ''),
    })),
    { value: 'unitAbnormal', label: tr('U 位异常', 'U conflict') },
  ];

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return racks.filter((rack) => {
      if (needle && !rack.name.toLowerCase().includes(needle)) return false;
      if (typeFilter === 'all') return true;
      if (typeFilter === 'unitAbnormal') return rack.abnormal;
      return rack.rackType === typeFilter;
    });
  }, [racks, search, typeFilter]);

  const selectedRows = filtered.filter((rack) => selected.has(rack.id));
  const clearFilters = () => {
    setSearch('');
    setTypeFilter('all');
  };

  const exportColumns: ExportColumn<RackRow>[] = [
    { key: 'name', header: tr('机柜', 'Rack'), value: (rack) => rack.name },
    ...rackFields.map((attribute) => ({
      key: attribute.name,
      header: attributeLabel(attribute),
      value: (rack: RackRow) => attributeDisplay(attribute, rack.row[attribute.name]),
    })),
    { key: 'used', header: tr('使用率', 'Used'), value: (rack) => `${rack.usedRatio}%` },
  ];

  // A mutation of the tree can change the rack list and the selected room.
  const afterNodeWrite = async (message: string, roomDeleted?: boolean) => {
    setNodeDialog(null);
    toast.success(message);
    await reloadTree(true);
    if (roomDeleted) {
      // The room is gone; its rack endpoint would answer 404. Clearing the URL
      // lets the provider's room effect load the empty state instead.
      selectRoom(null);
    }
    // One bump reloads the room's racks for every other node write.
    bump();
  };

  const deleteNode = async (nodeID: number) => {
    const node = tree.raw.get(String(nodeID));
    if (!node) return;
    const type = node.ci_type.replace(/^dcim_/, '') as DCIMType;
    const label = tree.label(node);
    const message =
      type === 'rack'
        ? tr(`删除「${label}」？机柜里的设备会被下架。`, `Delete “${label}”? The devices inside will be unmounted.`)
        : tr(
            `删除「${label}」？它下面的节点会失去归属。`,
            `Delete “${label}”? Nodes below it will lose their container.`,
          );
    if (!(await confirmAction(message))) return;
    try {
      await deleteDCIMNode(type, nodeID);
      const removedSelected = type === 'server_room' && selectedRoomID === String(nodeID);
      await afterNodeWrite(tr('已删除', 'Deleted'), removedSelected);
    } catch (failure) {
      toast.error(describeError(failure, tr('删除失败', 'Could not delete it')));
    }
  };

  const createRack = () => {
    if (!selectedRoom) return;
    setNodeDialog({ type: 'rack', parent: selectedRoom });
  };

  const editRack = (rack: RackRow) => {
    setNodeDialog({
      type: 'rack',
      node: {
        _id: rack.id,
        _type: Number(rack.row._type ?? rackType?.id ?? 0),
        ci_type: 'dcim_rack',
        ci_type_alias: 'rack',
        name: rack.name,
      },
    });
  };

  const fromTree = (nodeID: number): DCIMNode | null => tree.raw.get(String(nodeID)) ?? null;

  const rowActions = canMutate ? (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="primary"
            size="sm"
            type="button"
            className="inline-flex items-center gap-1.5 font-medium text-accent-fg"
          />
        }
      >
        <Plus size={12} aria-hidden="true" />
        {tr('新建', 'New')}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48 p-1">
        <DropdownMenuItem onClick={() => setNodeDialog({ type: 'region' })} className="gap-2">
          {tr('新建区域', 'New region')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!selectedRoom}
          onClick={() => selectedRoom && setNodeDialog({ type: 'rack', parent: selectedRoom })}
          className="gap-2"
        >
          {tr('新建机柜', 'New rack')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!selectedRoom}
          onClick={async () => {
            try {
              const got = await recalcRackUnits();
              toast.success(
                tr(
                  `已重算 ${got.racks} 个机柜${got.skipped.length ? `，${got.skipped.length} 个跳过` : ''}`,
                  `Recomputed ${got.racks} racks${got.skipped.length ? `; ${got.skipped.length} skipped` : ''}`,
                ),
              );
              await reloadRacks(true);
              bump();
            } catch (failure) {
              toast.error(describeError(failure, tr('重算失败', 'Could not recompute')));
            }
          }}
          className="gap-2"
        >
          {tr('重算机柜容量', 'Recompute racks')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <PageHeader
        title={tr('数据中心', 'Data centre')}
        subtitle={tr(
          '区域 → 数据中心 → 机房 → 机柜。机柜里放设备，容量由服务端在同一个事务里重算。',
          'Region → data centre → room → rack. Devices live in racks, and the capacity is recomputed server-side in the same transaction.',
        )}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={async () => {
                await Promise.all([reloadTree(true), reloadRacks(true)]);
              }}
              disabled={treeLoading || racksLoading}
              className="inline-flex items-center gap-1.5"
            >
              <RefreshCw size={12} className={treeLoading || racksLoading ? 'animate-spin' : undefined} aria-hidden="true" />
              {tr('刷新', 'Refresh')}
            </Button>
            {rowActions}
          </div>
        }
      />

      <div className="grid min-h-0 w-full min-w-0 flex-1 grid-cols-1 items-start gap-4 overflow-y-auto p-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <DcimTreePanel
          onCreate={(type, parent) =>
            setNodeDialog({ type, parent: parent ? fromTree(Number(parent.id)) : null })
          }
          onEdit={(nodeID) => {
            const node = fromTree(nodeID);
            if (!node) return;
            const type = node.ci_type.replace(/^dcim_/, '') as DCIMType;
            setNodeDialog({ type, node });
          }}
          onDelete={(nodeID) => void deleteNode(nodeID)}
        />

        <div className="flex min-w-0 flex-col gap-3">
          {!selectedRoom ? (
            <EmptyStateCard
              title={tr('选择一个机房', 'Choose a room')}
              hint={tr(
                '左侧的机房决定右侧展示哪些机柜。没有机房时，先在区域下新建数据中心和机房。',
                'The room on the left decides which racks appear here. Create a data centre and a room under a region first.',
              )}
              icon={LayoutGrid}
            />
          ) : (
            <>
              <DcimStats stats={stats} />

              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:flex-1">
                  <div className="relative w-full min-w-0 flex-1 sm:min-w-48 sm:max-w-72">
                    <Search
                      size={12}
                      aria-hidden="true"
                      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint"
                    />
                    <Input
                      type="search"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={tr('筛选机柜', 'Filter racks')}
                      aria-label={tr('筛选机柜', 'Filter racks')}
                      className="h-9 w-full pl-7 pr-7 text-xs"
                    />
                    {search && (
                      <button
                        type="button"
                        onClick={() => setSearch('')}
                        aria-label={tr('清除筛选', 'Clear the filter')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-text-faint hover:text-text"
                      >
                        <X size={11} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  <Select
                    label={tr('机柜类型', 'Rack type')}
                    value={typeFilter}
                    onValueChange={setTypeFilter}
                    options={typeOptions}
                    className="w-36 shrink-0"
                  />
                  <Chip dense className="hidden sm:inline-flex">
                    {tr(`${filtered.length} 个机柜`, `${filtered.length} racks`)}
                  </Chip>
                </div>

                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                  <div className="flex overflow-hidden rounded-md border border-border" role="group" aria-label={tr('布局', 'Layout')}>
                    <button
                      type="button"
                      aria-label={tr('网格布局', 'Grid layout')}
                      aria-pressed={layout === 'grid'}
                      onClick={() => setLayout('grid')}
                      className={
                        layout === 'grid'
                          ? 'inline-flex size-8 items-center justify-center bg-indigo-500/10 text-indigo-400'
                          : 'inline-flex size-8 items-center justify-center text-text-faint hover:text-text'
                      }
                    >
                      <LayoutGrid size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={tr('表格布局', 'Table layout')}
                      aria-pressed={layout === 'table'}
                      onClick={() => setLayout('table')}
                      className={
                        layout === 'table'
                          ? 'inline-flex size-8 items-center justify-center border-l border-border bg-indigo-500/10 text-indigo-400'
                          : 'inline-flex size-8 items-center justify-center border-l border-border text-text-faint hover:text-text'
                      }
                    >
                      <Rows3 size={14} aria-hidden="true" />
                    </button>
                  </div>
                  <ExportMenu
                    filename="dcim-racks"
                    columns={exportColumns}
                    rows={selectedRows.length > 0 ? selectedRows : filtered}
                    disabled={filtered.length === 0}
                  />
                  {canMutate && (
                    <Button variant="primary" size="sm" type="button" onClick={createRack} className="inline-flex items-center gap-1.5">
                      <Plus size={12} aria-hidden="true" />
                      {tr('新建机柜', 'New rack')}
                    </Button>
                  )}
                </div>
              </div>

              {layout === 'grid' ? (
                <RackGrid
                  racks={filtered}
                  loading={racksLoading}
                  error={racksError}
                  onRetry={() => void reloadRacks()}
                  onOpen={(rack) => setOpenRackID(rack.id)}
                  onCreate={canMutate ? createRack : undefined}
                  hasRacks={racks.length > 0}
                  onClearFilters={clearFilters}
                />
              ) : (
                <Card className="min-w-0 p-3">
                  <RackTable
                    racks={filtered}
                    fields={rackFields}
                    models={models}
                    loading={racksLoading}
                    error={racksError}
                    onRetry={() => void reloadRacks()}
                    onOpen={(rack) => setOpenRackID(rack.id)}
                    selection={selected}
                    onSelectionChange={setSelected}
                    page={page}
                    pageSize={TABLE_PAGE_SIZE}
                    onPageChange={setPage}
                    hasRacks={racks.length > 0}
                    onClearFilters={clearFilters}
                  />
                </Card>
              )}

            </>
          )}
        </div>
      </div>

      {openRack && roomID != null && (
        <RackDrawer
          rack={openRack}
          roomID={roomID}
          onClose={() => setOpenRackID(null)}
          onEdit={() => editRack(openRack)}
          onDeleted={async () => {
            setOpenRackID(null);
            await reloadRacks(true);
            await reloadTree(true);
          }}
        />
      )}

      {nodeDialog && (
        <NodeDialog
          state={nodeDialog}
          onClose={() => setNodeDialog(null)}
          onSaved={(message) => afterNodeWrite(message)}
        />
      )}

      {dialog}
    </div>
  );
}
