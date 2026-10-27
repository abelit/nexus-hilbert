import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDownRight,
  ArrowUpRight,
  ExternalLink,
  Eye,
  GitBranch,
  LayoutGrid,
  Network,
  Plus,
  RefreshCw,
} from 'lucide-react';

import { Button } from '@/components/ui';
import { Chip } from '@/components/ui/Chip';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import type { AttributeGroup, CIType, RelatedType, TypeAttribute } from '../../api/citype';
import { describeError } from '../../api/http';
import { listAttributeGroups, listTypeAttributes, relationChildren, relationParents } from '../../api/citype';
import { searchHierarchy, type SearchRow } from '../../api/instance';
import { choiceText } from '../../lib/choice-labels';
import { referenceRawText, referenceText, useReferenceLabels } from '../../lib/reference-labels';
import { relatedKeyAttributes, relatedRowIdentifier, relatedRowTitle } from '../../lib/related-row';
import { displayValue, isValueTypeCode } from '../../lib/valuetype';
import { AttributeValue } from '../AttributeControl';
import { CMDBIcon } from '../CMDBIcon';
import { DataTable, type Column } from '../DataTable';
import { useToast } from '../Toast';
import { InstanceDetailDrawer } from './InstanceDetailDrawer';
import { RelationAddDialog } from './RelationAddDialog';

// The relation summary under the detail attributes.
//
// THE MODEL GRAPH DECIDES WHICH TYPES CAN APPEAR; the hierarchy walk decides
// which rows actually do. Both are needed: the graph gives a stable sidebar
// (including types with a zero count), the walk gives today's instances.
//
// THE TABLE IS A RESOURCE INDEX, NOT A COLUMN DUMP. The old table printed every
// attribute of the related model, so a UUID made one row four lines tall and a
// wide model hid the useful fields off-screen. The row now shows the resource
// name, its unique key, two operational fields and actions that open the same
// detail/topology surfaces as 资源数据. Adding a relation is explicit and
// searchable; deletion remains outside this read-first view.

type Side = 'parent' | 'child';

type Group = {
  key: string;
  side: Side;
  related: RelatedType;
  rows: SearchRow[];
};

type Peek = {
  group: Group;
  row: SearchRow;
  tab: 'overview' | 'topology';
};

function groupRows(types: RelatedType[], rows: SearchRow[], side: Side): Group[] {
  return types.map((related) => ({
    key: `${side}:${related.type.id}`,
    side,
    related,
    rows: rows.filter((row) => Number(row._type) === Number(related.type.id)),
  }));
}

function relationTypeLabel(tr: (zh: string, en: string) => string, related: RelatedType): string {
  return related.relation_type?.name || tr('关联', 'Relation');
}

function useWideRelationTable(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia?.('(min-width: 640px)')?.matches ?? true);
  useEffect(() => {
    const media = window.matchMedia?.('(min-width: 640px)');
    if (!media) return;
    const change = () => setWide(media.matches);
    media.addEventListener?.('change', change);
    return () => media.removeEventListener?.('change', change);
  }, []);
  return wide;
}

function resourceHref(group: Group, row: SearchRow): string {
  const query = new URLSearchParams({
    type: group.related.type.name,
    ci: String(row._id),
  });
  return `/cmdb/instances?${query.toString()}`;
}

function KeyAttributeValue({
  attribute,
  value,
  labels,
}: {
  attribute: TypeAttribute;
  value: unknown;
  labels: Map<number, string>;
}) {
  const label = attribute.is_reference ? referenceText(value, labels) : choiceText(attribute, value);
  const raw = attribute.is_reference ? referenceRawText(value) : displayValue(value);
  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1">
      <span className="shrink-0 text-[10px] text-text-faint">{attribute.alias || attribute.name}</span>
      <span
        className="min-w-0 truncate text-[11px] text-text-muted"
        title={label && label !== raw ? `${label} (${raw})` : raw}
      >
        <AttributeValue
          type={isValueTypeCode(attribute.value_type) ? attribute.value_type : '2'}
          value={value}
          label={label}
        />
      </span>
    </span>
  );
}

function RelationTable({
  group,
  attributes,
  models,
  tr,
  onAdd,
  onPeek,
}: {
  group: Group;
  attributes: TypeAttribute[];
  models: CIType[];
  tr: (zh: string, en: string) => string;
  onAdd(group: Group): void;
  onPeek(group: Group, row: SearchRow, tab: 'overview' | 'topology'): void;
}) {
  // Search rows are flat; the shared label resolver reads `values`.
  const labelRows = useMemo(
    () => group.rows.map((row) => ({ values: row as Record<string, unknown> })),
    [group.rows],
  );
  const referenceLabels = useReferenceLabels(labelRows, attributes, models);
  const keyAttributes = useMemo(
    () => relatedKeyAttributes({ ...group.related, attributes }),
    [attributes, group.related],
  );
  const wide = useWideRelationTable();

  const columns = useMemo<Column<SearchRow>[]>(() => {
    const out: Column<SearchRow>[] = [
      {
        key: 'resource',
        header: tr('资源', 'Resource'),
        width: 'w-full min-w-28',
        cell: (row) => {
          const title = relatedRowTitle(row, group.related);
          const identifier = relatedRowIdentifier(row, group.related, title);
          return (
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold text-text" title={title}>
                {title}
              </div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-text-faint" title={identifier}>
                {identifier}
              </div>
              {!wide && keyAttributes.length > 0 && (
                <div className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5">
                  {keyAttributes.map((attribute) => (
                    <KeyAttributeValue
                      key={attribute.id}
                      attribute={attribute}
                      value={row[attribute.name]}
                      labels={referenceLabels}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        },
      },
    ];
    if (keyAttributes.length > 0 && wide) {
      out.push({
        key: 'key-attributes',
        header: tr('关键属性', 'Key attributes'),
        width: 'min-w-52',
        cell: (row) => (
          <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
            {keyAttributes.map((attribute) => (
              <KeyAttributeValue
                key={attribute.id}
                attribute={attribute}
                value={row[attribute.name]}
                labels={referenceLabels}
              />
            ))}
          </div>
        ),
      });
    }
    return out;
  }, [group.related, keyAttributes, referenceLabels, tr, wide]);

  const typeLabel = group.related.type.alias || group.related.type.name;
  return (
    <section className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <CMDBIcon value={group.related.type.icon} size={14} label={typeLabel} />
        <h4 className="text-xs font-semibold text-text">{typeLabel}</h4>
        <Chip dense>{String(group.rows.length)}</Chip>
        <span className="text-[10px] text-text-faint">{relationTypeLabel(tr, group.related)}</span>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => onAdd(group)}
          aria-label={tr(`添加${typeLabel}关联`, `Add ${typeLabel} relation`)}
          className="ml-auto inline-flex items-center gap-1 text-[11px]"
        >
          <Plus size={12} aria-hidden="true" />
          {tr('添加', 'Add')}
        </Button>
      </div>
      <div className="cmdb-relation-table overflow-hidden rounded-lg border border-border bg-bg/30">
        <DataTable
          columns={columns}
          rows={group.rows}
          rowKey={(row) => row._id}
          actionsHeader={tr('操作', 'Actions')}
          empty={tr('暂无关联实例', 'No related instances')}
          actions={(row) => {
            const title = relatedRowTitle(row, group.related);
            return (
              <span className="flex items-center justify-end gap-0.5 whitespace-nowrap">
                <Button
                  variant="plain"
                  size="sm"
                  type="button"
                  onClick={() => onPeek(group, row, 'overview')}
                  aria-label={tr(`查看 ${title} 详情`, `View details for ${title}`)}
                  title={tr(`查看 ${title} 详情`, `View details for ${title}`)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md p-0 text-sky-500 hover:bg-card hover:text-sky-600 dark:text-sky-300"
                >
                  <Eye size={13} aria-hidden="true" />
                </Button>
                <Button
                  variant="plain"
                  size="sm"
                  type="button"
                  onClick={() => onPeek(group, row, 'topology')}
                  aria-label={tr(`查看 ${title} 拓扑`, `View topology for ${title}`)}
                  title={tr(`查看 ${title} 拓扑`, `View topology for ${title}`)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md p-0 text-violet-500 hover:bg-card hover:text-violet-600 dark:text-violet-300"
                >
                  <Network size={13} aria-hidden="true" />
                </Button>
                <Link
                  to={resourceHref(group, row)}
                  reloadDocument
                  aria-label={tr(`在资源数据中打开 ${title}`, `Open ${title} in resource data`)}
                  title={tr(`在资源数据中打开 ${title}`, `Open ${title} in resource data`)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-faint hover:bg-card hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
                >
                  <ExternalLink size={13} aria-hidden="true" />
                </Link>
              </span>
            );
          }}
        />
      </div>
    </section>
  );
}

export function InstanceRelations({
  ciID,
  modelRef,
  models,
}: {
  ciID: number;
  modelRef: string;
  models: CIType[];
}) {
  const { tr } = useI18n();
  const toast = useToast();
  const [parents, setParents] = useState<RelatedType[]>([]);
  const [children, setChildren] = useState<RelatedType[]>([]);
  const [parentRows, setParentRows] = useState<SearchRow[]>([]);
  const [childRows, setChildRows] = useState<SearchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [active, setActive] = useState<'all' | string>('all');
  const [addGroup, setAddGroup] = useState<Group | null>(null);
  const [peek, setPeek] = useState<Peek | null>(null);
  const [detailGroups, setDetailGroups] = useState<Record<string, AttributeGroup[]>>({});
  const [typeAttributes, setTypeAttributes] = useState<Record<string, TypeAttribute[]>>({});

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
  const relatedTypeNames = useMemo(
    () => [...new Set(groups.withRows.map((group) => group.related.type.name))].sort(),
    [groups.withRows],
  );

  // The relation endpoints carry the values but only a subset of the model's
  // attribute metadata (no choice labels or reference targets). Fetch the full
  // effective set once per related type so the compact table and the peeked
  // detail can label their values.
  useEffect(() => {
    const missing = relatedTypeNames.filter((name) => !typeAttributes[name]);
    if (missing.length === 0) return;
    let live = true;
    void Promise.all(
      missing.map(async (name) => {
        try {
          const got = await listTypeAttributes(name);
          return [name, got.attributes ?? []] as const;
        } catch {
          return [name, [] as TypeAttribute[]] as const;
        }
      }),
    ).then((pairs) => {
      if (!live) return;
      setTypeAttributes((current) => {
        const next = { ...current };
        for (const [name, attributes] of pairs) next[name] = attributes;
        return next;
      });
    });
    return () => {
      live = false;
    };
  }, [relatedTypeNames, typeAttributes]);

  useEffect(() => {
    if (!peek) return;
    const name = peek.group.related.type.name;
    if (detailGroups[name]) return;
    let live = true;
    void listAttributeGroups(name, false)
      .then((got) => {
        if (live) setDetailGroups((current) => ({ ...current, [name]: got }));
      })
      .catch(() => {
        if (live) setDetailGroups((current) => ({ ...current, [name]: [] }));
      });
    return () => {
      live = false;
    };
  }, [peek, detailGroups]);

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
                {tr('暂无关联实例；选择左侧类型即可添加。', 'No related instances; choose a type on the left to add one.')}
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {shownGroups.map((group) => (
                  <RelationTable
                    key={group.key}
                    group={group}
                    attributes={typeAttributes[group.related.type.name] ?? group.related.attributes}
                    models={models}
                    tr={tr}
                    onAdd={setAddGroup}
                    onPeek={(nextGroup, row, tab) => setPeek({ group: nextGroup, row, tab })}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {addGroup && (
        <RelationAddDialog
          open
          currentCIID={ciID}
          related={addGroup.related}
          side={addGroup.side}
          existingIDs={addGroup.rows.map((row) => row._id)}
          onClose={() => setAddGroup(null)}
          onAdded={(row) => {
            const label = relatedRowTitle(row, addGroup.related);
            setAddGroup(null);
            toast.success(tr(`已添加关联：${label}`, `Relation added: ${label}`));
            void load();
          }}
        />
      )}

      {peek && (
        <InstanceDetailDrawer
          model={peek.group.related.type}
          models={models}
          attributes={typeAttributes[peek.group.related.type.name] ?? peek.group.related.attributes}
          groups={detailGroups[peek.group.related.type.name] ?? []}
          instanceID={peek.row._id}
          initialTab={peek.tab}
          onClose={() => setPeek(null)}
        />
      )}
    </section>
  );
}
