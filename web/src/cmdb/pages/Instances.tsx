import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Activity,
  Boxes,
  FileUp,
  LayoutGrid,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Table2,
  Trash2,
} from 'lucide-react';

import { Button, EmptyState } from '@/components/ui';
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
  updateInstance,
  type Instance,
} from '../api/instance';
import { getShowFields } from '../api/preferences';
import { AttributeControl, AttributeValue } from '../components/AttributeControl';
import { CMDBIcon } from '../components/CMDBIcon';
import { DataTable, type Column } from '../components/DataTable';
import { Drawer } from '../components/Drawer';
import { useToast } from '../components/Toast';
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

type View = 'table' | 'grid';

export default function InstancesPage() {
  const { tr } = useI18n();
  const toast = useToast();
  const { confirmAction, dialog } = useDialogs();
  const [params, setParams] = useSearchParams();

  const [models, setModels] = useState<CIType[]>([]);
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
  const [filter, setFilter] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const [envFilter, setEnvFilter] = useState('all');
  const [levelFilter, setLevelFilter] = useState('all');
  const [view, setView] = useState<View>(() =>
    window.matchMedia?.('(max-width: 1279px)')?.matches ? 'grid' : 'table',
  );
  const [editing, setEditing] = useState<{ mode: 'create' } | { mode: 'edit'; id: number } | null>(null);

  // Load the model list once; the URL's `type` decides which one is shown.
  useEffect(() => {
    void listCITypes()
      .then((all) => {
        setModels(all);
        if (!typeRef && all.length > 0) {
          setTypeRef(all[0].name);
        }
      })
      .catch((error) => setErr(describeError(error, tr('无法读取模型', 'Could not load the models'))));
  }, [tr, typeRef]);

  const model = useMemo(
    () => models.find((item) => item.name === typeRef || String(item.id) === typeRef),
    [models, typeRef],
  );

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

  const load = useCallback(
    async (quiet = false) => {
      if (!typeRef) return;
      if (quiet) setRefreshing(true);
      else setLoading(true);
      setErr(null);
      try {
        const got = await listInstances(typeRef, { page: page + 1, count: PAGE_SIZE });
        setRows(got.items ?? []);
        setNumFound(got.numfound ?? 0);
      } catch (error) {
        setErr(describeError(error, tr('无法读取实例', 'Could not load the instances')));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [typeRef, page, tr],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const chooseModel = (name: string) => {
    setTypeRef(name);
    setPage(0);
    setFilter('');
    setEnvFilter('all');
    setLevelFilter('all');
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
      toast.success(tr('已删除', 'Deleted'));
      await load(true);
    } catch (error) {
      toast.error(describeError(error, tr('删除失败', 'Delete failed')));
    }
  };

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

  // A CLIENT-SIDE FILTER OVER THE CURRENT PAGE, not a search. The real filter is
  // 资源搜索; these controls are for narrowing the page an operator can see.
  const visibleRows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return rows.filter((row) => {
      if (envFilter !== 'all' && displayValue(row.values?.environment) !== envFilter) return false;
      if (levelFilter !== 'all' && displayValue(row.values?.level) !== levelFilter) return false;
      if (!needle) return true;
      return Object.values(row.values ?? {}).some((value) => displayValue(value).toLowerCase().includes(needle));
    });
  }, [rows, filter, envFilter, levelFilter]);

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

  const filtering = filter.trim().length > 0 || envFilter !== 'all' || levelFilter !== 'all';
  const clearFilters = () => {
    setFilter('');
    setEnvFilter('all');
    setLevelFilter('all');
  };

  const tableColumns: Column<Instance>[] = columns.map((attribute) => ({
    key: `attr-${attribute.id}`,
    header: attribute.alias || attribute.name,
    width: attribute.name === model?.unique_key ? 'w-full' : undefined,
    sortable: false,
    cell: (row) => (
      <span className="block min-w-0 truncate" title={displayValue(row.values?.[attribute.name])}>
        <AttributeValue
          type={isValueTypeCode(attribute.value_type) ? attribute.value_type : '2'}
          value={row.values?.[attribute.name]}
        />
      </span>
    ),
  }));

  const title = model ? `${tr('资源数据', 'Resources')} · ${model.alias || model.name}` : tr('资源数据', 'Resources');

  const kpis = [
    {
      label: tr('实例总数', 'Total instances'),
      value: numFound,
      suffix: tr('个', ''),
      icon: Boxes,
      tone: 'bg-sky-500/10 text-sky-500',
    },
    {
      label: tr('本页 Active', 'Active on page'),
      value: activePercent === null ? '—' : `${activePercent}%`,
      icon: Activity,
      tone: 'bg-emerald-500/10 text-emerald-500',
    },
    {
      label: tr('本页 PROD', 'PROD on page'),
      value: prodCount === null ? '—' : prodCount,
      suffix: prodCount === null ? '' : tr('个', ''),
      icon: Server,
      tone: 'bg-indigo-500/10 text-indigo-500',
    },
    {
      label: tr('本页有 SLA', 'With SLA on page'),
      value: slaCount === null ? '—' : slaCount,
      suffix: slaCount === null ? '' : tr('个', ''),
      icon: ShieldCheck,
      tone: 'bg-cyan-500/10 text-cyan-500',
    },
  ];

  return (
    <div className="cmdb-liquid relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <div className="cmdb-liquid-blobs" aria-hidden="true">
        <span className="cmdb-liquid-blob cmdb-liquid-blob-a" />
        <span className="cmdb-liquid-blob cmdb-liquid-blob-b" />
        <span className="cmdb-liquid-blob cmdb-liquid-blob-c" />
      </div>

      <div className="cmdb-liquid-content relative min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="flex flex-col gap-4">
          <div className="cmdb-liquid-panel flex flex-col gap-3 rounded-2xl p-4 md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-sky-500 to-indigo-500 text-white shadow-md shadow-sky-500/25">
                {model ? (
                  <CMDBIcon value={model.icon} size={18} label={model.alias || model.name} />
                ) : (
                  <Boxes size={18} aria-hidden="true" />
                )}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-sky-500">
                  <span>{tr('CMDB 资源实例', 'CMDB instances')}</span>
                  <span className="text-text-faint">/</span>
                  <span className="truncate text-text-muted">{model?.name ?? tr('资源数据', 'Resources')}</span>
                </div>
                <h1 className="truncate text-base font-semibold text-text">{title}</h1>
                <p className="mt-0.5 text-xs text-text-muted">
                  {tr(
                    '一个模型下的实例。列来自「我的订阅」，表单由模型的属性生成。',
                    'The instances of one model. The columns come from your subscription; the form is generated from the model.',
                  )}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 md:justify-end">
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => void load(true)}
                disabled={loading || refreshing}
                className="cmdb-liquid-secondary inline-flex items-center gap-1.5"
              >
                <RefreshCw size={12} className={cn(refreshing && 'animate-spin')} aria-hidden="true" />
                {tr('刷新', 'Refresh')}
              </Button>
              <Link
                to="/cmdb/batch"
                className="og-button cmdb-liquid-secondary inline-flex items-center gap-1.5"
                data-size="sm"
                data-variant="ghost"
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
          </div>

          <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start">
            <aside className="hidden w-60 shrink-0 lg:block">
              <div className="cmdb-liquid-panel sticky top-4 rounded-2xl p-3.5">
                <div className="flex items-center justify-between gap-2 px-1">
                  <h2 className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                    {tr('模型对象选择', 'Model objects')}
                  </h2>
                  <Link to="/cmdb/search" className="text-[11px] text-sky-500 hover:underline">
                    {tr('高级查询', 'Search')}
                  </Link>
                </div>
                <div className="relative mt-3">
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
                <nav className="mt-3 max-h-[calc(100vh-300px)] space-y-1 overflow-y-auto pe-1" aria-label={tr('模型对象', 'Model objects')}>
                  {filteredModels.map((item) => {
                    const selected = item.name === typeRef || String(item.id) === typeRef;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => chooseModel(item.name)}
                        aria-pressed={selected}
                        className={cn('cmdb-liquid-model-item', selected && 'is-active')}
                      >
                        <CMDBIcon value={item.icon} size={14} label={item.alias || item.name} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">{item.alias || item.name}</span>
                          <span className="cmdb-liquid-model-key block truncate">{item.name}</span>
                        </span>
                      </button>
                    );
                  })}
                  {filteredModels.length === 0 && (
                    <p className="px-2 py-4 text-center text-[11px] text-text-faint">
                      {tr('没有匹配的模型', 'No models match')}
                    </p>
                  )}
                </nav>
                <p className="cmdb-liquid-divider mt-3 border-t pt-2 text-[10px] text-text-faint">
                  {tr(`${models.length} 个模型`, `${models.length} models`)}
                </p>
              </div>
            </aside>

            <main className="min-w-0 flex-1 space-y-4">
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                {kpis.map((card) => {
                  const Icon = card.icon;
                  return (
                    <div key={card.label} className="cmdb-liquid-panel flex items-center justify-between gap-2 rounded-2xl p-3.5">
                      <div className="min-w-0">
                        <p className="truncate text-[11px] font-medium text-text-muted">{card.label}</p>
                        <p className="mt-0.5 text-xl font-bold text-text">
                          {card.value}
                          {card.suffix && <span className="ms-1 text-xs font-normal text-text-faint">{card.suffix}</span>}
                        </p>
                      </div>
                      <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', card.tone)}>
                        <Icon size={15} aria-hidden="true" />
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="cmdb-liquid-panel rounded-2xl p-3">
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
                        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
                          <span className="text-[11px] font-medium text-text-faint">{tr('环境', 'Env')}</span>
                          <Button
                            variant="plain"
                            size="sm"
                            type="button"
                            aria-pressed={envFilter === 'all'}
                            onClick={() => setEnvFilter('all')}
                            className={cn('cmdb-liquid-pill', envFilter === 'all' && 'is-active')}
                          >
                            {tr('全部环境', 'All env')}
                          </Button>
                          {facetValues('environment').map((value) => (
                            <Button
                              key={value}
                              variant="plain"
                              size="sm"
                              type="button"
                              aria-pressed={envFilter === value}
                              onClick={() => setEnvFilter(value)}
                              className={cn('cmdb-liquid-pill', envFilter === value && 'is-active')}
                            >
                              {value.toUpperCase()}
                            </Button>
                          ))}
                          <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
                        </div>
                      )}
                      {levelAttribute && facetValues('level').length > 0 && (
                        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
                          <span className="text-[11px] font-medium text-text-faint">{tr('等级', 'Level')}</span>
                          <Button
                            variant="plain"
                            size="sm"
                            type="button"
                            aria-pressed={levelFilter === 'all'}
                            onClick={() => setLevelFilter('all')}
                            className={cn('cmdb-liquid-pill', levelFilter === 'all' && 'is-active')}
                          >
                            {tr('全部等级', 'All levels')}
                          </Button>
                          {facetValues('level').map((value) => (
                            <Button
                              key={value}
                              variant="plain"
                              size="sm"
                              type="button"
                              aria-pressed={levelFilter === value}
                              onClick={() => setLevelFilter(value)}
                              className={cn(
                                'cmdb-liquid-pill',
                                value.toLowerCase() === 'critical' && 'text-rose-500',
                                value.toLowerCase() === 'important' && 'text-amber-500',
                                levelFilter === value && 'is-active',
                              )}
                            >
                              {value}
                            </Button>
                          ))}
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
                        aria-label={tr('在本页筛选', 'Filter this page')}
                        placeholder={tr('搜索名称、代码或任意值…', 'Search name, code or any value…')}
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                        className="w-full pl-7 text-xs"
                      />
                    </div>
                    <div className="cmdb-liquid-segment flex shrink-0 items-center gap-1 p-1">
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
                  </div>
                </div>
                {filtering && (
                  <p className="mt-2 text-[11px] text-text-faint">
                    {tr(`显示 ${visibleRows.length} / ${rows.length} 条本页记录`, `Showing ${visibleRows.length} of ${rows.length} on this page`)}
                  </p>
                )}
              </div>

              <div className="cmdb-liquid-panel overflow-hidden rounded-2xl">
                {view === 'table' ? (
                  <DataTable
                    columns={tableColumns}
                    rows={visibleRows}
                    rowKey={(row) => row.ci_id}
                    loading={loading}
                    error={err}
                    onRetry={() => void load()}
                    storageKey={`instances-${model?.name ?? 'none'}`}
                    empty={
                      model && attributes.length === 0
                        ? tr('这个模型还没有绑定属性，存不了实例。去模型详情里加几个。', 'This model has no bound attributes, so it cannot hold instances. Add some on its page.')
                        : visibleRows.length === 0 && rows.length > 0
                          ? tr('没有匹配的实例', 'No matching instances')
                          : tr('还没有实例', 'No instances yet')
                    }
                    actions={(row) => (
                      <span className="flex items-center gap-3 whitespace-nowrap">
                        <Button
                          variant="link"
                          size="sm"
                          type="button"
                          onClick={() => setEditing({ mode: 'edit', id: row.ci_id })}
                          aria-label={tr(`编辑实例 ${row.ci_id}`, `Edit instance ${row.ci_id}`)}
                          className="cmdb-liquid-action-edit inline-flex items-center gap-1"
                        >
                          <Pencil size={12} aria-hidden="true" />
                          {tr('编辑', 'Edit')}
                        </Button>
                        <Button
                          variant="link"
                          size="sm"
                          type="button"
                          onClick={() => void remove(row)}
                          aria-label={tr(`删除实例 ${row.ci_id}`, `Delete instance ${row.ci_id}`)}
                          className="cmdb-liquid-action-danger inline-flex items-center gap-1"
                        >
                          <Trash2 size={12} aria-hidden="true" />
                          {tr('删除', 'Delete')}
                        </Button>
                      </span>
                    )}
                  />
                ) : err ? (
                  <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs text-red-300">
                    <span className="min-w-0 flex-1 break-words">{err}</span>
                    <Button variant="ghost" size="sm" type="button" onClick={() => void load()} className="cmdb-liquid-secondary">
                      {tr('重试', 'Retry')}
                    </Button>
                  </div>
                ) : loading && rows.length === 0 ? (
                  <div className="flex h-40 items-center justify-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</div>
                ) : rows.length === 0 ? (
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
                ) : visibleRows.length === 0 ? (
                  <EmptyState
                    className="flex min-h-52 flex-col items-center justify-center gap-2 px-4 py-8 text-center"
                    title={tr('没有匹配的实例', 'No matching instances')}
                    hint={tr('换一个关键词，或清除环境/等级筛选。', 'Try another term, or clear the environment/level filters.')}
                    action={
                      <Button variant="ghost" size="sm" type="button" onClick={clearFilters} className="cmdb-liquid-secondary">
                        {tr('清除筛选', 'Clear filters')}
                      </Button>
                    }
                  />
                ) : (
                  <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
                    {visibleRows.map((row) => (
                      <InstanceCard
                        key={row.ci_id}
                        row={row}
                        columns={columns}
                        model={model ?? null}
                        onEdit={() => setEditing({ mode: 'edit', id: row.ci_id })}
                        onDelete={() => void remove(row)}
                      />
                    ))}
                  </div>
                )}

                <div className="cmdb-liquid-divider border-t px-3 py-1.5">
                  <PaginationFooter
                    page={page}
                    pageSize={PAGE_SIZE}
                    shown={visibleRows.length}
                    total={numFound}
                    loading={loading}
                    onPageChange={setPage}
                    className="cmdb-liquid-page-footer border-0 bg-transparent py-0"
                  />
                </div>
              </div>
            </main>
          </div>
        </div>
      </div>

      {editing && model && (
        <InstanceDrawer
          model={model}
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

      {dialog}
    </div>
  );
}

function InstanceCard({
  row,
  columns,
  model,
  onEdit,
  onDelete,
}: {
  row: Instance;
  columns: TypeAttribute[];
  model: CIType | null;
  onEdit(): void;
  onDelete(): void;
}) {
  const { tr } = useI18n();
  const titleAttribute =
    columns.find((attribute) => attribute.name === 'name') ??
    columns.find((attribute) => attribute.name === model?.unique_key) ??
    columns[0];
  const titleValue = titleAttribute ? displayValue(row.values?.[titleAttribute.name]) : '—';
  const codeValue =
    model?.unique_key && model.unique_key !== titleAttribute?.name
      ? displayValue(row.values?.[model.unique_key])
      : `#${row.ci_id}`;
  const fields = columns
    .filter((attribute) => attribute.id !== titleAttribute?.id && attribute.name !== 'environment')
    .slice(0, 4);
  const environment = displayValue(row.values?.environment);
  const environmentTone =
    environment.toLowerCase() === 'prod' ? 'success' : environment.toLowerCase() === 'test' ? 'info' : 'default';

  return (
    <div className="cmdb-liquid-card flex min-w-0 flex-col justify-between rounded-2xl p-4">
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-mono text-[10px] text-text-faint">{codeValue}</p>
            <h3 className="mt-0.5 truncate text-sm font-bold text-text">
              {titleValue === '—' ? `#${row.ci_id}` : titleValue}
            </h3>
          </div>
          {environment !== '—' && <Chip tone={environmentTone}>{environment}</Chip>}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
          {fields.map((attribute) => (
            <div key={attribute.id} className="min-w-0">
              <dt className="truncate text-[10px] text-text-faint">{attribute.alias || attribute.name}</dt>
              <dd className="mt-0.5 min-w-0 truncate text-[11px] text-text-muted" title={displayValue(row.values?.[attribute.name])}>
                <AttributeValue
                  type={isValueTypeCode(attribute.value_type) ? attribute.value_type : '2'}
                  value={row.values?.[attribute.name]}
                />
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3">
        <span className="text-[10px] text-text-faint">#{row.ci_id}</span>
        <span className="flex items-center gap-3 whitespace-nowrap">
          <Button
            variant="link"
            size="sm"
            type="button"
            onClick={onEdit}
            aria-label={tr(`编辑实例 ${row.ci_id}`, `Edit instance ${row.ci_id}`)}
            className="cmdb-liquid-action-edit inline-flex items-center gap-1"
          >
            <Pencil size={12} aria-hidden="true" />
            {tr('编辑', 'Edit')}
          </Button>
          <Button
            variant="link"
            size="sm"
            type="button"
            onClick={onDelete}
            aria-label={tr(`删除实例 ${row.ci_id}`, `Delete instance ${row.ci_id}`)}
            className="cmdb-liquid-action-danger inline-flex items-center gap-1"
          >
            <Trash2 size={12} aria-hidden="true" />
            {tr('删除', 'Delete')}
          </Button>
        </span>
      </div>
    </div>
  );
}

// --- one instance, in the drawer ---

function InstanceDrawer({
  model,
  attributes,
  groups,
  instanceID,
  onClose,
  onSaved,
}: {
  model: CIType;
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

  useEffect(() => {
    if (instanceID === null) return;
    let live = true;
    setLoading(true);
    void getInstance(instanceID)
      .then((got) => live && setValues({ ...(got.values ?? {}) }))
      .catch((error) => live && setErr(describeError(error, tr('无法读取实例', 'Could not load the instance'))))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [instanceID, tr]);

  // THE FORM IS THE MODEL, SECTION BY SECTION. An attribute in no section lands
  // in a trailing group, which is the same rule the backend's group endpoint
  // uses — so the form and the console's own ordering cannot disagree.
  const sections = useMemo(() => {
    const claimed = new Set<number>();
    const out = groups
      .filter((group) => !group.is_other)
      .map((group) => {
        const items = group.attributes
          .map((attribute) => attributes.find((candidate) => candidate.id === attribute.id))
          .filter((attribute): attribute is TypeAttribute => Boolean(attribute));
        items.forEach((attribute) => claimed.add(attribute.id));
        return { key: `g-${group.id}`, name: group.name, items };
      })
      .filter((section) => section.items.length > 0);
    const rest = attributes.filter((attribute) => !claimed.has(attribute.id));
    if (rest.length > 0) out.push({ key: 'other', name: tr('其他', 'Other'), items: rest });
    return out;
  }, [groups, attributes, tr]);

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
