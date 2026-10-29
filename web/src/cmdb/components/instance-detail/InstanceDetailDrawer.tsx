import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clock3, Fingerprint, Hash, History, Info, Network, Pencil, UserRound, X, Zap } from 'lucide-react';

import { Button } from '@/components/ui';
import { Chip } from '@/components/ui/Chip';
import { DialogDescription, DialogTitle } from '@/components/ui/Dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { listUsers, type User } from '@/api/users';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';
import { usePermissions } from '@/store/me';

import type { AttributeGroup, CIType, TypeAttribute } from '../../api/citype';
import { listAttributeGroups, listCITypes, listTypeAttributes } from '../../api/citype';
import { describeError } from '../../api/http';
import { getInstance, updateInstance, type Instance } from '../../api/instance';
import { getInstanceFileValues } from '../../api/files';
import { choiceText } from '../../lib/choice-labels';
import { displayValue } from '../../lib/valuetype';
import { CMDBIcon } from '../CMDBIcon';
import { Drawer } from '../Drawer';
import { useToast } from '../Toast';
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

// A topology node opened from the drawer becomes the drawer's new subject.
// Cantor switched the whole detail panel to the double-clicked CI and kept the
// topology tab active; the same switch happens here, resolving the target
// model's metadata on first visit so a cross-model jump still has labels and
// form sections.
type Subject = {
  id: number;
  model: CIType;
  attributes: TypeAttribute[];
  groups: AttributeGroup[];
};

export function InstanceDetailDrawer({
  model,
  models,
  attributes,
  groups,
  instanceID,
  initialTab = 'overview',
  onClose,
  onEdit,
  onInstanceSaved,
}: {
  model: CIType;
  models: CIType[];
  attributes: TypeAttribute[];
  groups: AttributeGroup[];
  instanceID: number;
  initialTab?: TabKey;
  onClose(): void;
  /** Omit for a read-only peek opened from another resource. */
  onEdit?(instanceID: number): void;
  /** Lets the list or relation table behind the drawer refresh after an edit. */
  onInstanceSaved?(instanceID: number): void;
}) {
  const { tr } = useI18n();
  const { isAdmin } = usePermissions();
  const toast = useToast();
  const [tab, setTab] = useState<TabKey>(initialTab);
  // `nav` holds a subject opened from the topology; until then the props are
  // authoritative. The effect clears it when a different row/model is opened.
  const [nav, setNav] = useState<Subject | null>(null);
  const [navError, setNavError] = useState<string | null>(null);
  const metaCache = useRef(new Map<number, { attributes: TypeAttribute[]; groups: AttributeGroup[] }>());
  const navSeq = useRef(0);
  // The loaded instance is tagged with the subject it belongs to, so a switch
  // never paints the previous resource's values under the new title.
  const [loaded, setLoaded] = useState<{ id: number; instance: Instance } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [users, setUsers] = useState<User[]>([]);
  const topRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setNav(null);
    setNavError(null);
  }, [instanceID, model.id]);

  const subject = useMemo<Subject>(
    () => nav ?? { id: instanceID, model, attributes, groups },
    [nav, instanceID, model, attributes, groups],
  );
  const instance = loaded?.id === subject.id ? loaded.instance : null;

  useEffect(() => {
    let live = true;
    const id = subject.id;
    setLoading(true);
    setError(null);
    void Promise.all([
      getInstance(id),
      // File values are deliberately omitted from the ordinary instance read;
      // fetch them separately so an existing attachment list is not replaced
      // with an empty form on the next save.
      getInstanceFileValues(id).catch(() => ({}) as Record<string, string>),
    ])
      .then(([got, files]) => {
        if (live) setLoaded({ id, instance: { ...got, values: { ...got.values, ...files } } });
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
  }, [subject.id, retryKey, tr]);

  // Same-model targets reuse the metadata already on screen; a cross-model
  // jump fetches the target's attributes and sections once per drawer.
  const openNode = useCallback(
    async (target: { ciID: number; typeID: number }) => {
      if (Number(target.ciID) === Number(subject.id)) return;
      const seq = ++navSeq.current;
      setNavError(null);
      if (Number(target.typeID) === Number(subject.model.id)) {
        setNav({ id: target.ciID, model: subject.model, attributes: subject.attributes, groups: subject.groups });
        setTab('topology');
        return;
      }
      try {
        const found = models.find((item) => Number(item.id) === Number(target.typeID))
          ?? (await listCITypes({ ids: String(target.typeID) })).find(
            (item) => Number(item.id) === Number(target.typeID),
          );
        if (!found) {
          if (navSeq.current === seq) {
            setNavError(tr('找不到目标模型，无法切换资源。', 'The target model could not be found.'));
          }
          return;
        }
        let meta = metaCache.current.get(found.id);
        if (!meta) {
          const [attrs, sections] = await Promise.all([
            listTypeAttributes(found.name),
            listAttributeGroups(found.name, false).catch(() => [] as AttributeGroup[]),
          ]);
          meta = { attributes: attrs.attributes ?? [], groups: sections };
          metaCache.current.set(found.id, meta);
        }
        if (navSeq.current !== seq) return;
        setNav({ id: target.ciID, model: found, attributes: meta.attributes, groups: meta.groups });
        setTab('topology');
      } catch (err) {
        if (navSeq.current === seq) {
          setNavError(describeError(err, tr('无法打开关联资源', 'Could not open the related resource')));
        }
      }
    },
    [models, subject, tr],
  );

  // An inline save writes ONE attribute; the usecase normalises only the keys
  // supplied, so the rest of the instance is untouched. The local value updates
  // immediately, then a quiet refresh picks up computed attributes without
  // turning a failed refresh into a false save failure.
  const saveAttribute = useCallback(
    async (name: string, value: unknown) => {
      const target = subject.id;
      await updateInstance(target, { values: { [name]: value } });
      setLoaded((current) =>
        current && current.id === target
          ? {
              id: target,
              instance: { ...current.instance, values: { ...current.instance.values, [name]: value } },
            }
          : current,
      );
      toast.success(tr('已保存', 'Saved'));
      onInstanceSaved?.(target);
      void Promise.all([
        getInstance(target),
        getInstanceFileValues(target).catch(() => ({}) as Record<string, string>),
      ])
        .then(([got, files]) => {
          setLoaded((current) =>
            current && current.id === target
              ? { id: target, instance: { ...got, values: { ...got.values, ...files } } }
              : current,
          );
        })
        .catch(() => undefined);
    },
    [onInstanceSaved, subject.id, toast, tr],
  );

  // The user list is admin-only. A non-admin still gets the numeric uid rather
  // than an empty User column; a missing user is a label we cannot resolve, not
  // a reason to hide the change. The header needs it too when the stored
  // updater is an email written by this service.
  const storedUpdater = instance?.updated_by ?? '';
  const needsUsers =
    isAdmin && (tab === 'history' || tab === 'triggers' || storedUpdater.includes('@'));
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
  }, [subject.id, tab]);

  const userLabel = (uid?: number): string => {
    if (!uid) return '—';
    const found = users.find((user) => user.id === uid);
    return found ? found.display_name || found.email || `#${uid}` : `#${uid}`;
  };

  const values = instance?.values ?? {};
  const uniqueValue = displayValue(values[subject.model.unique_key ?? '']) || `#${subject.id}`;
  const nameAttribute =
    subject.attributes.find((attribute) => attribute.name === subject.model.show_name) ??
    subject.attributes.find((attribute) => attribute.name === 'name') ??
    subject.attributes.find((attribute) => attribute.name === subject.model.unique_key) ??
    subject.attributes[0];
  const displayName = displayValue(values[nameAttribute?.name ?? '']) || uniqueValue;
  const uniqueAttribute = subject.attributes.find((attribute) => attribute.name === subject.model.unique_key);
  const uniqueLabel =
    subject.model.unique_key === 'uuid' ? 'UUID' : uniqueAttribute?.alias || subject.model.unique_key || 'UUID';
  const showUnique = uniqueValue !== displayName && uniqueValue !== `#${subject.id}`;
  const statusAttribute =
    subject.attributes.find((attribute) => attribute.name === 'data_status') ??
    subject.attributes.find((attribute) => attribute.name === 'status') ??
    subject.attributes.find((attribute) => attribute.name === 'state');
  const status = statusAttribute ? displayValue(values[statusAttribute.name]) : '';
  const statusLabel = statusAttribute ? choiceText(statusAttribute, values[statusAttribute.name]) ?? status : status;
  const statusLower = status.toLowerCase();
  const statusActive = ['active', 'online', 'enabled', 'running', 'normal', '启用', '正常'].includes(statusLower);
  const statusStopped = ['inactive', 'offline', 'disabled', 'error', '停用', '异常'].includes(statusLower);
  // Editing opens the page's form for the page's model, so it stays available
  // only while the drawer still shows that model; a cross-model jump is read-only.
  const canEdit = Boolean(onEdit) && Number(subject.model.id) === Number(model.id);
  const updatedAt = headerDateTime(instance?.updated_at);
  // cantor stored a nickname; this service writes the caller's email. Resolve
  // that email to the IAM display name when the viewer may read the user list,
  // and otherwise show what is stored rather than hiding the fact.
  const updatedByName = storedUpdater.includes('@')
    ? users.find((user) => user.email === storedUpdater)?.display_name || storedUpdater
    : storedUpdater;

  return (
    <Drawer
      open
      onClose={onClose}
      size="xl"
      title={displayName}
      header={
        <header className="flex items-start gap-3 px-5 pb-3 pt-4">
          {/* Model icon, name, type and status are one identity block; the
              second row is the instance's audit fingerprint. */}
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-card shadow-sm">
            <CMDBIcon
              value={subject.model.icon}
              size={24}
              label={subject.model.alias || subject.model.name}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle className="min-w-0 break-words text-xl font-semibold leading-snug text-text">
                {displayName}
              </DialogTitle>
              <Chip dense>{subject.model.alias || subject.model.name}</Chip>
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
            </div>
            <DialogDescription className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-muted">
              <span className="inline-flex items-center gap-1">
                <Hash size={12} className="shrink-0 text-text-faint" aria-hidden="true" />
                {tr('ID', 'ID')}: {subject.id}
              </span>
              {updatedAt && (
                <span className="inline-flex items-center gap-1">
                  <Clock3 size={12} className="shrink-0 text-text-faint" aria-hidden="true" />
                  {tr('更新时间', 'Updated')}: {updatedAt}
                </span>
              )}
              {updatedByName && (
                <span className="inline-flex items-center gap-1">
                  <UserRound size={12} className="shrink-0 text-text-faint" aria-hidden="true" />
                  {tr('更新人', 'Updated by')}: {updatedByName}
                </span>
              )}
              {showUnique && (
                <span className="inline-flex min-w-0 items-center gap-1" title={uniqueValue}>
                  <Fingerprint size={12} className="shrink-0 text-text-faint" aria-hidden="true" />
                  <span className="truncate font-mono">
                    {uniqueLabel}: {uniqueValue}
                  </span>
                </span>
              )}
            </DialogDescription>
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
        canEdit ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-text-faint">
              {tr(
                '字段旁的编辑图标可单独修改；完整表单保留当前列表。',
                'Use the pencil beside a field to change it in place; the full form keeps the current list.',
              )}
            </span>
            <Button variant="primary" type="button" onClick={() => onEdit?.(subject.id)} className="inline-flex items-center gap-1.5">
              <Pencil size={12} aria-hidden="true" />
              {tr('编辑', 'Edit')}
            </Button>
          </div>
        ) : undefined
      }
    >
      <Tabs value={tab} onValueChange={(next) => setTab(next as TabKey)}>
        <div ref={topRef} />
        {/* Sticky as a wrapper: the body's 1rem top padding must sit inside
            the opaque surface, or scrolled content peeks above the tabs. */}
        <div className="sticky -top-4 z-10 -mt-4 mb-4 bg-card">
          <TabsList
            aria-label={tr('资源详情视图', 'Resource detail views')}
            className="cmdb-instance-drawer-tabs bg-card pt-4"
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
        </div>

        <TabsContent value="overview" className="mt-4">
          {tab === 'overview' && (
            <InstanceOverview
              model={subject.model}
              models={models}
              instance={instance}
              attributes={subject.attributes}
              groups={subject.groups}
              loading={loading}
              error={error}
              onRetry={() => setRetryKey((key) => key + 1)}
              onSaveValue={saveAttribute}
            />
          )}
        </TabsContent>
        <TabsContent value="topology" className="mt-4">
          {tab === 'topology' && (
            <>
              {navError && (
                <div
                  role="alert"
                  className="mb-3 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300"
                >
                  {navError}
                </div>
              )}
              <InstanceTopology
                model={subject.model}
                attributes={subject.attributes}
                instance={instance}
                instanceID={subject.id}
                instanceLabel={uniqueValue}
                onNavigate={(target) => void openNode(target)}
              />
            </>
          )}
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          {tab === 'history' && <InstanceHistory ciID={subject.id} userLabel={userLabel} />}
        </TabsContent>
        <TabsContent value="triggers" className="mt-4">
          {tab === 'triggers' && <InstanceTriggers ciID={subject.id} userLabel={userLabel} />}
        </TabsContent>
      </Tabs>
    </Drawer>
  );
}

/**
 * The header's audit time, in the stored-looking `YYYY-MM-DD HH:mm:ss` form the
 * cantor detail page used. The API sends RFC 3339; `new Date` moves it to the
 * operator's zone, and the fixed shape keeps the header scannable in both
 * locales (unlike `toLocaleString`, whose separators change with the locale).
 */
function headerDateTime(raw?: string): string {
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  const pad = (part: number) => String(part).padStart(2, '0');
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(' ');
}
