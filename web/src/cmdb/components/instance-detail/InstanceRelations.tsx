import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, GitBranch, LayoutGrid, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui';
import { Chip } from '@/components/ui/Chip';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import type { RelatedType } from '../../api/citype';
import { describeError } from '../../api/http';
import { relationChildren, relationParents } from '../../api/citype';
import { searchHierarchy, type SearchRow } from '../../api/instance';
import { isValueTypeCode } from '../../lib/valuetype';
import { AttributeValue } from '../AttributeControl';
import { CMDBIcon } from '../CMDBIcon';
import { DataTable, type Column } from '../DataTable';

// The relation summary under the detail attributes.
//
// THE MODEL GRAPH DECIDES WHICH TYPES CAN APPEAR; the hierarchy walk decides
// which rows actually do. Both are needed: the graph gives a stable sidebar
// (including types with a zero count), the walk gives today's instances.
//
// IT IS READ-ONLY. Adding and deleting relations changes the resource, so those
// actions stay on the model-relations page instead of living beside a scroll
// list where a stray click would edit an estate.

type Side = 'parent' | 'child';

type Group = {
  key: string;
  side: Side;
  related: RelatedType;
  rows: SearchRow[];
};

function groupRows(types: RelatedType[], rows: SearchRow[], side: Side): Group[] {
  return types.map((related) => ({
    key: `${side}:${related.type.id}`,
    side,
    related,
    rows: rows.filter((row) => Number(row._type) === Number(related.type.id)),
  }));
}

function relationColumns(related: RelatedType, tr: (zh: string, en: string) => string): Column<SearchRow>[] {
  const attributes = related.attributes ?? [];
  if (attributes.length === 0) {
    return [{
      key: 'name',
      header: tr('名称', 'Name'),
      width: 'w-full',
      cell: (row) => <span className="text-xs text-text">{row.name ? String(row.name) : `#${row._id}`}</span>,
    }];
  }
  return attributes.map((attribute) => ({
    key: `attr-${attribute.id}`,
    header: attribute.alias || attribute.name,
    cell: (row) => {
      if (attribute.is_password) {
        return <span className="text-text-faint">••••••</span>;
      }
      const type = isValueTypeCode(attribute.value_type) ? attribute.value_type : '2';
      return <AttributeValue type={type} value={row[attribute.name]} />;
    },
  }));
}

function RelationTable({
  group,
  tr,
}: {
  group: Group;
  tr: (zh: string, en: string) => string;
}) {
  const columns = relationColumns(group.related, tr);
  return (
    <section className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <CMDBIcon value={group.related.type.icon} size={14} label={group.related.type.alias || group.related.type.name} />
        <h4 className="text-xs font-semibold text-text">{group.related.type.alias || group.related.type.name}</h4>
        <Chip dense>{String(group.rows.length)}</Chip>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-bg/30">
        <DataTable
          columns={columns}
          rows={group.rows}
          rowKey={(row) => row._id}
          empty={tr('暂无关联实例', 'No related instances')}
        />
      </div>
    </section>
  );
}

export function InstanceRelations({ ciID, modelRef }: { ciID: number; modelRef: string }) {
  const { tr } = useI18n();
  const [parents, setParents] = useState<RelatedType[]>([]);
  const [children, setChildren] = useState<RelatedType[]>([]);
  const [parentRows, setParentRows] = useState<SearchRow[]>([]);
  const [childRows, setChildRows] = useState<SearchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [active, setActive] = useState<'all' | string>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [parentTypes, childTypes, parentsPage, childrenPage] = await Promise.all([
        relationParents(modelRef),
        relationChildren(modelRef),
        searchHierarchy({ rootIDs: [ciID], levels: [1], reverse: true, count: 200, ret_key: 'name' }),
        searchHierarchy({ rootIDs: [ciID], levels: [1], count: 200, ret_key: 'name' }),
      ]);
      setParents(parentTypes);
      setChildren(childTypes);
      setParentRows((parentsPage.result ?? []).filter((row) => row._id !== ciID));
      setChildRows((childrenPage.result ?? []).filter((row) => row._id !== ciID));
    } catch (err) {
      setError(describeError(err, tr('无法读取关联关系', 'Could not load related resources')));
      setParents([]);
      setChildren([]);
      setParentRows([]);
      setChildRows([]);
    } finally {
      setLoading(false);
    }
  }, [ciID, modelRef, tr]);

  useEffect(() => {
    void load();
  }, [load, retryKey]);

  const groups = useMemo(() => {
    const parentGroups = groupRows(parents, parentRows, 'parent');
    const childGroups = groupRows(children, childRows, 'child');
    const all = [...parentGroups, ...childGroups];
    const withRows = all.filter((group) => group.rows.length > 0);
    return {
      parentGroups,
      childGroups,
      all,
      withRows,
      total: parentRows.length + childRows.length,
    };
  }, [parents, children, parentRows, childRows]);

  const selected = active === 'all' ? null : groups.all.find((group) => group.key === active) ?? null;
  const shownGroups = active === 'all' ? groups.withRows : selected ? [selected] : [];

  const navButton = (
    key: 'all' | string,
    label: string,
    count: number,
    icon: React.ReactNode,
  ) => {
    const isActive = active === key;
    return (
      <button
        key={key}
        type="button"
        onClick={() => setActive(key)}
        aria-pressed={isActive}
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500',
          isActive ? 'bg-sky-500/10 text-text' : 'text-text-muted hover:bg-card hover:text-text',
        )}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 font-mono text-[10px] text-text-faint">{count}</span>
      </button>
    );
  };

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card/40">
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-bg/30 px-4 py-2.5">
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-sky-500/10 text-sky-500">
          <GitBranch size={13} aria-hidden="true" />
        </span>
        <h3 className="text-xs font-semibold text-text">{tr('关联关系', 'Related resources')}</h3>
        <span className="font-mono text-[11px] text-text-faint">{groups.total}</span>
        <Button
          variant="plain"
          size="sm"
          type="button"
          onClick={() => setRetryKey((key) => key + 1)}
          className="cmdb-liquid-plain-action ml-auto inline-flex items-center gap-1 text-[11px]"
        >
          <RefreshCw size={11} aria-hidden="true" />
          {tr('刷新', 'Refresh')}
        </Button>
      </header>

      {loading ? (
        <p className="py-8 text-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</p>
      ) : error ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs text-red-600 dark:text-red-300">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <Button variant="outline" size="sm" type="button" onClick={() => setRetryKey((key) => key + 1)}>
            {tr('重试', 'Retry')}
          </Button>
        </div>
      ) : groups.all.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-text-faint">{tr('模型关系中没有可关联的类型', 'The model relations define no related types')}</p>
      ) : (
        <div className="flex flex-col lg:flex-row">
          <aside className="w-full shrink-0 border-b border-border p-2 lg:w-48 lg:border-b-0 lg:border-e">
            {navButton('all', tr('全部', 'All'), groups.total, <LayoutGrid size={14} aria-hidden="true" />)}
            {groups.parentGroups.length > 0 && (
              <>
                <div className="flex items-center gap-1 px-2 pb-1 pt-3 text-[10px] font-medium tracking-wide text-text-faint">
                  <ArrowUpRight size={11} aria-hidden="true" />
                  {tr('上游', 'Upstream')}
                </div>
                {groups.parentGroups.map((group) =>
                  navButton(
                    group.key,
                    group.related.type.alias || group.related.type.name,
                    group.rows.length,
                    <CMDBIcon value={group.related.type.icon} size={14} label={group.related.type.alias || group.related.type.name} />,
                  ),
                )}
              </>
            )}
            {groups.childGroups.length > 0 && (
              <>
                <div className="flex items-center gap-1 px-2 pb-1 pt-3 text-[10px] font-medium tracking-wide text-text-faint">
                  <ArrowDownRight size={11} aria-hidden="true" />
                  {tr('下游', 'Downstream')}
                </div>
                {groups.childGroups.map((group) =>
                  navButton(
                    group.key,
                    group.related.type.alias || group.related.type.name,
                    group.rows.length,
                    <CMDBIcon value={group.related.type.icon} size={14} label={group.related.type.alias || group.related.type.name} />,
                  ),
                )}
              </>
            )}
          </aside>

          <div className="min-w-0 flex-1 p-3">
            {shownGroups.length === 0 ? (
              <div className="flex min-h-28 flex-col items-center justify-center gap-1 text-center text-xs text-text-faint">
                <GitBranch size={18} aria-hidden="true" />
                {tr('暂无关联实例', 'No related instances')}
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {shownGroups.map((group) => (
                  <RelationTable key={group.key} group={group} tr={tr} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
