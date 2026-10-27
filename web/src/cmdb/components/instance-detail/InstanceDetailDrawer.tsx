import { useEffect, useRef, useState } from 'react';
import { History, Info, Network, Pencil, X, Zap } from 'lucide-react';

import { Button } from '@/components/ui';
import { DialogDescription, DialogTitle } from '@/components/ui/Dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { listUsers, type User } from '@/api/users';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';
import { usePermissions } from '@/store/me';

import type { AttributeGroup, CIType, TypeAttribute } from '../../api/citype';
import { describeError } from '../../api/http';
import { getInstance, type Instance } from '../../api/instance';
import { choiceText } from '../../lib/choice-labels';
import { displayValue } from '../../lib/valuetype';
import { Drawer } from '../Drawer';
import { InstanceHistory } from './InstanceHistory';
import { InstanceOverview } from './InstanceOverview';
import { InstanceTopology } from './InstanceTopology';
import { InstanceTriggers } from './InstanceTriggers';

// One resource, read sideways.
//
// IT IS A DRAWER, NOT A ROUTE. Operators compare rows in the list while opening
// one; taking the list away would lose the comparison. The tabs are the four
// things an instance can answer from this service: its values, its relation
// neighbourhood, its own change log, and the triggers that fired for it.
//
// MONITORING AND PROMETHEUS ALERTS ARE ABSENT ON PURPOSE. cantor read those
// through its own common-setting integration; the Go service deliberately did
// not port that mapping, so a tab here would be a promise with no data behind
// it. The console's /monitor and /alerts pages remain the place for them.

type TabKey = 'overview' | 'topology' | 'history' | 'triggers';

export function InstanceDetailDrawer({
  model,
  models,
  attributes,
  groups,
  instanceID,
  initialTab = 'overview',
  onClose,
  onEdit,
}: {
  model: CIType;
  models: CIType[];
  attributes: TypeAttribute[];
  groups: AttributeGroup[];
  instanceID: number;
  initialTab?: TabKey;
  onClose(): void;
  onEdit(instanceID: number): void;
}) {
  const { tr } = useI18n();
  const { isAdmin } = usePermissions();
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [instance, setInstance] = useState<Instance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [users, setUsers] = useState<User[]>([]);
  const topRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    setInstance(null);
    void getInstance(instanceID)
      .then((got) => {
        if (live) setInstance(got);
      })
      .catch((err) => {
        if (live) setError(describeError(err, tr('无法读取实例', 'Could not load the instance')));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [instanceID, retryKey, tr]);

  // The user list is admin-only. A non-admin still gets the numeric uid rather
  // than an empty User column; a missing user is a label we cannot resolve, not
  // a reason to hide the change.
  const needsUsers = isAdmin && (tab === 'history' || tab === 'triggers');
  useEffect(() => {
    if (!needsUsers) return;
    let live = true;
    void listUsers()
      .then((got) => {
        if (live) setUsers(got.items ?? []);
      })
      .catch(() => {
        if (live) setUsers([]);
      });
    return () => {
      live = false;
    };
  }, [needsUsers]);

  // A tab change must start at its own top. The detail tab can be scrolled to
  // its relation table, and carrying that offset into the graph or history
  // would open the new view halfway down.
  useEffect(() => {
    topRef.current?.scrollIntoView?.({ block: 'start' });
  }, [tab]);

  const userLabel = (uid?: number): string => {
    if (!uid) return '—';
    const found = users.find((user) => user.id === uid);
    return found ? found.display_name || found.email || `#${uid}` : `#${uid}`;
  };

  const values = instance?.values ?? {};
  const uniqueValue = displayValue(values[model.unique_key ?? '']) || `#${instanceID}`;
  const nameAttribute =
    attributes.find((attribute) => attribute.name === model.show_name) ??
    attributes.find((attribute) => attribute.name === 'name') ??
    attributes.find((attribute) => attribute.name === model.unique_key) ??
    attributes[0];
  const displayName = displayValue(values[nameAttribute?.name ?? '']) || uniqueValue;
  const uniqueAttribute = attributes.find((attribute) => attribute.name === model.unique_key);
  const uniqueLabel = model.unique_key === 'uuid' ? 'UUID' : uniqueAttribute?.alias || model.unique_key || 'UUID';
  const showUnique = uniqueValue !== displayName && uniqueValue !== `#${instanceID}`;
  const statusAttribute =
    attributes.find((attribute) => attribute.name === 'data_status') ??
    attributes.find((attribute) => attribute.name === 'status') ??
    attributes.find((attribute) => attribute.name === 'state');
  const status = statusAttribute ? displayValue(values[statusAttribute.name]) : '';
  const statusLabel = statusAttribute ? choiceText(statusAttribute, values[statusAttribute.name]) ?? status : status;
  const statusLower = status.toLowerCase();
  const statusActive = ['active', 'online', 'enabled', 'running', 'normal', '启用', '正常'].includes(statusLower);
  const statusStopped = ['inactive', 'offline', 'disabled', 'error', '停用', '异常'].includes(statusLower);

  return (
    <Drawer
      open
      onClose={onClose}
      size="xl"
      title={displayName}
      header={
        <header className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {status && (
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium',
                    statusActive && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
                    statusStopped && 'bg-red-500/10 text-red-600 dark:text-red-300',
                    !statusActive && !statusStopped && 'bg-amber-500/10 text-amber-600 dark:text-amber-300',
                  )}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                  {statusLabel}
                </span>
              )}
              <span className="rounded-md bg-bg/70 px-2 py-0.5 font-mono text-xs text-text-muted">
                #{instanceID}
              </span>
            </div>
            <DialogTitle className="mt-3 break-words text-xl font-semibold leading-snug text-text">
              {displayName}
            </DialogTitle>
            {showUnique && (
              <DialogDescription className="mt-1 break-all font-mono text-xs text-text-muted">
                {uniqueLabel}: {uniqueValue}
              </DialogDescription>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={tr('关闭', 'Close')}
            className="shrink-0 rounded p-1 text-text-faint hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </header>
      }
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] text-text-faint">
            {tr('只读视图；编辑会打开表单并保留当前列表。', 'Read-only view; Edit opens the form without losing the list.')}
          </span>
          <Button variant="primary" type="button" onClick={() => onEdit(instanceID)} className="inline-flex items-center gap-1.5">
            <Pencil size={12} aria-hidden="true" />
            {tr('编辑', 'Edit')}
          </Button>
        </div>
      }
    >
      <Tabs value={tab} onValueChange={(next) => setTab(next as TabKey)}>
        <div ref={topRef} />
        <TabsList
          aria-label={tr('资源详情视图', 'Resource detail views')}
          className="cmdb-instance-drawer-tabs sticky top-0 z-10 mb-4 bg-card"
        >
          <TabsTrigger value="overview">
            <Info size={14} aria-hidden="true" />
            {tr('详情', 'Details')}
          </TabsTrigger>
          <TabsTrigger value="topology">
            <Network size={14} aria-hidden="true" />
            {tr('拓扑', 'Topology')}
          </TabsTrigger>
          <TabsTrigger value="history">
            <History size={14} aria-hidden="true" />
            {tr('变更历史', 'History')}
          </TabsTrigger>
          <TabsTrigger value="triggers">
            <Zap size={14} aria-hidden="true" />
            {tr('触发记录', 'Triggers')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          {tab === 'overview' && (
            <InstanceOverview
              model={model}
              models={models}
              instance={instance}
              attributes={attributes}
              groups={groups}
              loading={loading}
              error={error}
              onRetry={() => setRetryKey((key) => key + 1)}
            />
          )}
        </TabsContent>
        <TabsContent value="topology" className="mt-4">
          {tab === 'topology' && (
            <InstanceTopology
              model={model}
              attributes={attributes}
              instance={instance}
              instanceID={instanceID}
              instanceLabel={uniqueValue}
            />
          )}
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          {tab === 'history' && <InstanceHistory ciID={instanceID} userLabel={userLabel} />}
        </TabsContent>
        <TabsContent value="triggers" className="mt-4">
          {tab === 'triggers' && <InstanceTriggers ciID={instanceID} userLabel={userLabel} />}
        </TabsContent>
      </Tabs>
    </Drawer>
  );
}
