import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  FileUp,
  Folder,
  LayoutGrid,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Table2,
  Trash2,
  X,
} from 'lucide-react';

import { Button, EmptyState } from '@/components/ui';
import { Checkbox } from '@/components/ui/Checkbox';
import { Chip } from '@/components/ui/Chip';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { PaginationFooter } from '@/components/ui/PaginationFooter';
import { Select } from '@/components/ui/Select';
import { useDialogs } from '@/components/ui/useDialogs';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import { describeError } from '../api/http';
import {
  listCITypes,
  listAttributeGroups,
  listTypeAttributes,
  type AttributeGroup,
  type CIType,
  type TypeAttribute,
} from '../api/citype';
import {
  createInstance,
  deleteInstance,
  getInstance,
  listInstances,
  searchInstances,
  updateInstance,
  type Instance,
} from '../api/instance';
import { getInstanceFileValues } from '../api/files';
import {
  getShowFields,
  listModelGroups,
  listSubscribedModels,
  type ModelGroup,
} from '../api/preferences';
import { AttributeControl, AttributeValue } from '../components/AttributeControl';
import { CMDBIcon } from '../components/CMDBIcon';
import { DataTable, type Column } from '../components/DataTable';
import { Drawer } from '../components/Drawer';
import { FileField } from '../components/files/FileField';
import { InstanceDetailDrawer } from '../components/instance-detail/InstanceDetailDrawer';
import { InstanceFieldsDialog } from '../components/InstanceFieldsDialog';
import { ExportMenu } from '../components/ipam/ExportMenu';
import { MetaPill } from '../components/MetaPill';
import { ReferencePicker } from '../components/ReferencePicker';
import { useToast } from '../components/Toast';
import { WorkspaceBar } from '../components/WorkspaceBar';
import { attributeSections } from '../lib/attribute-sections';
import { choiceText } from '../lib/choice-labels';
import type { ExportColumn } from '../lib/export';
import { instanceSearchQuery, searchRowToInstance } from '../lib/instance-search';
import { groupModels, orderModelsBySubscription } from '../lib/model-groups';
import { referenceRawText, referenceText, useReferenceLabels, type ReferenceLabels } from '../lib/reference-labels';
import { displayValue, isValueTypeCode } from '../lib/valuetype';

// 资源数据 — the instances of one model.
//
// IT IS THE PAGE THE WHOLE PRODUCT IS FOR, and it is generated rather than
// written: the columns come from the operator's subscription and the form comes
// from the model's attributes. Nothing here knows what a host is.
//
// THE COLUMNS ARE THE SUBSCRIPTION (`c_psa`), so the page an operator configured
// under 我的订阅 is the page they get. When no subscription exists the fallback
// is the identifying attribute plus the first few fields, because a list with no
// columns is not a fallback.

const PAGE_SIZE = 20;

// One export page is 500 because that is the instance/search endpoint's
// ceiling. 全部 is therefore fetched in pages, with a bound: cantor asked for
// 99,999 in one request, which this backend would clamp to one 500-row page.
const EXPORT_PAGE_SIZE = 500;
const EXPORT_MAX_ROWS = 10_000;

type View = 'table' | 'grid';

export default function InstancesPage() {
  const { tr } = useI18n();
  const toast = useToast();
  const { confirmAction, dialog } = useDialogs();
  const [params, setParams] = useSearchParams();

  const contentRef = useRef<HTMLDivElement | null>(null);
  const selectedRailRef = useRef<HTMLButtonElement | null>(null);

  const [models, setModels] = useState<CIType[]>([]);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  // The operator's own model order (c_pcto), which is what 我的订阅 arranges.
  // The rail uses it before the schema's global order so the two pages agree.
  const [subscriptionOrder, setSubscriptionOrder] = useState<number[]>([]);
  // Groups are a separate snapshot, exactly as on the 模型配置 page: a group
  // failure must not blank the rail, it only leaves it flat.
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([]);
  const [modelGroupsErr, setModelGroupsErr] = useState<string | null>(null);
  // Collapsed groups are a view preference, not persisted state: the selected
  // model's group reopens automatically, and a reload starts from a full rail.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [typeRef, setTypeRef] = useState<string>(params.get('type') ?? '');
  const [attributes, setAttributes] = useState<TypeAttribute[]>([]);
  const [groups, setGroups] = useState<AttributeGroup[]>([]);
  const [columns, setColumns] = useState<TypeAttribute[]>([]);
  const [rows, setRows] = useState<Instance[]>([]);
  const [numFound, setNumFound] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Cantor's box searches the whole model, not the loaded page: the draft is
  // committed to `/ci/s` on Enter, which is the only trigger.
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const [envFilter, setEnvFilter] = useState('all');
  const [levelFilter, setLevelFilter] = useState('all');
  const [view, setView] = useState<View>(() =>
    window.matchMedia?.('(max-width: 1279px)')?.matches ? 'grid' : 'table',
  );
  const [editing, setEditing] = useState<{ mode: 'create' } | { mode: 'edit'; id: number } | null>(null);
  // `?ci=` opens one instance after a jump from a related-resource row. The
  // link uses a document reload, so the query is available on first render.
  const [viewing, setViewing] = useState<{ id: number; tab: 'overview' | 'topology' } | null>(() => {
    const ci = Number(params.get('ci'));
    return Number.isSafeInteger(ci) && ci > 0 ? { id: ci, tab: 'overview' } : null;
  });
  // SELECTION IS THE OPERATOR'S INTENT, NOT A PAGE FACT. Checked instances stay
  // selected while paging; changing the model or the query starts a new set.
  const [selected, setSelected] = useState<Set<string | number>>(() => new Set());
  const selectedCount = selected.size;
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const toggleSelected = useCallback((id: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const loadModelGroups = useCallback(async () => {
    try {
      setModelGroups(await listModelGroups());
      setModelGroupsErr(null);
    } catch (error) {
      // The flat list stays usable; the rail says why it is not grouped instead
      // of pretending the deployment has no groups.
      setModelGroupsErr(describeError(error, tr('无法读取模型分组', 'Could not load the model groups')));
    }
  }, [tr]);

  // The model rail loads once. It must not refetch on every model switch: the
  // list is the navigation, not the selected model's data.
  const loadModels = useCallback(async () => {
    setModelsErr(null);
    void loadModelGroups();
    try {
      // The subscription is a preference, not part of the model catalogue. If
      // it cannot be read the rail still works, in the schema's own order.
      const [all, subscribed] = await Promise.all([
        listCITypes(),
        listSubscribedModels().catch(() => null),
      ]);
      const order = subscribed?.type_ids ?? [];
      setSubscriptionOrder(order);
      const ranked = orderModelsBySubscription(all, order);
      setModels(ranked);
      setTypeRef((current) => current || ranked[0]?.name || '');
    } catch (error) {
      setModelsErr(describeError(error, tr('无法读取模型', 'Could not load models')));
    }
  }, [loadModelGroups, tr]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    selectedRailRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [collapsedGroups, typeRef, models, modelGroups]);

  const model = useMemo(
    () => models.find((item) => item.name === typeRef || String(item.id) === typeRef),
    [models, typeRef],
  );

  // REFERENCE IDS ARE NOT NAMES. Resolve the visible page's references in one
  // batch per referenced model, and fall back to the stored id if a lookup fails.
  const referenceLabels = useReferenceLabels(rows, columns, models);
  // The model's shape: its effective attributes, its form sections, and the
  // columns this operator subscribed to.
  useEffect(() => {
    if (!typeRef) return;
    let live = true;
    setLoading(true);
    setErr(null);
    void Promise.all([
      listTypeAttributes(typeRef),
      listAttributeGroups(typeRef, false).catch(() => [] as AttributeGroup[]),
      getShowFields(typeRef).catch(() => null),
    ])
      .then(([attrs, gotGroups, show]) => {
        if (!live) return;
        const list = attrs.attributes ?? [];
        setAttributes(list);
        setGroups(gotGroups);

        // THE SUBSCRIPTION NAMES COLUMNS BY ATTRIBUTE, and a subscription that
        // names nothing (or has never been saved) falls back to the identifying
        // attribute plus the first few — never to an empty table.
        const byID = new Map(list.map((attribute) => [attribute.id, attribute]));
        const subscribed = (show?.fields ?? [])
          .map((field) => (field.attr_id ? byID.get(field.attr_id) : undefined))
          .filter((attribute): attribute is TypeAttribute => Boolean(attribute));
        if (subscribed.length > 0) {
          setColumns(subscribed);
        } else {
          const identifier = list.filter((attribute) => attribute.name === model?.unique_key);
          setColumns([...identifier, ...list.filter((attribute) => attribute.name !== model?.unique_key).slice(0, 4)]);
        }
      })
      .catch((error) => live && setErr(describeError(error, tr('无法读取模型属性', 'Could not load the model’s attributes'))))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [typeRef, model?.unique_key, tr]);

  // The search query needs the model id, but the list loader must not depend on
  // the model list request: the models land after the first list fetch and a
  // dependency would refetch the same page.
  const modelIDRef = useRef<number | undefined>(undefined);
  modelIDRef.current = model?.id;

  const load = useCallback(
    async (quiet = false) => {
      if (!typeRef) return;
      if (quiet) setRefreshing(true);
      else setLoading(true);
      setErr(null);
      try {
        // CANTOR'S BOX IS A SERVER SEARCH. The term goes to `/ci/s` as a
        // type-scoped contains query across the indexed values of the WHOLE
        // model; the plain list is the empty-term path.
        if (search) {
          const got = await searchInstances({
            q: instanceSearchQuery(modelIDRef.current ?? typeRef, search),
            count: PAGE_SIZE,
            page: page + 1,
          });
          setRows((got.result ?? []).map(searchRowToInstance));
          setNumFound(got.numfound ?? 0);
        } else {
          const got = await listInstances(typeRef, { page: page + 1, count: PAGE_SIZE, include_files: true });
          setRows(got.items ?? []);
          setNumFound(got.numfound ?? 0);
        }
      } catch (error) {
        setErr(
          search
            ? describeError(error, tr('搜索实例失败', 'Could not search instances'))
            : describeError(error, tr('无法读取实例', 'Could not load the instances')),
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [page, search, tr, typeRef],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const chooseModel = (name: string) => {
    if (name === typeRef) return;
    // THE PREVIOUS MODEL'S NUMBERS MUST NOT LINGER under the new title while
    // its attributes and rows are loading.
    setTypeRef(name);
    setPage(0);
    setSearch('');
    setSearchDraft('');
    setEnvFilter('all');
    setLevelFilter('all');
    setSelected(new Set());
    setViewing(null);
    setRows([]);
    setNumFound(0);
    setAttributes([]);
    setColumns([]);
    setGroups([]);
    setErr(null);
    setLoading(true);
    // The workbench card owns the scroller, whichever view is active.
    const scroller = contentRef.current?.querySelector<HTMLElement>('.cmdb-table-scroll, .cmdb-model-table-scroll');
    if (scroller) scroller.scrollTop = 0;
    const next = new URLSearchParams(params);
    next.set('type', name);
    setParams(next, { replace: true });
  };

  const remove = async (row: Instance) => {
    const label = row.values[model?.unique_key ?? ''] ?? row.ci_id;
    const ok = await confirmAction(
      tr(`删除实例「${displayValue(label)}」？它的属性值和关系会一起删除。`, `Delete the instance “${displayValue(label)}”? Its values and relations go with it.`),
    );
    if (!ok) return;
    try {
      await deleteInstance(row.ci_id);
      setSelected((current) => {
        if (!current.has(row.ci_id)) return current;
        const next = new Set(current);
        next.delete(row.ci_id);
        return next;
      });
      toast.success(tr('已删除', 'Deleted'));
      await load(true);
    } catch (error) {
      toast.error(describeError(error, tr('删除失败', 'Delete failed')));
    }
  };

  // File uploads/deletes are immediate in the manager dialog. Persist the new
  // metadata JSON on the instance and update the visible row in place: a quiet
  // list reload would drop file metadata again when the current view is a
  // server search result.
  const saveFileValue = useCallback(
    async (row: Instance, attribute: TypeAttribute, serialized: string) => {
      await updateInstance(row.ci_id, { values: { [attribute.name]: serialized } });
      setRows((current) =>
        current.map((item) =>
          item.ci_id === row.ci_id
            ? { ...item, values: { ...item.values, [attribute.name]: serialized } }
            : item,
        ),
      );
    },
    [],
  );

  const envAttribute = attributes.find((attribute) => attribute.name === 'environment');
  const levelAttribute = attributes.find((attribute) => attribute.name === 'level');
  const statusAttribute = attributes.find((attribute) => attribute.name === 'data_status');
  const slaAttribute = attributes.find((attribute) => attribute.name === 'sla');

  const facetValues = (name: string): string[] => {
    const seen = new Set<string>();
    for (const row of rows) {
      const text = displayValue(row.values?.[name]);
      if (text && text !== '—') seen.add(text);
      if (seen.size >= 8) break;
    }
    return [...seen].sort((left, right) => left.localeCompare(right));
  };

  // THE ENVIRONMENT/LEVEL CHIPS FILTER THE LOADED PAGE. The free-text box is a
  // server search (see load), so no value matching happens here.
  const matchesEnvLevel = useCallback(
    (row: Instance) => {
      if (envFilter !== 'all' && displayValue(row.values?.environment) !== envFilter) return false;
      if (levelFilter !== 'all' && displayValue(row.values?.level) !== levelFilter) return false;
      return true;
    },
    [envFilter, levelFilter],
  );
  const visibleRows = useMemo(() => rows.filter(matchesEnvLevel), [rows, matchesEnvLevel]);

  // THE TABLE AND THE GRID SHARE ONE SET. The table's header checkbox and the
  // grid's toolbar checkbox both act on the rows the current view shows.
  const pageIDs = useMemo(() => visibleRows.map((row) => row.ci_id), [visibleRows]);
  const allPageSelected = pageIDs.length > 0 && pageIDs.every((id) => selected.has(id));
  const somePageSelected = !allPageSelected && pageIDs.some((id) => selected.has(id));
  const togglePageSelected = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allPageSelected) pageIDs.forEach((id) => next.delete(id));
      else pageIDs.forEach((id) => next.add(id));
      return next;
    });
  };
  const tableSelection = useMemo(
    () => ({
      selected,
      onChange: (next: ReadonlySet<string | number>) => setSelected(new Set(next)),
    }),
    [selected],
  );

  const activeCount = rows.filter((row) => displayValue(row.values?.data_status).toLowerCase() === 'active').length;
  const activePercent = statusAttribute && rows.length > 0 ? Math.round((activeCount / rows.length) * 100) : null;
  const prodCount = envAttribute
    ? rows.filter((row) => displayValue(row.values?.environment).toLowerCase() === 'prod').length
    : null;
  const slaCount = slaAttribute
    ? rows.filter((row) => {
        const value = row.values?.sla;
        return value !== undefined && value !== null && displayValue(value) !== '—';
      }).length
    : null;

  const filteredModels = useMemo(() => {
    const needle = modelQuery.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((item) => `${item.alias} ${item.name}`.toLowerCase().includes(needle));
  }, [models, modelQuery]);

  const subscriptionRank = useMemo(() => {
    const rank = new Map<number, number>();
    subscriptionOrder.forEach((id, index) => {
      if (!rank.has(id)) rank.set(id, index);
    });
    return rank;
  }, [subscriptionOrder]);

  // A group's place is the earliest place any of its models holds in 我的订阅.
  // Groups with no arranged models keep the catalogue's order (the sort is
  // stable for equal ranks). 其他 stays last, the trailing bucket the model
  // configuration and cantor both use.
  const orderedModelGroups = useMemo(() => {
    if (subscriptionRank.size === 0) return modelGroups;
    const groupRank = (group: ModelGroup) => {
      let rank = Number.MAX_SAFE_INTEGER;
      for (const item of group.ci_types ?? []) {
        const candidate = subscriptionRank.get(item.id);
        if (candidate != null && candidate < rank) rank = candidate;
      }
      return rank;
    };
    return [...modelGroups].sort((left, right) => groupRank(left) - groupRank(right));
  }, [modelGroups, subscriptionRank]);

  const rankOfModel = useCallback(
    (item: CIType) => subscriptionRank.get(item.id) ?? Number.MAX_SAFE_INTEGER,
    [subscriptionRank],
  );

  // The rail mirrors 模型配置's grouping, but the order inside each group and
  // the group order follow 我的订阅. Searching narrows each section without
  // changing the order of what remains.
  const modelSections = useMemo(
    () =>
      groupModels(filteredModels, orderedModelGroups, {
        other: tr('其他', 'Other'),
        all: tr('全部模型', 'All models'),
        unnamed: tr('未命名分组', 'Untitled group'),
      }).map((section) => ({
        ...section,
        rows: [...section.rows].sort(
          (left, right) =>
            rankOfModel(left) - rankOfModel(right) ||
            left.order - right.order ||
            left.name.localeCompare(right.name),
        ),
      })),
    [filteredModels, orderedModelGroups, rankOfModel, tr],
  );
  const groupedRail = modelGroups.some((group) => !group.is_other);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // The selected model must stay visible: a deep link or a model switch reopens
  // the group that holds it. A manual collapse of the current group sticks,
  // because this effect does not depend on `collapsedGroups`.
  useEffect(() => {
    if (!groupedRail || !typeRef) return;
    const section = modelSections.find((candidate) =>
      candidate.rows.some((item) => item.name === typeRef || String(item.id) === typeRef),
    );
    if (!section) return;
    setCollapsedGroups((current) => {
      if (!current.has(section.key)) return current;
      const next = new Set(current);
      next.delete(section.key);
      return next;
    });
  }, [groupedRail, modelSections, typeRef]);

  const filtering = envFilter !== 'all' || levelFilter !== 'all';
  // A query change invalidates the visible set; keeping a hidden selection
  // would let 已选 export rows the operator can no longer see.
  const applyEnvFilter = (value: string) => {
    setEnvFilter(value);
    clearSelection();
  };
  const applyLevelFilter = (value: string) => {
    setLevelFilter(value);
    clearSelection();
  };
  const clearFilters = () => {
    setEnvFilter('all');
    setLevelFilter('all');
    clearSelection();
  };
  const applySearch = () => {
    const next = searchDraft.trim();
    if (next === search) return;
    setSearch(next);
    setPage(0);
    clearSelection();
  };
  const clearSearch = () => {
    setSearchDraft('');
    if (!search) return;
    setSearch('');
    setPage(0);
    clearSelection();
  };

  // One rail row, shared by the flat and grouped renders so the two modes
  // cannot drift in height, colour or accessible name.
  const renderModelButton = (item: CIType) => {
    const selected = item.name === typeRef || String(item.id) === typeRef;
    return (
      <button
        key={item.id}
        ref={selected ? selectedRailRef : undefined}
        type="button"
        onClick={() => chooseModel(item.name)}
        aria-pressed={selected}
        aria-label={item.alias || item.name}
        title={item.alias || item.name}
        className={cn(
          'flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500',
          selected ? 'bg-indigo-500/15 text-text' : 'text-text-muted hover:bg-card hover:text-text',
        )}
      >
        <CMDBIcon value={item.icon} size={14} label={item.alias || item.name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{item.alias || item.name}</span>
          <span className="block truncate font-mono text-[10px] text-text-faint">{item.name}</span>
        </span>
        {!item.enabled && <Chip dense>{tr('停用', 'Off')}</Chip>}
      </button>
    );
  };

  const tableColumns: Column<Instance>[] = columns.map((attribute) => ({
    key: `attr-${attribute.id}`,
    header: attribute.alias || attribute.name,
    width: attribute.name === model?.unique_key ? 'w-full' : undefined,
    sortable: false,
    cell: (row) => {
      const value = row.values?.[attribute.name];
      const label = attribute.is_reference
        ? referenceText(value, referenceLabels)
        : choiceText(attribute, value);
      const raw = attribute.is_reference ? referenceRawText(value) : displayValue(value);
      return (
        <span
          className="block min-w-0 truncate"
          title={attribute.is_file ? undefined : label && label !== raw ? `${label} (${raw})` : raw}
        >
          {attribute.is_file ? (
            <FileField
              key={`${row.ci_id}-${attribute.id}`}
              compact
              attribute={attribute}
              value={value}
              disabled={attribute.is_computed}
              loadValue={async () => (await getInstanceFileValues(row.ci_id))[attribute.name]}
              onChange={(_files, serialized) => saveFileValue(row, attribute, serialized)}
            />
          ) : (
            <AttributeValue
              type={isValueTypeCode(attribute.value_type) ? attribute.value_type : '2'}
              value={value}
              label={label}
            />
          )}
        </span>
      );
    },
  }));

  // The exported columns are the subscribed ones the table shows. References
  // are omitted, as cantor did: their stored value is an id, and resolving every
  // referenced instance would turn one export into hundreds of lookups.
  const exportColumns = useMemo<ExportColumn<Instance>[]>(
    () =>
      columns
        .filter((attribute) => !attribute.is_reference)
        .map((attribute) => ({
          key: attribute.name,
          header: attribute.alias || attribute.name,
          value: (row) => {
            const value = row.values?.[attribute.name];
            return choiceText(attribute, value) ?? displayValue(value);
          },
        })),
    [columns],
  );

  // 全部 means "the current server query", not "the twenty rows on screen".
  // The endpoint caps one page at 500, so fetch in pages and stop at the same
  // client-side bound the UI reports.
  const fetchAllForExport = useCallback(async (): Promise<Instance[]> => {
    if (!typeRef) return [];
    const target = Math.min(numFound, EXPORT_MAX_ROWS);
    if (target <= 0) return [];
    const pages = Math.ceil(target / EXPORT_PAGE_SIZE);
    const collected: Instance[] = [];
    for (let page = 1; page <= pages; page += 1) {
      if (search) {
        const got = await searchInstances({
          q: instanceSearchQuery(model?.id ?? typeRef, search),
          count: EXPORT_PAGE_SIZE,
          page,
        });
        const items = (got.result ?? []).map(searchRowToInstance);
        collected.push(...items);
        if (items.length === 0) break;
      } else {
        const got = await listInstances(typeRef, { page, count: EXPORT_PAGE_SIZE });
        const items = got.items ?? [];
        collected.push(...items);
        if (items.length === 0) break;
      }
      if (collected.length >= target) break;
    }
    if (numFound > EXPORT_MAX_ROWS) {
      toast.info(
        tr(
          `实例超过 ${EXPORT_MAX_ROWS} 条，已导出前 ${EXPORT_MAX_ROWS} 条`,
          `More than ${EXPORT_MAX_ROWS} instances; exporting the first ${EXPORT_MAX_ROWS}`,
        ),
      );
    }
    // The environment/level chips are a page filter in the UI; applying them to
    // the whole export keeps the file consistent with what the operator asked
    // to see rather than silently widening the scope.
    return collected.slice(0, target).filter(matchesEnvLevel);
  }, [typeRef, numFound, search, model?.id, matchesEnvLevel, toast, tr]);

  // SELECTED ROWS CAN BE ON PAGES THE OPERATOR HAS LEFT. Resolve them by id, in
  // the order they were checked, instead of exporting only what is on screen.
  // The ids travel in batches of one page so a large selection stays within the
  // search endpoint's per-request limit.
  const fetchSelectedForExport = useCallback(async (): Promise<Instance[]> => {
    const ids = [...selected]
      .map((key) => Number(key))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    if (ids.length === 0) return [];
    const found = new Map<number, Instance>();
    for (let offset = 0; offset < ids.length; offset += EXPORT_PAGE_SIZE) {
      const chunk = ids.slice(offset, offset + EXPORT_PAGE_SIZE);
      const got = await searchInstances({
        q: `_id:(${chunk.join(';')})`,
        count: EXPORT_PAGE_SIZE,
        page: 1,
      });
      for (const item of (got.result ?? []).map(searchRowToInstance)) {
        found.set(item.ci_id, item);
      }
    }
    return ids.flatMap((id) => {
      const row = found.get(id);
      return row ? [row] : [];
    });
  }, [selected]);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <WorkspaceBar
        leading={
          <>
            <span>{tr('资源模型', 'Resource models')}</span>
            <ChevronRight size={10} aria-hidden="true" />
            <h1 className="min-w-0 truncate text-xs font-medium text-text">{tr('资源数据', 'Resources')}</h1>
            {model && (
              <>
                <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
                <span className="flex min-w-0 items-center gap-1.5">
                  <CMDBIcon value={model.icon} size={14} label={model.alias || model.name} />
                  <span className="truncate text-text">{model.alias || model.name}</span>
                  <code className="font-mono text-[10px] text-text-faint">{model.name}</code>
                  {!model.enabled && <Chip>{tr('停用', 'Disabled')}</Chip>}
                </span>
              </>
            )}
          </>
        }
        actions={
          <div className="cmdb-workspace-actions flex flex-wrap items-center justify-end gap-2 max-xl:justify-start">
            <div className="flex flex-wrap items-center gap-1.5">
              <MetaPill
                label={search ? tr('匹配实例', 'Matching instances') : tr('实例总数', 'Total instances')}
                value={numFound}
              />
              <MetaPill label={tr('本页', 'On this page')} value={rows.length} />
              {statusAttribute && (
                <MetaPill
                  label={tr('本页 Active', 'Active on page')}
                  value={activePercent === null ? '—' : `${activePercent}%`}
                />
              )}
              {envAttribute && (
                <MetaPill label={tr('本页 PROD', 'PROD on page')} value={prodCount === null ? '—' : prodCount} />
              )}
              {slaAttribute && (
                <MetaPill label={tr('本页有 SLA', 'With SLA on page')} value={slaCount === null ? '—' : slaCount} />
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => void load(true)}
              disabled={loading || refreshing}
              aria-label={tr('刷新', 'Refresh')}
              title={tr('刷新', 'Refresh')}
              className="size-7 rounded-full px-0"
            >
              <RefreshCw size={14} className={cn(refreshing && 'animate-spin')} aria-hidden="true" />
            </Button>
            <Link
              to="/cmdb/batch"
              className="og-button inline-flex items-center gap-1.5"
              data-size="sm"
              data-variant="outline"
            >
              <FileUp size={12} aria-hidden="true" />
              {tr('批量导入', 'Batch import')}
            </Link>
            <Button
              variant="primary"
              size="sm"
              type="button"
              onClick={() => setEditing({ mode: 'create' })}
              disabled={!model || attributes.length === 0}
              className="inline-flex items-center gap-1.5 font-medium"
            >
              <Plus size={12} aria-hidden="true" />
              {tr('新建实例', 'New instance')}
            </Button>
          </div>
        }
      />

      <div className="flex min-h-0 min-w-0 flex-1">
      {/* THE MODEL RAIL IS NAVIGATION, NOT A GLASS CARD. It mirrors the model
          configuration tree: opaque, full height, with its own scroller. */}
      <aside
        className="hidden h-full min-h-0 w-64 shrink-0 border-r border-border bg-bg lg:flex xl:w-72"
        aria-label={tr('模型导航', 'Model navigation')}
      >
        <div className="flex h-full min-h-0 w-full flex-col">
          <div className="border-b border-border p-3">
            <div className="relative">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint"
                aria-hidden="true"
              />
              <Input
                type="search"
                aria-label={tr('搜索模型对象', 'Search models')}
                placeholder={tr('搜索模型…', 'Search models…')}
                value={modelQuery}
                onChange={(event) => setModelQuery(event.target.value)}
                className="w-full pl-7 text-xs"
              />
            </div>
          </div>

          <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label={tr('模型对象', 'Model objects')}>
            {modelGroupsErr && (
              <div
                role="status"
                className="mx-1 mb-2 flex flex-wrap items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-300"
              >
                <span className="min-w-0 flex-1" title={modelGroupsErr}>
                  {tr('模型分组加载失败，已按平铺显示。', 'Model groups are unavailable; showing a flat list.')}
                </span>
                <button
                  type="button"
                  onClick={() => void loadModelGroups()}
                  className="underline underline-offset-2 hover:text-amber-900 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-amber-500 dark:hover:text-amber-200"
                >
                  {tr('重试', 'Retry')}
                </button>
              </div>
            )}
            {modelsErr ? (
              <div role="alert" className="flex flex-col items-center gap-2 px-2 py-6 text-center">
                <p className="text-xs text-red-600 dark:text-red-300">
                  <span className="font-medium">{tr('无法读取模型', 'Could not load models')}</span>
                  <span className="ms-2">{modelsErr}</span>
                </p>
                <Button variant="outline" size="sm" type="button" onClick={() => void loadModels()}>
                  {tr('重试', 'Retry')}
                </Button>
              </div>
            ) : filteredModels.length === 0 ? (
              <p className="px-2 py-6 text-center text-[11px] text-text-faint">
                {tr('没有匹配的模型', 'No models match')}
              </p>
            ) : groupedRail ? (
              <div className="flex flex-col gap-1">
                {modelSections.map((section) => {
                  const headingID = `cmdb-rail-group-${section.key}`;
                  const bodyID = `cmdb-rail-group-body-${section.key}`;
                  const collapsed = collapsedGroups.has(section.key);
                  return (
                    <section key={section.key} aria-labelledby={headingID} className="flex flex-col gap-0.5">
                      <h3 id={headingID} className="min-w-0 text-[10px] font-medium text-text-faint">
                        <button
                          type="button"
                          onClick={() => toggleGroup(section.key)}
                          aria-expanded={!collapsed}
                          aria-controls={bodyID}
                          className="flex w-full min-w-0 items-center gap-1 rounded-md px-2 py-1 text-left hover:bg-card hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
                        >
                          <ChevronDown
                            size={11}
                            className={cn('shrink-0 transition-transform motion-reduce:transition-none', collapsed && '-rotate-90')}
                            aria-hidden="true"
                          />
                          <Folder size={10} className="shrink-0 text-indigo-400" aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate" title={section.name}>
                            {section.name}
                          </span>
                          <span className="shrink-0 font-mono">{section.rows.length}</span>
                        </button>
                      </h3>
                      {/* Conditional rendering, not the `hidden` attribute or
                          a display class: Tailwind's `flex` overrides the UA
                          `[hidden]` rule, and jsdom has no Tailwind at all. */}
                      <div id={bodyID}>
                        {!collapsed && (
                          <div className="flex flex-col gap-0.5">{section.rows.map(renderModelButton)}</div>
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">{filteredModels.map(renderModelButton)}</div>
            )}
          </nav>

          <div className="border-t border-border p-3">
            <Link
              to="/cmdb/search"
              className="text-[11px] text-text-faint underline-offset-2 hover:text-text hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
            >
              {tr('高级查询', 'Search')}
            </Link>
          </div>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">

        {/* THE FILTER BAR IS CHROME, NOT A CARD. It sits under the workspace
            bar and meets the model rail, exactly like the model list's band, so
            the page reads as one surface and the filters never scroll away. */}
        <div className="cmdb-workspace-band shrink-0 border-b border-border/50 px-4 py-2.5">
                {modelsErr && (
                  <div
                    role="alert"
                    className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-red-500/40 bg-red-500/5 px-2 py-1.5 text-[11px] text-red-600 dark:text-red-300 lg:hidden"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{tr('无法读取模型', 'Could not load models')}</span>
                      <span className="ms-2">{modelsErr}</span>
                    </span>
                    <Button variant="outline" size="sm" type="button" onClick={() => void loadModels()}>
                      {tr('重试', 'Retry')}
                    </Button>
                  </div>
                )}
                <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="lg:hidden">
                      <Select
                        label={tr('模型', 'Model')}
                        value={typeRef}
                        onValueChange={chooseModel}
                        options={models.map((item) => ({ value: item.name, label: item.alias || item.name }))}
                        searchable
                        className="w-full"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {envAttribute && facetValues('environment').length > 0 && (
                        <div
                          className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
                          role="group"
                          aria-label={tr('按环境筛选', 'Filter by environment')}
                        >
                          <span className="text-[11px] font-medium text-text-faint">{tr('环境', 'Env')}</span>
                          <Button
                            variant="plain"
                            size="sm"
                            type="button"
                            aria-pressed={envFilter === 'all'}
                            onClick={() => applyEnvFilter('all')}
                            className={cn('cmdb-liquid-pill', envFilter === 'all' && 'is-active')}
                          >
                            {tr('全部环境', 'All env')}
                          </Button>
                          {facetValues('environment').map((value) => {
                            const label = envAttribute ? choiceText(envAttribute, value) : undefined;
                            return (
                              <Button
                                key={value}
                                variant="plain"
                                size="sm"
                                type="button"
                                aria-pressed={envFilter === value}
                                onClick={() => applyEnvFilter(value)}
                                title={label ? `${label} (${value})` : value}
                                className={cn('cmdb-liquid-pill', envFilter === value && 'is-active')}
                              >
                                {label ?? value.toUpperCase()}
                              </Button>
                            );
                          })}
                          <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
                        </div>
                      )}
                      {levelAttribute && facetValues('level').length > 0 && (
                        <div
                          className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
                          role="group"
                          aria-label={tr('按等级筛选', 'Filter by level')}
                        >
                          <span className="text-[11px] font-medium text-text-faint">{tr('等级', 'Level')}</span>
                          <Button
                            variant="plain"
                            size="sm"
                            type="button"
                            aria-pressed={levelFilter === 'all'}
                            onClick={() => applyLevelFilter('all')}
                            className={cn('cmdb-liquid-pill', levelFilter === 'all' && 'is-active')}
                          >
                            {tr('全部等级', 'All levels')}
                          </Button>
                          {facetValues('level').map((value) => {
                            const label = levelAttribute ? choiceText(levelAttribute, value) : undefined;
                            return (
                              <Button
                                key={value}
                                variant="plain"
                                size="sm"
                                type="button"
                                aria-pressed={levelFilter === value}
                                onClick={() => applyLevelFilter(value)}
                                title={label ? `${label} (${value})` : value}
                                className={cn(
                                  'cmdb-liquid-pill',
                                  value.toLowerCase() === 'critical' && 'text-rose-500',
                                  value.toLowerCase() === 'important' && 'text-amber-500',
                                  levelFilter === value && 'is-active',
                                )}
                              >
                                {label ?? value}
                              </Button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative w-full sm:w-64">
                      <Search
                        size={13}
                        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint"
                        aria-hidden="true"
                      />
                      <Input
                        type="search"
                        aria-label={tr('搜索全部实例', 'Search all instances')}
                        placeholder={tr('搜索名称、代码或任意值…', 'Search name, code or any value…')}
                        value={searchDraft}
                        onChange={(event) => setSearchDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            applySearch();
                          }
                        }}
                        // The native search clear would empty the draft without
                        // resetting the applied query; the explicit X below is
                        // the one control that clears both.
                        className={cn(
                          'w-full pl-7 text-xs [&::-webkit-search-cancel-button]:hidden',
                          search && 'pr-7',
                        )}
                      />
                      {search && (
                        <button
                          type="button"
                          onClick={clearSearch}
                          aria-label={tr('清除搜索', 'Clear search')}
                          title={tr('清除搜索', 'Clear search')}
                          className="absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-text-faint hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    {model && (
                      <InstanceFieldsDialog
                        model={model}
                        attributes={attributes}
                        columns={columns}
                        onSaved={setColumns}
                      />
                    )}
                    <div
                      className="cmdb-liquid-segment flex shrink-0 items-center gap-1 p-1"
                      role="group"
                      aria-label={tr('视图', 'View')}
                    >
                      <Button
                        variant="plain"
                        size="sm"
                        type="button"
                        aria-pressed={view === 'table'}
                        onClick={() => setView('table')}
                        className={cn('cmdb-liquid-segment-button inline-flex items-center gap-1.5', view === 'table' && 'is-active')}
                      >
                        <Table2 size={12} aria-hidden="true" />
                        {tr('列表', 'List')}
                      </Button>
                      <Button
                        variant="plain"
                        size="sm"
                        type="button"
                        aria-pressed={view === 'grid'}
                        onClick={() => setView('grid')}
                        className={cn('cmdb-liquid-segment-button inline-flex items-center gap-1.5', view === 'grid' && 'is-active')}
                      >
                        <LayoutGrid size={12} aria-hidden="true" />
                        {tr('网格', 'Grid')}
                      </Button>
                    </div>
                    {model && (
                      <ExportMenu
                        filename={model.alias || model.name || 'cmdb-instances'}
                        columns={exportColumns}
                        rows={visibleRows}
                        scopes={['all', 'page', 'selected']}
                        totalCount={filtering ? undefined : numFound}
                        selectedCount={selectedCount}
                        fetchAll={fetchAllForExport}
                        fetchSelected={fetchSelectedForExport}
                        disabled={loading || exportColumns.length === 0}
                      />
                    )}
                  </div>
                </div>
                {(search || filtering) && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-faint">
                    {search && (
                      <span>
                        {tr(
                          `在全部实例中搜索「${search}」，命中 ${numFound} 条`,
                          `Searching all instances for “${search}”: ${numFound} matches`,
                        )}
                      </span>
                    )}
                    {filtering && (
                      <span>
                        {tr(
                          `显示 ${visibleRows.length} / ${rows.length} 条本页记录`,
                          `Showing ${visibleRows.length} of ${rows.length} on this page`,
                        )}
                      </span>
                    )}
                  </div>
                )}
                {selectedCount > 0 && (
                  <div
                    role="status"
                    className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-1.5 text-[11px]"
                  >
                    <span className="font-medium text-text">
                      {tr(`已选 ${selectedCount} 项`, `${selectedCount} selected`)}
                    </span>
                    <span className="text-text-muted">
                      {tr(
                        '导出时选择「已选」只导出勾选的实例。',
                        'Choose “Selected” in Export to export only the checked instances.',
                      )}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={clearSelection}
                      className="ms-auto text-text-muted hover:text-text"
                    >
                      {tr('清除选择', 'Clear selection')}
                    </Button>
                  </div>
                )}
        </div>

        <div className="cmdb-liquid relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="cmdb-liquid-blobs" aria-hidden="true">
            <span className="cmdb-liquid-blob cmdb-liquid-blob-a" />
            <span className="cmdb-liquid-blob cmdb-liquid-blob-b" />
            <span className="cmdb-liquid-blob cmdb-liquid-blob-c" />
          </div>
          <div ref={contentRef} className="cmdb-liquid-content relative flex min-h-0 flex-1 flex-col">
            <div className="cmdb-model-config-body flex min-h-0 flex-1 flex-col p-4">
              <section className="cmdb-liquid-panel flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl">
                {view === 'table' ? (
                  <div className="flex min-h-0 flex-1 flex-col p-3">
                    <DataTable
                      fill
                      columns={tableColumns}
                      rows={visibleRows}
                      rowKey={(row) => row.ci_id}
                      selection={tableSelection}
                      loading={loading}
                      error={err}
                      onRetry={() => void load()}
                      storageKey={`instances-${model?.name ?? 'none'}`}
                      empty={
                        model && attributes.length === 0
                          ? tr('这个模型还没有绑定属性，存不了实例。去模型详情里加几个。', 'This model has no bound attributes, so it cannot hold instances. Add some on its page.')
                          : search && rows.length === 0
                            ? tr(`未找到匹配「${search}」的实例`, `No instances match “${search}”`)
                            : visibleRows.length === 0 && rows.length > 0
                              ? tr('没有匹配的实例', 'No matching instances')
                              : tr('还没有实例', 'No instances yet')
                      }
                      actions={(row) => (
                        <span className="flex items-center gap-1 whitespace-nowrap">
                          <Button
                            variant="plain"
                            size="sm"
                            type="button"
                            onClick={() => setViewing({ id: row.ci_id, tab: 'overview' })}
                            aria-label={tr(`查看实例 ${row.ci_id}`, `View instance ${row.ci_id}`)}
                            title={tr(`查看实例 ${row.ci_id}`, `View instance ${row.ci_id}`)}
                            className="cmdb-liquid-action-view inline-flex h-7 w-7 items-center justify-center rounded-md p-0"
                          >
                            <Eye size={13} aria-hidden="true" />
                          </Button>
                          <Button
                            variant="plain"
                            size="sm"
                            type="button"
                            onClick={() => setViewing({ id: row.ci_id, tab: 'topology' })}
                            aria-label={tr(`实例 ${row.ci_id} 拓扑`, `Topology for instance ${row.ci_id}`)}
                            title={tr(`实例 ${row.ci_id} 拓扑`, `Topology for instance ${row.ci_id}`)}
                            className="cmdb-liquid-action-topology inline-flex h-7 w-7 items-center justify-center rounded-md p-0"
                          >
                            <Network size={13} aria-hidden="true" />
                          </Button>
                          <Button
                            variant="plain"
                            size="sm"
                            type="button"
                            onClick={() => setEditing({ mode: 'edit', id: row.ci_id })}
                            aria-label={tr(`编辑实例 ${row.ci_id}`, `Edit instance ${row.ci_id}`)}
                            title={tr(`编辑实例 ${row.ci_id}`, `Edit instance ${row.ci_id}`)}
                            className="cmdb-liquid-action-edit inline-flex h-7 w-7 items-center justify-center rounded-md p-0"
                          >
                            <Pencil size={13} aria-hidden="true" />
                          </Button>
                          <Button
                            variant="plain"
                            size="sm"
                            type="button"
                            onClick={() => void remove(row)}
                            aria-label={tr(`删除实例 ${row.ci_id}`, `Delete instance ${row.ci_id}`)}
                            title={tr(`删除实例 ${row.ci_id}`, `Delete instance ${row.ci_id}`)}
                            className="cmdb-liquid-action-danger inline-flex h-7 w-7 items-center justify-center rounded-md p-0"
                          >
                            <Trash2 size={13} aria-hidden="true" />
                          </Button>
                        </span>
                      )}
                    />
                  </div>
                ) : (
                  <div className="cmdb-model-table-scroll min-h-0 flex-1 overflow-y-auto p-3">
                    {err ? (
                      <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs text-red-600 dark:text-red-300">
                        <span className="min-w-0 flex-1 break-words">{err}</span>
                        <Button variant="ghost" size="sm" type="button" onClick={() => void load()} className="cmdb-liquid-secondary">
                          {tr('重试', 'Retry')}
                        </Button>
                      </div>
                    ) : loading && rows.length === 0 ? (
                  <div className="flex h-40 items-center justify-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</div>
                ) : rows.length === 0 ? (
                  search ? (
                    <EmptyState
                      className="flex min-h-52 flex-col items-center justify-center gap-2 px-4 py-8 text-center"
                      title={tr(`未找到匹配「${search}」的实例`, `No instances match “${search}”`)}
                      hint={tr('换一个关键词，或清除搜索。', 'Try another term, or clear the search.')}
                      action={
                        <Button variant="ghost" size="sm" type="button" onClick={clearSearch} className="cmdb-liquid-secondary">
                          {tr('清除搜索', 'Clear search')}
                        </Button>
                      }
                    />
                  ) : (
                    <EmptyState
                      className="flex min-h-52 flex-col items-center justify-center gap-2 px-4 py-8 text-center"
                      title={tr('还没有实例', 'No instances yet')}
                      hint={
                        model && attributes.length === 0
                          ? tr('这个模型还没有绑定属性，存不了实例。', 'This model has no bound attributes, so it cannot hold instances.')
                          : tr('创建第一条实例开始。', 'Create the first instance to begin.')
                      }
                      action={
                        model && attributes.length > 0 ? (
                          <Button variant="primary" size="sm" type="button" onClick={() => setEditing({ mode: 'create' })} className="inline-flex items-center gap-1.5">
                            <Plus size={12} aria-hidden="true" />
                            {tr('新建实例', 'New instance')}
                          </Button>
                        ) : undefined
                      }
                    />
                  )
                ) : visibleRows.length === 0 ? (
                  <EmptyState
                    className="flex min-h-52 flex-col items-center justify-center gap-2 px-4 py-8 text-center"
                    title={tr('没有匹配的实例', 'No matching instances')}
                    hint={tr('清除环境或等级筛选。', 'Clear the environment or level filter.')}
                    action={
                      <Button variant="ghost" size="sm" type="button" onClick={clearFilters} className="cmdb-liquid-secondary">
                        {tr('清除筛选', 'Clear filters')}
                      </Button>
                    }
                  />
                ) : (
                  <div className="p-4">
                    <div className="mb-3 flex items-center gap-2 text-[11px] text-text-muted">
                      <Checkbox
                        checked={allPageSelected}
                        indeterminate={somePageSelected}
                        onCheckedChange={togglePageSelected}
                        aria-label={tr('选择本页全部', 'Select every row on this page')}
                      />
                      <span>{tr('选择本页', 'Select this page')}</span>
                    </div>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {visibleRows.map((row) => (
                        <InstanceCard
                          key={row.ci_id}
                          row={row}
                          columns={columns}
                          referenceLabels={referenceLabels}
                          environmentAttribute={envAttribute}
                          model={model ?? null}
                          selected={selected.has(row.ci_id)}
                          onSelect={() => toggleSelected(row.ci_id)}
                          onView={() => setViewing({ id: row.ci_id, tab: 'overview' })}
                          onTopology={() => setViewing({ id: row.ci_id, tab: 'topology' })}
                          onEdit={() => setEditing({ mode: 'edit', id: row.ci_id })}
                          onDelete={() => void remove(row)}
                          onSaveFile={(attribute, serialized) => saveFileValue(row, attribute, serialized)}
                        />
                      ))}
                    </div>
                  </div>
                    )}
                  </div>
                )}

                <PaginationFooter
                  embedded
                  page={page}
                  pageSize={PAGE_SIZE}
                  shown={visibleRows.length}
                  total={numFound}
                  loading={loading}
                  showPageNumbers
                  summary={tr(
                    `显示 ${visibleRows.length === 0 ? 0 : page * PAGE_SIZE + 1} 至 ${
                      visibleRows.length === 0 ? 0 : page * PAGE_SIZE + visibleRows.length
                    } 条，共 ${numFound} 条实例`,
                    `Showing ${visibleRows.length === 0 ? 0 : page * PAGE_SIZE + 1}–${
                      visibleRows.length === 0 ? 0 : page * PAGE_SIZE + visibleRows.length
                    } of ${numFound} instances`,
                  )}
                  onPageChange={setPage}
                />
              </section>
            </div>
          </div>
        </div>
      </div>
      </div>

      {editing && model && (
        <InstanceDrawer
          model={model}
          models={models}
          attributes={attributes}
          groups={groups}
          instanceID={editing.mode === 'edit' ? editing.id : null}
          onClose={() => setEditing(null)}
          onSaved={async (message) => {
            setEditing(null);
            toast.success(message);
            await load(true);
          }}
        />
      )}

      {viewing !== null && model && (
        <InstanceDetailDrawer
          model={model}
          models={models}
          attributes={attributes}
          groups={groups}
          instanceID={viewing.id}
          initialTab={viewing.tab}
          onClose={() => setViewing(null)}
          onEdit={(id) => {
            setViewing(null);
            setEditing({ mode: 'edit', id });
          }}
          onInstanceSaved={() => void load(true)}
        />
      )}

      {dialog}
    </div>
  );
}

function InstanceCard({
  row,
  columns,
  referenceLabels,
  environmentAttribute,
  model,
  selected,
  onSelect,
  onView,
  onTopology,
  onEdit,
  onDelete,
  onSaveFile,
}: {
  row: Instance;
  columns: TypeAttribute[];
  referenceLabels: ReferenceLabels;
  environmentAttribute?: TypeAttribute;
  model: CIType | null;
  selected: boolean;
  onSelect(): void;
  onView(): void;
  onTopology(): void;
  onEdit(): void;
  onDelete(): void;
  onSaveFile(attribute: TypeAttribute, serialized: string): void | Promise<void>;
}) {
  const { tr } = useI18n();
  const titleAttribute =
    columns.find((attribute) => attribute.name === 'name') ??
    columns.find((attribute) => attribute.name === model?.unique_key) ??
    columns[0];
  const titleLabel = titleAttribute?.is_reference
    ? referenceText(row.values?.[titleAttribute.name], referenceLabels)
    : titleAttribute
      ? choiceText(titleAttribute, row.values?.[titleAttribute.name])
      : undefined;
  const titleValue = titleLabel ?? (titleAttribute ? displayValue(row.values?.[titleAttribute.name]) : '—');
  const codeAttribute = model?.unique_key ? columns.find((attribute) => attribute.name === model.unique_key) : undefined;
  const codeLabel = codeAttribute?.is_reference
    ? referenceText(row.values?.[codeAttribute.name], referenceLabels)
    : codeAttribute
      ? choiceText(codeAttribute, row.values?.[codeAttribute.name])
      : undefined;
  const codeValue =
    model?.unique_key && model.unique_key !== titleAttribute?.name
      ? codeLabel ?? displayValue(row.values?.[model.unique_key])
      : `#${row.ci_id}`;
  const fields = columns
    .filter((attribute) => attribute.id !== titleAttribute?.id && attribute.name !== 'environment')
    .slice(0, 4);
  const environment = displayValue(row.values?.environment);
  const environmentText = choiceText(environmentAttribute ?? { is_choice: false }, environment) ?? environment;
  const environmentTone =
    environment.toLowerCase() === 'prod' ? 'success' : environment.toLowerCase() === 'test' ? 'info' : 'default';

  return (
    <div
      data-selected={selected || undefined}
      className="cmdb-liquid-card flex min-w-0 flex-col justify-between rounded-2xl p-4"
    >
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2">
            <Checkbox
              checked={selected}
              onCheckedChange={onSelect}
              aria-label={tr(`选择实例 ${row.ci_id}`, `Select instance ${row.ci_id}`)}
              className="mt-0.5"
            />
            <div className="min-w-0">
              <p className="truncate font-mono text-[10px] text-text-faint">{codeValue}</p>
              <h3 className="mt-0.5 truncate text-sm font-bold text-text">
                {titleValue === '—' ? `#${row.ci_id}` : titleValue}
              </h3>
            </div>
          </div>
          {environment !== '—' && <Chip tone={environmentTone} className="shrink-0">{environmentText}</Chip>}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
          {fields.map((attribute) => {
            const value = row.values?.[attribute.name];
            const label = attribute.is_reference
              ? referenceText(value, referenceLabels)
              : choiceText(attribute, value);
            const raw = attribute.is_reference ? referenceRawText(value) : displayValue(value);
            return (
              <div key={attribute.id} className="min-w-0">
                <dt className="truncate text-[10px] text-text-faint">{attribute.alias || attribute.name}</dt>
                <dd
                  className="mt-0.5 min-w-0 truncate text-[11px] text-text-muted"
                  title={attribute.is_file ? undefined : label && label !== raw ? `${label} (${raw})` : raw}
                >
                  {attribute.is_file ? (
                    <FileField
                      key={`${row.ci_id}-${attribute.id}`}
                      compact
                      attribute={attribute}
                      value={value}
                      disabled={attribute.is_computed}
                      loadValue={async () => (await getInstanceFileValues(row.ci_id))[attribute.name]}
                      onChange={(_files, serialized) => onSaveFile(attribute, serialized)}
                    />
                  ) : (
                    <AttributeValue
                      type={isValueTypeCode(attribute.value_type) ? attribute.value_type : '2'}
                      value={value}
                      label={label}
                    />
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3">
        <span className="text-[10px] text-text-faint">#{row.ci_id}</span>
        <span className="flex items-center gap-1 whitespace-nowrap">
          <Button
            variant="plain"
            size="sm"
            type="button"
            onClick={onView}
            aria-label={tr(`查看实例 ${row.ci_id}`, `View instance ${row.ci_id}`)}
            title={tr(`查看实例 ${row.ci_id}`, `View instance ${row.ci_id}`)}
            className="cmdb-liquid-action-view inline-flex h-7 w-7 items-center justify-center rounded-md p-0"
          >
            <Eye size={13} aria-hidden="true" />
          </Button>
          <Button
            variant="plain"
            size="sm"
            type="button"
            onClick={onTopology}
            aria-label={tr(`实例 ${row.ci_id} 拓扑`, `Topology for instance ${row.ci_id}`)}
            title={tr(`实例 ${row.ci_id} 拓扑`, `Topology for instance ${row.ci_id}`)}
            className="cmdb-liquid-action-topology inline-flex h-7 w-7 items-center justify-center rounded-md p-0"
          >
            <Network size={13} aria-hidden="true" />
          </Button>
          <Button
            variant="plain"
            size="sm"
            type="button"
            onClick={onEdit}
            aria-label={tr(`编辑实例 ${row.ci_id}`, `Edit instance ${row.ci_id}`)}
            title={tr(`编辑实例 ${row.ci_id}`, `Edit instance ${row.ci_id}`)}
            className="cmdb-liquid-action-edit inline-flex h-7 w-7 items-center justify-center rounded-md p-0"
          >
            <Pencil size={13} aria-hidden="true" />
          </Button>
          <Button
            variant="plain"
            size="sm"
            type="button"
            onClick={onDelete}
            aria-label={tr(`删除实例 ${row.ci_id}`, `Delete instance ${row.ci_id}`)}
            title={tr(`删除实例 ${row.ci_id}`, `Delete instance ${row.ci_id}`)}
            className="cmdb-liquid-action-danger inline-flex h-7 w-7 items-center justify-center rounded-md p-0"
          >
            <Trash2 size={13} aria-hidden="true" />
          </Button>
        </span>
      </div>
    </div>
  );
}

// --- one instance, in the drawer ---

function InstanceDrawer({
  model,
  models,
  attributes,
  groups,
  instanceID,
  onClose,
  onSaved,
}: {
  model: CIType;
  models: CIType[];
  attributes: TypeAttribute[];
  groups: AttributeGroup[];
  instanceID: number | null;
  onClose(): void;
  onSaved(message: string): void | Promise<void>;
}) {
  const { tr } = useI18n();
  const creating = instanceID === null;

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(!creating);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const referenceLabels = useReferenceLabels([{ values }], attributes, models);

  useEffect(() => {
    if (instanceID === null) return;
    let live = true;
    setLoading(true);
    void Promise.all([
      getInstance(instanceID),
      // The ordinary read omits file values; merge them back before the form
      // renders, otherwise opening and saving an instance would clear its files.
      getInstanceFileValues(instanceID).catch(() => ({}) as Record<string, string>),
    ])
      .then(([got, files]) => live && setValues({ ...(got.values ?? {}), ...files }))
      .catch((error) => live && setErr(describeError(error, tr('无法读取实例', 'Could not load the instance'))))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [instanceID, tr]);

  // THE FORM IS THE MODEL, SECTION BY SECTION. An attribute in no section lands
  // in a trailing group, which is the same rule the backend's group endpoint
  // uses — so the form and the console's own ordering cannot disagree.
  const sections = useMemo(
    () => attributeSections(attributes, groups, tr('其他', 'Other')),
    [attributes, groups, tr],
  );

  const submit = async () => {
    setSubmitting(true);
    setErr(null);
    try {
      const payload = buildValues(attributes, values);
      if (creating) {
        const got = await createInstance({ ci_type: model.id, values: payload, exist_policy: 'reject' });
        await onSaved(tr(`已创建（#${got.ci_id}）`, `Created (#${got.ci_id})`));
      } else {
        await updateInstance(instanceID, { ci_type: model.id, values: payload });
        await onSaved(tr('已保存', 'Saved'));
      }
    } catch (error) {
      // THE INPUT SURVIVES A REFUSAL — the backend's message names the attribute,
      // and retyping a twenty-field form to fix one value is not acceptable.
      setErr(describeError(error, tr('保存失败', 'Could not save')));
    } finally {
      setSubmitting(false);
    }
  };

  const label = displayValue(values[model.unique_key ?? '']) || (creating ? tr('新实例', 'New instance') : `#${instanceID}`);

  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={label}
      description={
        creating
          ? tr(`在「${model.alias || model.name}」下新建一条实例`, `A new instance of “${model.alias || model.name}”`)
          : tr(`#${instanceID}`, `#${instanceID}`)
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button variant="primary" type="button" onClick={() => void submit()} disabled={submitting || loading}>
            {submitting ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
          </Button>
        </div>
      }
    >
      {err && (
        <div role="alert" className="mb-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          {err}
        </div>
      )}

      {loading ? (
        <p className="py-6 text-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="flex flex-col gap-4"
        >
          {sections.map((section) => (
            <fieldset key={section.key}>
              <legend className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-faint">{section.name}</legend>
              <div className="flex flex-col gap-3">
                {section.items.map((attribute) => {
                  const id = `cmdb-instance-${attribute.id}`;
                  const type = isValueTypeCode(attribute.value_type) ? attribute.value_type : '2';
                  const referenceModel =
                    attribute.is_reference && attribute.reference_type_id
                      ? models.find((candidate) => Number(candidate.id) === Number(attribute.reference_type_id))
                      : undefined;
                  return (
                    <div key={attribute.id}>
                      <Label htmlFor={id}>
                        {attribute.alias || attribute.name}
                        {attribute.is_required && <span className="ml-1 text-red-400">*</span>}
                        {attribute.inherited && (
                          <Chip tone="info" dense className="ml-2">
                            {attribute.inherited_from}
                          </Chip>
                        )}
                      </Label>
                      <div className="mt-1">
                        {attribute.is_file ? (
                          <FileField
                            attribute={attribute}
                            value={values[attribute.name]}
                            disabled={attribute.is_computed}
                            onChange={(_files, serialized) =>
                              setValues((current) => ({ ...current, [attribute.name]: serialized }))
                            }
                          />
                        ) : referenceModel ? (
                          <ReferencePicker
                            id={id}
                            attribute={attribute}
                            target={referenceModel}
                            labels={referenceLabels}
                            value={values[attribute.name]}
                            onChange={(next) => setValues((current) => ({ ...current, [attribute.name]: next }))}
                            disabled={attribute.is_computed}
                            required={attribute.is_required}
                            placeholder={attribute.alias || attribute.name}
                          />
                        ) : (
                          <AttributeControl
                            id={id}
                            type={type}
                            isList={attribute.is_list}
                            disabled={attribute.is_computed}
                            required={attribute.is_required}
                            value={values[attribute.name]}
                            onChange={(next) => setValues((current) => ({ ...current, [attribute.name]: next }))}
                            placeholder={attribute.alias || attribute.name}
                          />
                        )}
                      </div>
                      {attribute.is_computed && (
                        <p className="mt-1 text-[11px] text-text-faint">
                          {tr('这个属性由模型计算，不能直接填。', 'The model derives this attribute; it cannot be typed.')}
                        </p>
                      )}
                      {attribute.is_password && (
                        <p className="mt-1 text-[11px] text-text-faint">
                          {tr('密码保存后不会再显示；留空表示保持不变。', 'A saved secret is never shown again; leave it empty to keep the current one.')}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </form>
      )}
    </Drawer>
  );
}

/**
 * Turns the form's state into the write payload.
 *
 * TWO KINDS OF FIELD ARE OMITTED RATHER THAN SENT AS NULL:
 *
 *   - a COMPUTED attribute, because the model derives it and a supplied value is
 *     ignored;
 *   - a PASSWORD whose box is still empty. A read never returns a secret, so the
 *     box starts empty on every edit; sending that `null` would CLEAR the stored
 *     credential on a save that did not touch it.
 *
 * Everything else is sent as it stands, including a `null` the operator emptied
 * on purpose — that is what clearing a field means.
 */
function buildValues(attributes: TypeAttribute[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const attribute of attributes) {
    if (attribute.is_computed) continue;
    const value = values[attribute.name];
    const empty = value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
    if (attribute.is_password && empty) continue;
    out[attribute.name] = value ?? null;
  }
  return out;
}
