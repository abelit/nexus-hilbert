import { useMemo, useState, type ReactNode } from 'react';
import {
  Building2,
  DoorOpen,
  Globe2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/i18n/locale';

import { recalcRackUnits, type DCIMNode } from '../../api/dcim';
import { describeError } from '../../api/http';
import { dcimTypeOf, filterDCIMTree, type DCIMType } from '../../lib/dcim';
import { Tree, type TreeNode } from '../Tree';
import { useToast } from '../Toast';
import { useDCIM } from './context';

const NODE_ICON: Record<DCIMType, ReactNode> = {
  region: <Globe2 size={13} aria-hidden="true" />,
  idc: <Building2 size={13} aria-hidden="true" />,
  server_room: <DoorOpen size={13} aria-hidden="true" />,
  rack: <Building2 size={13} aria-hidden="true" />,
};

export function DcimTreePanel({
  onCreate,
  onEdit,
  onDelete,
}: {
  onCreate(type: DCIMType, parent: TreeNode | null): void;
  onEdit(nodeID: number): void;
  onDelete(nodeID: number): void;
}) {
  const { tr } = useI18n();
  const toast = useToast();
  const {
    tree,
    treeLoading,
    treeError,
    reloadTree,
    selectedRoomID,
    selectRoom,
    canMutate,
    bump,
  } = useDCIM();
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(
    () => filterDCIMTree(tree.roots, search, tree.label),
    [tree, search],
  );

  const expanded = useMemo(() => {
    const ids: string[] = [];
    const walk = (nodes: DCIMNode[]) => {
      for (const node of nodes) {
        if (node.children?.length) ids.push(String(node._id));
        walk(node.children ?? []);
      }
    };
    walk(filtered);
    return ids;
  }, [filtered]);

  const nodes = useMemo(
    () => filtered.map((node) => convert(node, tree, canMutate, onCreate, onEdit, onDelete, tr)),
    [filtered, tree, canMutate, onCreate, onEdit, onDelete, tr],
  );

  const recalc = async () => {
    setBusy(true);
    try {
      const got = await recalcRackUnits();
      toast.success(
        tr(
          `已重算 ${got.racks} 个机柜${got.skipped.length ? `，${got.skipped.length} 个因缺少高度跳过` : ''}`,
          `Recomputed ${got.racks} racks${got.skipped.length ? `; ${got.skipped.length} skipped for a missing height` : ''}`,
        ),
      );
      bump();
    } catch (error) {
      toast.error(describeError(error, tr('重算失败', 'Could not recompute')));
    } finally {
      setBusy(false);
    }
  };

  const newMenu = canMutate ? (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="plain"
            size="sm"
            type="button"
            aria-label={tr('数据中心操作', 'Data-centre actions')}
            title={tr('更多操作', 'More actions')}
            className="inline-flex size-7 items-center justify-center p-0 text-text-faint hover:text-text"
          />
        }
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48 p-1">
        <DropdownMenuItem onClick={() => onCreate('region', null)} className="gap-2">
          <Plus size={12} aria-hidden="true" /> {tr('新建区域', 'New region')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onClick={() => void recalc()} className="gap-2">
          <RefreshCw size={12} aria-hidden="true" /> {tr('重算机柜容量', 'Recompute racks')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <Card className="flex min-w-0 flex-col">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-text">{tr('存放位置', 'Locations')}</h2>
        <div className="flex items-center gap-1">
          <Button
            variant="plain"
            size="sm"
            type="button"
            onClick={() => void reloadTree(true)}
            aria-label={tr('刷新数据中心', 'Reload the data centre')}
            title={tr('刷新', 'Refresh')}
            className="inline-flex size-7 items-center justify-center p-0 text-text-faint hover:text-text"
          >
            <RefreshCw size={12} aria-hidden="true" />
          </Button>
          {newMenu}
        </div>
      </div>

      <div className="relative mb-2">
        <Search
          size={12}
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint"
        />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={tr('搜索区域、数据中心或机房', 'Search regions, data centres or rooms')}
          aria-label={tr('搜索存放位置', 'Search locations')}
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

      {treeError && (
        <div role="alert" className="mb-2 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          <div className="break-words">{treeError}</div>
          <Button variant="outline" size="sm" type="button" onClick={() => void reloadTree()} className="mt-2">
            {tr('重试', 'Retry')}
          </Button>
        </div>
      )}

      <div className="max-h-[45vh] overflow-y-auto lg:max-h-[70vh]">
        {treeLoading && tree.roots.length === 0 ? (
          <p className="py-6 text-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</p>
        ) : tree.roots.length === 0 && !treeError ? (
          <EmptyState
            title={tr('还没有区域', 'No regions yet')}
            hint={tr('区域下面是数据中心，再往下是机房。', 'A region holds data centres, which hold rooms.')}
            action={
              canMutate ? (
                <Button variant="primary" size="sm" type="button" onClick={() => onCreate('region', null)}>
                  {tr('新建区域', 'New region')}
                </Button>
              ) : undefined
            }
          />
        ) : tree.roots.length === 0 && treeError ? null : nodes.length === 0 ? (
          <p className="py-6 text-center text-xs text-text-muted">
            {tr('没有匹配的存放位置', 'No matching location')}
          </p>
        ) : (
          <Tree
            key={`${search}:${tree.flat.length}`}
            nodes={nodes}
            label={tr('数据中心树', 'Data-centre tree')}
            defaultExpanded={expanded}
            selectedId={selectedRoomID}
            onSelect={(node) => {
              // Only a room selects the work area. A region or an IDC is a
              // container; selecting it would clear the racks on screen.
              if (tree.raw.get(node.id)?.ci_type === 'dcim_server_room') selectRoom(node.id);
            }}
          />
        )}
      </div>

      {tree.roots.length > 0 && !treeLoading && (
        <p className="mt-2 text-[11px] text-text-faint">
          {tr('选择机房查看机柜；区域和数据中心用于分组。', 'Pick a room to see its racks; regions and data centres group them.')}
        </p>
      )}
    </Card>
  );
}

function convert(
  node: DCIMNode,
  tree: ReturnType<typeof useDCIM>['tree'],
  canMutate: boolean,
  onCreate: (type: DCIMType, parent: TreeNode | null) => void,
  onEdit: (nodeID: number) => void,
  onDelete: (nodeID: number) => void,
  tr: ReturnType<typeof useI18n>['tr'],
): TreeNode {
  const type = dcimTypeOf(node);
  const childType = type === 'region' ? 'idc' : type === 'idc' ? 'server_room' : null;
  const count = tree.rackCounts.get(String(node._id)) ?? 0;
  const label = tree.label(node);
  const row: TreeNode = {
    id: String(node._id),
    label: <span title={label}>{label}</span>,
    icon: type ? NODE_ICON[type] : undefined,
    trailing: count > 0 ? (
      <span title={tr(`${count} 个机柜`, `${count} racks`)} className="tabular-nums text-[10px]">
        {count}
      </span>
    ) : undefined,
    hasChildren: Boolean(node.children?.length) || type === 'region' || type === 'idc',
    children: (node.children ?? []).map((child) =>
      convert(child, tree, canMutate, onCreate, onEdit, onDelete, tr),
    ),
  };
  if (canMutate) {
    row.actions = (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="plain"
              size="sm"
              type="button"
              aria-label={tr(`操作 ${label}`, `Actions for ${label}`)}
              title={tr('节点操作', 'Node actions')}
              className="inline-flex size-6 items-center justify-center p-0 text-text-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-lg:opacity-100"
            />
          }
        >
          <MoreHorizontal size={12} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44 p-1">
          {childType && (
            <DropdownMenuItem onClick={() => onCreate(childType, row)} className="gap-2">
              <Plus size={12} aria-hidden="true" />
              {childType === 'idc' ? tr('新建数据中心', 'New data centre') : tr('新建机房', 'New room')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => onEdit(node._id)} className="gap-2">
            <Pencil size={12} aria-hidden="true" /> {tr('编辑', 'Edit')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => onDelete(node._id)}
            className="gap-2 text-red-400 focus:text-red-300"
          >
            <Trash2 size={12} aria-hidden="true" /> {tr('删除', 'Delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return row;
}
