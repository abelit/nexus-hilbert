import { useMemo, useState } from 'react';
import {
  Folder,
  MoreHorizontal,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  MoveRight,
  Search,
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

import { isSubnet, type IPAMNode } from '../../api/ipam';
import { cidrHostCount, subtreeHostCount } from '../../lib/ipam';
import { Tree, type TreeNode } from '../Tree';
import { useIPAM } from './context';

export type NodeAction = 'create-scope' | 'create-subnet' | 'edit' | 'move' | 'delete';

export function IpamTreePanel({
  onAction,
}: {
  onAction(action: NodeAction, node: IPAMNode | null): void;
}) {
  const { tr } = useI18n();
  const { tree, loading, error, reload, selectedID, selectNode, canMutate } = useIPAM();
  const [search, setSearch] = useState('');

  const needle = search.trim().toLowerCase();
  const filtered = useMemo(() => (needle ? filterTree(tree.roots, needle, tree.label) : tree.roots), [needle, tree]);

  const expanded = useMemo(() => {
    const ids: string[] = [];
    const walk = (nodes: IPAMNode[]) => {
      for (const node of nodes) {
        if (node.children?.length) {
          // SEARCH OPENS WHAT IT MATCHED; without this a match under a closed
          // ancestor is filtered in but invisible.
          if (!needle || !isSubnet(node)) ids.push(String(node._id));
          walk(node.children);
        }
      }
    };
    walk(filtered);
    return ids;
  }, [filtered, needle]);

  const nodes = useMemo(
    () => filtered.map((node) => convert(node, tree.label, onAction, canMutate, tr)),
    [filtered, tree.label, onAction, canMutate, tr],
  );

  const totalHosts = useMemo(
    () => tree.roots.reduce((sum, node) => sum + subtreeHostCount(node), 0),
    [tree.roots],
  );

  return (
    <Card className="flex min-w-0 flex-col">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-text">{tr('地址空间', 'Address space')}</h2>
        <Button
          variant="subtle"
          size="sm"
          type="button"
          onClick={() => void reload(true)}
          aria-label={tr('刷新地址空间', 'Reload the address space')}
          title={tr('刷新地址空间', 'Reload the address space')}
          className="inline-flex size-7 items-center justify-center p-0"
        >
          <RefreshCw size={12} aria-hidden="true" />
        </Button>
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
          placeholder={tr('搜索分组或网段', 'Search groups or ranges')}
          aria-label={tr('搜索地址空间', 'Search the address space')}
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

      {error && (
        <div role="alert" className="mb-2 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          <div className="break-words">{error}</div>
          <Button variant="outline" size="sm" type="button" onClick={() => void reload()} className="mt-2">
            {tr('重试', 'Retry')}
          </Button>
        </div>
      )}

      <div className="flex max-h-[45vh] flex-col gap-1 overflow-y-auto lg:max-h-[70vh]">
        <div
          className={`group flex items-center gap-1.5 rounded px-2 py-1 text-xs ${
            selectedID === 'all' ? 'bg-indigo-500/10 text-text' : 'text-text-muted hover:bg-card hover:text-text'
          }`}
        >
          <button
            type="button"
            onClick={() => selectNode('all')}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <Network size={13} className="shrink-0 text-text-faint" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{tr('全部', 'All')}</span>
            {totalHosts > 0 && <span className="shrink-0 text-[10px] text-text-faint">{totalHosts}</span>}
          </button>
          {canMutate && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="plain"
                    size="sm"
                    type="button"
                    aria-label={tr('全部节点操作', 'All-nodes actions')}
                    className="inline-flex size-6 items-center justify-center p-0 text-text-faint hover:text-text"
                  />
                }
              >
                <MoreHorizontal size={13} aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40 p-1">
                <DropdownMenuItem onClick={() => onAction('create-scope', null)} className="gap-2">
                  <Plus size={12} aria-hidden="true" /> {tr('新建分组', 'New group')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onAction('create-subnet', null)} className="gap-2">
                  <Plus size={12} aria-hidden="true" /> {tr('新建网段', 'New range')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {loading && tree.roots.length === 0 ? (
          <p className="py-6 text-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</p>
        ) : tree.roots.length === 0 ? (
          <EmptyState
            title={tr('还没有地址空间', 'No address space yet')}
            hint={tr('先建一个分组，或直接建一个网段。', 'Create a group, or a range directly.')}
            action={
              canMutate ? (
                <Button variant="primary" size="sm" type="button" onClick={() => onAction('create-scope', null)}>
                  {tr('新建分组', 'New group')}
                </Button>
              ) : undefined
            }
          />
        ) : nodes.length === 0 ? (
          <p className="py-6 text-center text-xs text-text-muted">
            {tr('没有匹配的分组或网段', 'No group or range matches')}
          </p>
        ) : (
          <Tree
            key={`${needle}|${selectedID}`}
            nodes={nodes}
            label={tr('地址空间树', 'Address space tree')}
            selectedId={selectedID === 'all' ? undefined : selectedID}
            defaultExpanded={expanded}
            onSelect={(node) => selectNode(node.id)}
          />
        )}
      </div>
    </Card>
  );
}

function filterTree(
  nodes: IPAMNode[],
  needle: string,
  label: (node: IPAMNode | null | undefined) => string,
): IPAMNode[] {
  const out: IPAMNode[] = [];
  for (const node of nodes) {
    const children = filterTree(node.children ?? [], needle, label);
    const cidrMatch = String(node.cidr ?? '').toLowerCase().includes(needle);
    if (label(node).toLowerCase().includes(needle) || cidrMatch || children.length > 0) {
      out.push({ ...node, children });
    }
  }
  return out;
}

function convert(
  node: IPAMNode,
  label: (node: IPAMNode | null | undefined) => string,
  onAction: (action: NodeAction, node: IPAMNode) => void,
  canMutate: boolean,
  tr: (zh: string, en: string) => string,
): TreeNode {
  const subnet = isSubnet(node);
  const children = (node.children ?? []).map((child) => convert(child, label, onAction, canMutate, tr));
  const count = subnet ? cidrHostCount(node.cidr) : subtreeHostCount(node);
  const name = label(node);
  return {
    id: String(node._id),
    // THE FULL NAME ON HOVER. The rail is narrow and a long range name has to
    // truncate; the title is where the rest of it lives.
    label: <span title={name}>{name}</span>,
    icon: subnet ? (
      <Network size={13} className="text-text-faint" />
    ) : (
      <Folder size={13} className="text-text-muted" />
    ),
    trailing: count > 0 ? <span className="text-[10px] text-text-faint">{count}</span> : undefined,
    actions: (
      <NodeMenu
        node={node}
        subnet={subnet}
        disabled={!canMutate}
        onAction={(action) => onAction(action, node)}
        tr={tr}
      />
    ),
    children,
    hasChildren: children.length > 0,
  };
}

function NodeMenu({
  node,
  subnet,
  disabled,
  onAction,
  tr,
}: {
  node: IPAMNode;
  subnet: boolean;
  disabled: boolean;
  onAction(action: NodeAction): void;
  tr: (zh: string, en: string) => string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="plain"
            size="sm"
            type="button"
            disabled={disabled}
            aria-label={tr('节点操作', 'Node actions')}
            title={tr('节点操作', 'Node actions')}
            className="inline-flex size-6 items-center justify-center p-0 text-text-faint opacity-60 hover:text-text group-hover:opacity-100 focus-visible:opacity-100"
          />
        }
      >
        <MoreHorizontal size={13} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44 p-1">
        <DropdownMenuItem onClick={() => onAction('create-scope')} disabled={subnet} className="gap-2">
          <Plus size={12} aria-hidden="true" /> {tr('新建分组', 'New group')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction('create-subnet')} className="gap-2">
          <Plus size={12} aria-hidden="true" /> {tr('新建网段', 'New range')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction('edit')} className="gap-2">
          <Pencil size={12} aria-hidden="true" />
          {subnet ? tr('编辑网段', 'Edit range') : tr('重命名分组', 'Rename group')}
        </DropdownMenuItem>
        {subnet && (
          <DropdownMenuItem onClick={() => onAction('move')} className="gap-2">
            <MoveRight size={12} aria-hidden="true" /> {tr('移动网段', 'Move range')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onAction('delete')} className="gap-2 text-red-300">
          <Trash2 size={12} aria-hidden="true" /> {tr('删除', 'Delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
