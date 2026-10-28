import { useState } from 'react';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { PageHeader } from '@/components/ui/PageHeader';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { useI18n } from '@/i18n/locale';

import type { IPAMNode } from '../api/ipam';
import { isSubnet } from '../lib/ipam';
import { AddressesTab } from '../components/ipam/AddressesTab';
import { HistoryTab } from '../components/ipam/HistoryTab';
import { IpSearchTab } from '../components/ipam/IpSearchTab';
import { IpamTreePanel } from '../components/ipam/IpamTreePanel';
import { NodeDialogs, type DialogState } from '../components/ipam/Dialogs';
import { OverviewTab } from '../components/ipam/OverviewTab';
import { SubnetListTab } from '../components/ipam/SubnetListTab';
import { IPAMProvider, IPAM_TABS, useIPAM, type IPAMTab } from '../components/ipam/context';
import { useToast } from '../components/Toast';

export default function IPAMPage() {
  return (
    <IPAMProvider>
      <IPAMShell />
    </IPAMProvider>
  );
}

function IPAMShell() {
  const { tr } = useI18n();
  const toast = useToast();
  const {
    tree,
    loading,
    reload,
    selectedID,
    selectedNode,
    selectedIsSubnet,
    selectNode,
    tab,
    setTab,
    bump,
    canMutate,
    subnetTypeID,
  } = useIPAM();
  const [dialog, setDialog] = useState<DialogState | null>(null);

  const openCreate = (kind: 'scope' | 'subnet', parent: IPAMNode | null) => {
    // A group cannot sit inside a range: the range already names the space.
    if (kind === 'scope' && isSubnet(parent)) return;
    setDialog({ kind, mode: 'create', parent });
  };

  const onSaved = async (message: string) => {
    const deleted = dialog?.kind === 'delete' ? String(dialog.node._id) : null;
    setDialog(null);
    toast.success(message);
    await reload(true);
    if (deleted && selectedID === deleted) selectNode('all');
    bump();
  };

  const editNode = (node: IPAMNode) =>
    setDialog(
      isSubnet(node)
        ? { kind: 'subnet', mode: 'edit', node }
        : { kind: 'scope', mode: 'edit', node },
    );

  const newMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="primary"
            size="sm"
            type="button"
            disabled={!canMutate}
            className="inline-flex items-center gap-1.5 font-medium text-accent-fg"
          />
        }
      >
        <Plus size={12} aria-hidden="true" />
        {tr('新建', 'New')}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44 p-1">
        <DropdownMenuItem
          disabled={!canMutate || selectedIsSubnet}
          onClick={() => openCreate('scope', selectedNode)}
          className="gap-2"
        >
          {tr('新建分组', 'New group')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!canMutate}
          onClick={() => openCreate('subnet', selectedNode)}
          className="gap-2"
        >
          {tr('新建网段', 'New range')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <PageHeader
        title={tr('IP 地址空间', 'IP address space')}
        subtitle={tr(
          '分组 → 网段 → 地址。计数由服务端在地址变更的同一个事务里重算。',
          'Groups → ranges → addresses. Counters are recomputed server-side in the transaction that changes an address.',
        )}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => void reload(true)}
              disabled={loading}
              className="inline-flex items-center gap-1.5"
            >
              <RefreshCw size={12} aria-hidden="true" />
              {tr('刷新', 'Refresh')}
            </Button>
            {newMenu}
          </div>
        }
      />

      <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col items-start gap-4 overflow-y-auto p-6 lg:flex-row">
        <div className="w-full min-w-0 lg:w-72 lg:shrink-0">
          <IpamTreePanel
            onAction={(action, node) => {
              if (action === 'create-scope') openCreate('scope', node);
              else if (action === 'create-subnet') openCreate('subnet', node);
              else if (action === 'edit' && node) editNode(node);
              else if (action === 'move' && node) setDialog({ kind: 'move', node });
              else if (action === 'delete' && node) setDialog({ kind: 'delete', node });
            }}
          />
        </div>

        <Card className="w-full min-w-0 flex-1">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h2 className="truncate text-sm font-medium text-text">
                  {selectedNode ? tree.label(selectedNode) : tr('全部地址空间', 'The whole address space')}
                </h2>
                {selectedIsSubnet && <Chip tone="info">{String(selectedNode?.cidr ?? '')}</Chip>}
                {selectedNode && !selectedIsSubnet && <Chip>{tr('分组', 'Group')}</Chip>}
              </div>
              <p className="mt-1 text-[11px] text-text-faint">
                {selectedNode
                  ? tr(
                      '统计与地址按这个节点筛选；历史覆盖全部网段。',
                      'The summary and addresses are scoped to this node; history covers every range.',
                    )
                  : tr(
                      '没有选中节点时，总览与日志覆盖全部网段。',
                      'With nothing selected, the overview and logs cover every range.',
                    )}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {selectedNode && canMutate && (
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() =>
                    openCreate('subnet', selectedNode)
                  }
                >
                  {tr('在此新建', 'New here')}
                </Button>
              )}
              {selectedNode && canMutate && (
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => editNode(selectedNode)}
                  className="inline-flex items-center gap-1.5"
                >
                  <Pencil size={12} aria-hidden="true" />
                  {tr('编辑', 'Edit')}
                </Button>
              )}
              {selectedNode && canMutate && (
                <Button
                  variant="dangerGhost"
                  size="sm"
                  type="button"
                  onClick={() => setDialog({ kind: 'delete', node: selectedNode })}
                  aria-label={tr(`删除 ${tree.label(selectedNode)}`, `Delete ${tree.label(selectedNode)}`)}
                  title={tr('删除', 'Delete')}
                  className="inline-flex size-8 items-center justify-center p-0"
                >
                  <Trash2 size={12} aria-hidden="true" />
                </Button>
              )}
            </div>
          </div>

          <Tabs value={tab} onValueChange={(value) => setTab(value as IPAMTab)}>
            <TabsList className="mb-3 w-full flex-wrap">
              {IPAM_TABS.map((item) => (
                <TabsTrigger key={item.value} value={item.value} className="shrink-0 whitespace-nowrap">
                  {tr(item.zh, item.en)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {tab === 'overview' && (
            <OverviewTab
              onEdit={editNode}
              onDelete={(node) => setDialog({ kind: 'delete', node })}
              onOpenAddresses={(id) => {
                selectNode(String(id));
                setTab('address');
              }}
            />
          )}
          {tab === 'address' && <AddressesTab />}
          {tab === 'ipSearch' && <IpSearchTab />}
          {tab === 'subnet' && (
            <SubnetListTab
              onEdit={editNode}
              onDelete={(node) => setDialog({ kind: 'delete', node })}
              onOpenAddresses={(node) => {
                selectNode(String(node._id));
                setTab('address');
              }}
            />
          )}
          {tab === 'history' && <HistoryTab />}
        </Card>
      </div>

      <NodeDialogs state={dialog} onClose={() => setDialog(null)} onSaved={onSaved} />

      {!subnetTypeID && !loading && (
        <p className="px-6 pb-4 text-[11px] text-text-faint">
          {tr(
            '提示：这个部署还没有 ipam_subnet 模型。可以先用模型配置页或内置引导创建 IPAM 模型。',
            'Note: this deployment has no ipam_subnet model yet. Create the IPAM models from model configuration or the built-in bootstrap first.',
          )}
        </p>
      )}
    </div>
  );
}
