import { useEffect, useMemo, useState } from 'react';
import { useCMDBAssistantFacts } from '../lib/assistantFacts';
import { useSearchParams } from 'react-router-dom';
import { ListTree, Loader2, RefreshCw, ShieldAlert, Table2 } from 'lucide-react';

import { Button } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { PaginationFooter } from '@/components/ui/PaginationFooter';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { useI18n } from '@/i18n/locale';
import { usePermissions } from '@/store/me';
import { fullDateTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { listUsers, type User } from '@/api/users';

import { listCITypes, type CIType } from '../api/citype';
import { describeError } from '../api/http';
import {
  listAttributeHistory,
  listRelationHistory,
  listTriggerHistory,
  listTypeHistory,
  type AttributeRecord,
  type HistoryFilter,
  type RelationRecord,
  type TriggerHistoryItem,
  type TypeHistoryItem,
} from '../api/history';
import { DataTable, type Column } from '../components/DataTable';
import {
  EMPTY_FILTERS,
  HistoryFilters,
  toAPITime,
  type FilterState,
  type OperateOption,
} from '../components/history/HistoryFilters';
import { HistoryRecordDrawer, type HistorySelection } from '../components/history/HistoryRecordDrawer';
import { HistoryTimeline, type HistoryTimelineEntry } from '../components/history/HistoryTimeline';

// 操作历史 — what changed, who changed it, and why.
//
// THE PAGE IS ADMIN-ONLY because the global reads span every model and every
// user; the per-instance endpoints are available to any caller and are used
// from an instance's own page. The console hides the page rather than showing a
// list that would 403.
//
// THE USER COLUMN IS MAPPED CLIENT-SIDE. The CMDB service does not read the IAM
// database, so a history row carries a numeric uid; the admin-only user list is
// already here for the filter, and an id it cannot resolve is shown as `#uid`
// rather than hidden.

const PAGE_SIZE = 20;

type Tab = 'attributes' | 'relations' | 'types' | 'triggers';

/** Two renders of the same result page; the query does not depend on it. */
type ResultView = 'table' | 'timeline';

type RowCount = { shown: number; total: number };

function idOrUndefined(value: string): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export default function OperationHistoryPage() {
  const { tr } = useI18n();
  const { isAdmin } = usePermissions();

  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>('attributes');
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  // The view is a reading preference, so it belongs in the URL: a shared or
  // refreshed link keeps the timeline the sender was looking at.
  const view: ResultView = params.get('view') === 'timeline' ? 'timeline' : 'table';
  const setView = (next: ResultView) => {
    const copy = new URLSearchParams(params);
    if (next === 'timeline') copy.set('view', 'timeline');
    else copy.delete('view');
    setParams(copy, { replace: true });
  };
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [count, setCount] = useState<RowCount>({ shown: 0, total: 0 });
  const [reloadKey, setReloadKey] = useState(0);

  const [users, setUsers] = useState<User[]>([]);
  const [models, setModels] = useState<CIType[]>([]);

  const [attributeRows, setAttributeRows] = useState<AttributeRecord[]>([]);
  const [relationRows, setRelationRows] = useState<RelationRecord[]>([]);
  const [typeRows, setTypeRows] = useState<TypeHistoryItem[]>([]);
  const [triggerRows, setTriggerRows] = useState<TriggerHistoryItem[]>([]);
  const [selection, setSelection] = useState<HistorySelection | null>(null);
  useCMDBAssistantFacts({
    tab,
    page,
    start: filters.start,
    end: filters.end,
    uid: filters.uid,
    type_id: filters.typeID,
    operate: filters.operate,
    shown: count.shown,
    total: count.total,
  });

  useEffect(() => {
    if (!isAdmin) return;
    void listUsers()
      .then((got) => setUsers(got.items ?? []))
      .catch(() => setUsers([]));
    void listCITypes()
      .then(setModels)
      .catch(() => setModels([]));
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    let live = true;
    setLoading(true);
    setErr(null);
    const filter: HistoryFilter = {
      start: toAPITime(filters.start),
      end: toAPITime(filters.end),
      uid: idOrUndefined(filters.uid),
      type_id: idOrUndefined(filters.typeID),
      operate_type: filters.operate || undefined,
      page,
      page_size: PAGE_SIZE,
    };
    const load = async () => {
      switch (tab) {
        case 'attributes': {
          const got = await listAttributeHistory(filter);
          if (!live) return;
          setAttributeRows(got.items ?? []);
          setCount({ shown: got.items?.length ?? 0, total: got.total ?? 0 });
          break;
        }
        case 'relations': {
          const got = await listRelationHistory(filter);
          if (!live) return;
          setRelationRows(got.items ?? []);
          setCount({ shown: got.items?.length ?? 0, total: got.total ?? 0 });
          break;
        }
        case 'types': {
          const got = await listTypeHistory(filter);
          if (!live) return;
          setTypeRows(got.items ?? []);
          setCount({ shown: got.items?.length ?? 0, total: got.total ?? 0 });
          break;
        }
        case 'triggers': {
          const got = await listTriggerHistory(filter);
          if (!live) return;
          setTriggerRows(got.items ?? []);
          setCount({ shown: got.items?.length ?? 0, total: got.total ?? 0 });
          break;
        }
      }
    };
    void load()
      .catch((error) => {
        if (live) setErr(describeError(error, tr('无法读取操作历史', 'Could not load the operation history')));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [isAdmin, tab, filters, page, reloadKey, tr]);

  const userLabel = (uid?: number): string => {
    if (!uid) return '—';
    const found = users.find((user) => user.id === uid);
    return found ? found.display_name || found.email : `#${uid}`;
  };

  const operateLabel = (value?: string): string => {
    if (tab === 'types') {
      switch (value) {
        case '0': return tr('新增模型', 'Model added');
        case '1': return tr('修改模型', 'Model changed');
        case '2': return tr('删除模型', 'Model deleted');
        case '3': return tr('新增属性', 'Attribute added');
        case '4': return tr('修改属性', 'Attribute changed');
        case '5': return tr('删除属性', 'Attribute deleted');
        case '6': return tr('新增触发器', 'Trigger added');
        case '7': return tr('修改触发器', 'Trigger changed');
        case '8': return tr('删除触发器', 'Trigger deleted');
        default: return value || '—';
      }
    }
    switch (value) {
      case '0': return tr('新增', 'Added');
      case '1': return tr('删除', 'Deleted');
      case '2': return tr('修改', 'Updated');
      default: return '—';
    }
  };

  // Adds read as green and deletes as red in both views; the model types tab
  // spells its actions with a wider code range than the other three.
  const operateTone = (value?: string): 'default' | 'success' | 'danger' => {
    if (!value) return 'default';
    const adds = tab === 'types' ? ['0', '3', '6'] : ['0'];
    const removes = tab === 'types' ? ['2', '5', '8'] : ['1'];
    if (adds.includes(value)) return 'success';
    if (removes.includes(value)) return 'danger';
    return 'default';
  };

  const renderAttributeChanges = (row: AttributeRecord) => (
    <>
      {row.changes.slice(0, 3).map((change) => (
        <div key={change.id} className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="font-medium text-text">{change.attr_alias || change.attr_name || `#${change.attr_id}`}</span>
          <code className="rounded bg-zinc-900/60 px-1 py-0.5 font-mono text-text-muted">{change.old || '—'}</code>
          <span className="text-text-faint">→</span>
          <code className="rounded bg-zinc-900/60 px-1 py-0.5 font-mono text-emerald-300">{change.new || '—'}</code>
          <span className="text-text-faint">#{change.ci_id}</span>
        </div>
      ))}
      {row.changes.length > 3 && (
        <span className="text-[11px] text-text-faint">
          {tr(`另有 ${row.changes.length - 3} 项`, `${row.changes.length - 3} more`)}
        </span>
      )}
    </>
  );

  const timelineEntries: HistoryTimelineEntry[] = (() => {
    switch (tab) {
      case 'attributes':
        return attributeRows.map((row) => ({
          key: row.record_id,
          createdAt: row.created_at,
          user: userLabel(row.uid),
          entity: row.type_alias || row.type_name || `#${row.type_id ?? ''}`,
          action: operateLabel(row.changes[0]?.operate_type),
          actionTone: operateTone(row.changes[0]?.operate_type),
          changes: renderAttributeChanges(row),
          detailLabel: tr(`查看详情 ${row.record_id}`, `View details for ${row.record_id}`),
          onOpen: () => setSelection({ kind: 'attributes', record: row }),
        }));
      case 'relations':
        return relationRows.map((row) => {
          const change = row.changes[0];
          return {
            key: row.record_id,
            createdAt: row.created_at,
            user: userLabel(row.uid),
            entity: row.type_alias || row.type_name || `#${row.type_id ?? ''}`,
            action: operateLabel(change?.operate_type),
            actionTone: operateTone(change?.operate_type),
            changes: change ? (
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <code className="rounded bg-zinc-900/60 px-1 py-0.5 font-mono text-text-muted">
                  {change.first_ci_name || `#${change.first_ci_id ?? ''}`}
                </code>
                <span className="text-text-faint">→</span>
                <code className="rounded bg-zinc-900/60 px-1 py-0.5 font-mono text-text-muted">
                  {change.second_ci_name || `#${change.second_ci_id ?? ''}`}
                </code>
                <Chip dense>{`#${change.relation_type_id ?? '—'}`}</Chip>
              </div>
            ) : '—',
            detailLabel: tr(`查看详情 ${row.record_id}`, `View details for ${row.record_id}`),
            onOpen: () => setSelection({ kind: 'relations', record: row }),
          };
        });
      case 'types':
        return typeRows.map((row) => ({
          key: row.id,
          createdAt: row.created_at,
          user: userLabel(row.uid),
          entity: row.type_alias || row.type_name || `#${row.type_id}`,
          action: operateLabel(row.operate_type),
          actionTone: operateTone(row.operate_type),
          changes: (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="font-medium text-text">{row.attr_alias || row.attr_name || '—'}</span>
              <code className="block max-w-[28rem] truncate rounded bg-zinc-900/60 px-1 py-0.5 font-mono text-[10px] text-text-muted">
                {row.change ? JSON.stringify(row.change) : '—'}
              </code>
            </div>
          ),
          detailLabel: tr(`查看详情 ${row.id}`, `View details for ${row.id}`),
          onOpen: () => setSelection({ kind: 'types', item: row }),
        }));
      case 'triggers':
        return triggerRows.map((row) => ({
          key: row.id,
          createdAt: row.created_at,
          user: userLabel(row.uid),
          entity: row.ci_name || `#${row.ci_id}`,
          action: operateLabel(row.operate_type),
          actionTone: operateTone(row.operate_type),
          changes: (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="font-medium text-text">{row.trigger_name || `#${row.trigger_id ?? ''}`}</span>
              <Chip tone={row.is_ok ? 'success' : 'warning'} dense>
                {row.is_ok ? tr('成功', 'Succeeded') : tr('失败', 'Failed')}
              </Chip>
            </div>
          ),
          detailLabel: tr(`查看详情 ${row.id}`, `View details for ${row.id}`),
          onOpen: () => setSelection({ kind: 'triggers', item: row }),
        }));
    }
  })();

  const emptyMessage =
    tab === 'attributes'
      ? tr('没有匹配的属性变更', 'No attribute change matches')
      : tab === 'relations'
        ? tr('没有匹配的关系变更', 'No relation change matches')
        : tab === 'types'
          ? tr('没有匹配的模型变更', 'No model change matches')
          : tr('没有匹配的触发器执行', 'No trigger firing matches');

  const operateOptions = useMemo<OperateOption[]>(() => {
    if (tab === 'types') {
      return [
        { value: '0', label: tr('新增模型', 'Model added') },
        { value: '1', label: tr('修改模型', 'Model changed') },
        { value: '2', label: tr('删除模型', 'Model deleted') },
        { value: '3', label: tr('新增属性', 'Attribute added') },
        { value: '4', label: tr('修改属性', 'Attribute changed') },
        { value: '5', label: tr('删除属性', 'Attribute deleted') },
        { value: '6', label: tr('新增触发器', 'Trigger added') },
        { value: '7', label: tr('修改触发器', 'Trigger changed') },
        { value: '8', label: tr('删除触发器', 'Trigger deleted') },
      ];
    }
    return [
      { value: '0', label: tr('新增', 'Added') },
      { value: '2', label: tr('修改', 'Updated') },
      { value: '1', label: tr('删除', 'Deleted') },
    ];
  }, [tab, tr]);

  const attributeColumns: Column<AttributeRecord>[] = [
    {
      key: 'time', header: tr('时间', 'Time'), width: 'w-[11rem]',
      cell: (row) => <code className="whitespace-nowrap font-mono text-[11px] text-text-muted">{fullDateTime(row.created_at)}</code>,
    },
    { key: 'user', header: tr('用户', 'User'), width: 'w-[7rem]', cell: (row) => <span className="whitespace-nowrap">{userLabel(row.uid)}</span> },
    { key: 'type', header: tr('模型', 'Model'), width: 'w-[9rem]', cell: (row) => <span className="whitespace-nowrap">{row.type_alias || row.type_name || `#${row.type_id ?? ''}`}</span> },
    {
      key: 'changes', header: tr('变更', 'Changes'), width: 'w-full',
      cell: (row) => <div className="flex flex-col gap-0.5">{renderAttributeChanges(row)}</div>,
    },
    {
      key: 'operate', header: tr('操作', 'Action'), width: 'w-[6rem]',
      cell: (row) => <Chip tone={operateTone(row.changes[0]?.operate_type)}>{operateLabel(row.changes[0]?.operate_type)}</Chip>,
    },
    {
      key: 'detail', header: tr('详情', 'Details'), width: 'w-px',
      cell: (row) => (
        <Button
          variant="subtle" size="sm" type="button"
          onClick={() => setSelection({ kind: 'attributes', record: row })}
          aria-label={tr(`查看详情 ${row.record_id}`, `View details for ${row.record_id}`)}
        >
          {tr('详情', 'Details')}
        </Button>
      ),
    },
  ];

  const relationColumns: Column<RelationRecord>[] = [
    {
      key: 'time', header: tr('时间', 'Time'), width: 'w-[11rem]',
      cell: (row) => <code className="whitespace-nowrap font-mono text-[11px] text-text-muted">{fullDateTime(row.created_at)}</code>,
    },
    { key: 'user', header: tr('用户', 'User'), width: 'w-[7rem]', cell: (row) => <span className="whitespace-nowrap">{userLabel(row.uid)}</span> },
    { key: 'type', header: tr('模型', 'Model'), width: 'w-[9rem]', cell: (row) => <span className="whitespace-nowrap">{row.type_alias || row.type_name || `#${row.type_id ?? ''}`}</span> },
    {
      key: 'first', header: tr('第一端', 'First'), width: 'w-[12rem]',
      cell: (row) => <span className="block max-w-[12rem] truncate">{row.changes[0]?.first_ci_name || `#${row.changes[0]?.first_ci_id ?? ''}`}</span>,
    },
    {
      key: 'second', header: tr('第二端', 'Second'), width: 'w-[12rem]',
      cell: (row) => <span className="block max-w-[12rem] truncate">{row.changes[0]?.second_ci_name || `#${row.changes[0]?.second_ci_id ?? ''}`}</span>,
    },
    {
      key: 'relation', header: tr('关系类型', 'Relation type'), width: 'w-[8rem]',
      cell: (row) => <Chip>{`#${row.changes[0]?.relation_type_id ?? '—'}`}</Chip>,
    },
    {
      key: 'operate', header: tr('操作', 'Action'), width: 'w-[6rem]',
      cell: (row) => <Chip tone={operateTone(row.changes[0]?.operate_type)}>{operateLabel(row.changes[0]?.operate_type)}</Chip>,
    },
    {
      key: 'detail', header: tr('详情', 'Details'), width: 'w-px',
      cell: (row) => (
        <Button
          variant="subtle" size="sm" type="button"
          onClick={() => setSelection({ kind: 'relations', record: row })}
          aria-label={tr(`查看详情 ${row.record_id}`, `View details for ${row.record_id}`)}
        >
          {tr('详情', 'Details')}
        </Button>
      ),
    },
  ];

  const typeColumns: Column<TypeHistoryItem>[] = [
    {
      key: 'time', header: tr('时间', 'Time'), width: 'w-[11rem]',
      cell: (row) => <code className="whitespace-nowrap font-mono text-[11px] text-text-muted">{fullDateTime(row.created_at)}</code>,
    },
    { key: 'user', header: tr('用户', 'User'), width: 'w-[7rem]', cell: (row) => <span className="whitespace-nowrap">{userLabel(row.uid)}</span> },
    { key: 'type', header: tr('模型', 'Model'), width: 'w-[9rem]', cell: (row) => <span className="whitespace-nowrap">{row.type_alias || row.type_name || `#${row.type_id}`}</span> },
    { key: 'attr', header: tr('属性', 'Attribute'), width: 'w-[9rem]', cell: (row) => <span className="whitespace-nowrap">{row.attr_alias || row.attr_name || '—'}</span> },
    {
      key: 'change', header: tr('变更', 'Change'), width: 'w-full',
      cell: (row) => (
        <code className="block max-w-[28rem] truncate font-mono text-[11px] text-text-muted">
          {row.change ? JSON.stringify(row.change) : '—'}
        </code>
      ),
    },
    {
      key: 'operate', header: tr('操作', 'Action'), width: 'w-[6rem]',
      cell: (row) => <Chip tone={operateTone(row.operate_type)}>{operateLabel(row.operate_type)}</Chip>,
    },
    {
      key: 'detail', header: tr('详情', 'Details'), width: 'w-px',
      cell: (row) => (
        <Button
          variant="subtle" size="sm" type="button"
          onClick={() => setSelection({ kind: 'types', item: row })}
          aria-label={tr(`查看详情 ${row.id}`, `View details for ${row.id}`)}
        >
          {tr('详情', 'Details')}
        </Button>
      ),
    },
  ];

  const triggerColumns: Column<TriggerHistoryItem>[] = [
    {
      key: 'time', header: tr('时间', 'Time'), width: 'w-[11rem]',
      cell: (row) => <code className="whitespace-nowrap font-mono text-[11px] text-text-muted">{fullDateTime(row.created_at)}</code>,
    },
    { key: 'user', header: tr('用户', 'User'), width: 'w-[7rem]', cell: (row) => <span className="whitespace-nowrap">{userLabel(row.uid)}</span> },
    { key: 'ci', header: tr('资源', 'Instance'), width: 'w-[12rem]', cell: (row) => <span className="block max-w-[12rem] truncate">{row.ci_name || `#${row.ci_id}`}</span> },
    { key: 'trigger', header: tr('触发器', 'Trigger'), width: 'w-[12rem]', cell: (row) => <span className="block max-w-[12rem] truncate">{row.trigger_name || `#${row.trigger_id ?? ''}`}</span> },
    {
      key: 'result', header: tr('结果', 'Result'), width: 'w-[7rem]',
      cell: (row) => row.is_ok ? <Chip tone="success">{tr('成功', 'Succeeded')}</Chip> : <Chip tone="warning">{tr('失败', 'Failed')}</Chip>,
    },
    {
      key: 'operate', header: tr('操作', 'Action'), width: 'w-[6rem]',
      cell: (row) => <Chip tone={operateTone(row.operate_type)}>{operateLabel(row.operate_type)}</Chip>,
    },
    {
      key: 'detail', header: tr('详情', 'Details'), width: 'w-px',
      cell: (row) => (
        <Button
          variant="subtle" size="sm" type="button"
          onClick={() => setSelection({ kind: 'triggers', item: row })}
          aria-label={tr(`查看详情 ${row.id}`, `View details for ${row.id}`)}
        >
          {tr('详情', 'Details')}
        </Button>
      ),
    },
  ];

  const changeTab = (next: Tab) => {
    setTab(next);
    setFilters((current) => ({ ...current, operate: '' }));
    setPage(1);
  };

  if (!isAdmin) {
    return (
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
        <PageHeader
          title={tr('操作历史', 'Operation history')}
          subtitle={tr('全局变更记录。', 'Every write across the estate.')}
        />
        <div className="p-6">
          <Card>
            <EmptyState
              icon={ShieldAlert}
              title={tr('需要管理员权限', 'Administrator role required')}
              hint={tr('全局操作历史包含所有模型与用户的变更。', 'The global history spans every model and every user.')}
            />
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <PageHeader
        title={tr('操作历史', 'Operation history')}
        subtitle={tr(
          '模型变更、属性变更、关系变更与触发器执行的记录。按时间、用户、模型和操作过滤。',
          'Model, attribute, relation and trigger changes, filtered by time, user, model and action.',
        )}
        actions={
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => setReloadKey((current) => current + 1)}
            disabled={loading}
            className="inline-flex items-center gap-1.5"
          >
            <RefreshCw size={12} className={cn(loading && 'animate-spin')} aria-hidden="true" />
            {tr('刷新', 'Refresh')}
          </Button>
        }
      />

      <Tabs
        value={tab}
        onValueChange={(value) => changeTab(value as Tab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="mx-6 mt-4 shrink-0">
          <TabsTrigger value="attributes">{tr('属性变更', 'Attributes')}</TabsTrigger>
          <TabsTrigger value="relations">{tr('关系变更', 'Relations')}</TabsTrigger>
          <TabsTrigger value="types">{tr('模型变更', 'Models')}</TabsTrigger>
          <TabsTrigger value="triggers">{tr('触发器', 'Triggers')}</TabsTrigger>
        </TabsList>

        <TabsContent value={tab} className="flex min-h-0 flex-1 flex-col">
          <HistoryFilters
            value={filters}
            models={models}
            users={users}
            operateOptions={operateOptions}
            onChange={(next) => {
              setFilters(next);
              setPage(1);
            }}
            onReset={() => {
              setFilters(EMPTY_FILTERS);
              setPage(1);
            }}
          />

          <div className="flex min-h-0 flex-1 flex-col p-4">
            {err && (
              <div
                role="alert"
                className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300"
              >
                <span className="min-w-0 flex-1 break-words">{err}</span>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => setReloadKey((current) => current + 1)}
                >
                  <RefreshCw size={12} aria-hidden="true" />
                  {tr('重试', 'Retry')}
                </Button>
              </div>
            )}

            <section className="flex min-h-[20rem] flex-1 flex-col overflow-hidden rounded-xl border border-border/60 bg-card/40">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-medium text-text">{tr('变更记录', 'Changes')}</h2>
                  <span className="rounded-full bg-text/10 px-1.5 py-0.5 text-[10px] leading-none text-text-muted">
                    {count.total}
                  </span>
                  {loading && <Loader2 size={12} className="animate-spin text-text-faint" aria-hidden="true" />}
                </div>
                <div
                  role="group"
                  aria-label={tr('结果视图', 'Result view')}
                  className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
                >
                  <button
                    type="button"
                    aria-pressed={view === 'table'}
                    onClick={() => setView('table')}
                    className={cn(
                      'inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500',
                      view === 'table'
                        ? 'bg-text/10 font-medium text-text'
                        : 'text-text-muted hover:bg-text/5 hover:text-text',
                    )}
                  >
                    <Table2 size={12} aria-hidden="true" />
                    {tr('表格', 'Table')}
                  </button>
                  <button
                    type="button"
                    aria-pressed={view === 'timeline'}
                    onClick={() => setView('timeline')}
                    className={cn(
                      'inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500',
                      view === 'timeline'
                        ? 'bg-text/10 font-medium text-text'
                        : 'text-text-muted hover:bg-text/5 hover:text-text',
                    )}
                  >
                    <ListTree size={12} aria-hidden="true" />
                    {tr('时间线', 'Timeline')}
                  </button>
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col px-4 pb-0 pt-2">
                {view === 'table' ? (
                  <>
                    {tab === 'attributes' && (
                      <DataTable
                        fill
                        columns={attributeColumns}
                        rows={attributeRows}
                        rowKey={(row) => row.record_id}
                        loading={loading}
                        storageKey="history-attributes"
                        empty={emptyMessage}
                      />
                    )}
                    {tab === 'relations' && (
                      <DataTable
                        fill
                        columns={relationColumns}
                        rows={relationRows}
                        rowKey={(row) => row.record_id}
                        loading={loading}
                        storageKey="history-relations"
                        empty={emptyMessage}
                      />
                    )}
                    {tab === 'types' && (
                      <DataTable
                        fill
                        columns={typeColumns}
                        rows={typeRows}
                        rowKey={(row) => row.id}
                        loading={loading}
                        storageKey="history-types"
                        empty={emptyMessage}
                      />
                    )}
                    {tab === 'triggers' && (
                      <DataTable
                        fill
                        columns={triggerColumns}
                        rows={triggerRows}
                        rowKey={(row) => row.id}
                        loading={loading}
                        storageKey="history-triggers"
                        empty={emptyMessage}
                      />
                    )}
                  </>
                ) : (
                  <HistoryTimeline entries={timelineEntries} loading={loading} empty={emptyMessage} />
                )}
              </div>

              <PaginationFooter
                embedded
                page={page - 1}
                pageSize={PAGE_SIZE}
                shown={count.shown}
                total={count.total}
                loading={loading}
                onPageChange={(next) => setPage(next + 1)}
              />
            </section>
          </div>
        </TabsContent>
      </Tabs>

      <HistoryRecordDrawer selection={selection} userLabel={userLabel} onClose={() => setSelection(null)} />
    </div>
  );
}
