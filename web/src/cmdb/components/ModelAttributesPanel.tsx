import { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Eye,
  Fingerprint,
  GitBranch,
  Hash,
  LayoutGrid,
  Pencil,
  Plus,
  Search,
  Table2,
  Trash2,
  Type,
  type LucideIcon,
} from 'lucide-react';

import { Button, EmptyState } from '@/components/ui';
import { Chip } from '@/components/ui/Chip';
import { Checkbox } from '@/components/ui/Checkbox';
import { Hint } from '@/components/ui/Tooltip';
import { Input } from '@/components/ui/Input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Popover';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import type { AttributeGroup, TypeAttribute } from '../api/citype';
import {
  ATTRIBUTE_DISPLAY_TYPE_ORDER,
  ATTRIBUTE_TYPE_META,
  attributeDisplayType,
  type AttributeDisplayType,
} from '../lib/attribute-type';
import { DataTable, type Column } from './DataTable';

// The model's attribute workspace, styled as a scoped liquid-glass surface.
//
// THE GROUPING IS REAL DATA. Attributes belong to form sections, and those are
// the same sections an operator sees on the instance form. The page keeps one
// glass panel per section instead of one flat list so the configuration and the
// resulting form read the same way.
//
// THE EFFECT IS SCOPED. The ambient blobs, translucent panels and the blue
// primary action live under `.cmdb-liquid` only. The rest of the console keeps
// its existing surfaces; the reference HTML is a design direction, not a new
// global theme.

type View = 'table' | 'grid';

type Section = {
  key: string;
  name: string;
  inherited: boolean;
  rows: TypeAttribute[];
};

const MAX_PRIMARY_TYPES = 5;

const GROUP_TONES = [
  'bg-sky-500/10 text-sky-500',
  'bg-violet-500/10 text-violet-500',
  'bg-cyan-500/10 text-cyan-500',
];

export function ModelAttributesPanel({
  rows,
  groups,
  loading,
  isAdmin,
  adminTip,
  onBind,
  onEdit,
  onUnbind,
  onFlag,
  onOpenDictionary,
}: {
  rows: TypeAttribute[];
  groups: AttributeGroup[];
  loading: boolean;
  isAdmin: boolean;
  adminTip?: string;
  onBind(): void;
  onEdit(row: TypeAttribute): void;
  onUnbind(row: TypeAttribute): void;
  onFlag(row: TypeAttribute, patch: { is_required?: boolean; default_show?: boolean }): void;
  onOpenDictionary(): void;
}) {
  const { tr } = useI18n();
  const [query, setQuery] = useState('');
  const [onlyInherited, setOnlyInherited] = useState(false);
  const [onlyRequired, setOnlyRequired] = useState(false);
  const [types, setTypes] = useState<AttributeDisplayType[]>([]);
  const [view, setView] = useState<View>(() =>
    window.matchMedia?.('(max-width: 1279px)')?.matches ? 'grid' : 'table',
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const needle = query.trim().toLowerCase();
  const filtering = needle.length > 0 || onlyInherited || onlyRequired || types.length > 0;

  const filtered = useMemo(
    () =>
      rows.filter((row) => {
        if (onlyInherited && !row.inherited) return false;
        if (onlyRequired && !row.is_required) return false;
        if (types.length > 0) {
          const type = attributeDisplayType(row);
          if (!type || !types.includes(type)) return false;
        }
        if (!needle) return true;
        return row.name.toLowerCase().includes(needle) || row.alias.toLowerCase().includes(needle);
      }),
    [rows, onlyInherited, onlyRequired, needle, types],
  );

  const sections = useMemo<Section[]>(() => {
    const byID = new Map(filtered.map((row) => [row.id, row]));
    const used = new Set<number>();
    const out: Section[] = [];

    for (const group of groups) {
      const groupRows = (group.attributes ?? [])
        .map((attribute) => byID.get(attribute.id))
        .filter((row): row is TypeAttribute => Boolean(row));
      groupRows.forEach((row) => used.add(row.id));
      if (groupRows.length === 0) continue;
      out.push({
        key: group.is_other ? 'other' : `group-${group.id}`,
        name: group.is_other ? tr('其他', 'Other') : group.name || tr('未命名分组', 'Untitled section'),
        inherited: group.inherited,
        rows: groupRows,
      });
    }

    // A group list that failed to load, or a binding added after it was read,
    // must not hide attributes. Anything unclaimed falls into one final section.
    const rest = filtered.filter((row) => !used.has(row.id));
    if (rest.length > 0) {
      out.push({ key: 'ungrouped', name: tr('未分组', 'Ungrouped'), inherited: false, rows: rest });
    }
    if (out.length === 0 && filtered.length > 0) {
      out.push({ key: 'all', name: tr('全部属性', 'All attributes'), inherited: false, rows: filtered });
    }
    return out;
  }, [filtered, groups, tr]);

  // A filter is meant to reveal matches, not leave them inside a group the
  // operator collapsed earlier.
  useEffect(() => {
    if (filtering) setCollapsed(new Set());
  }, [filtering]);

  const requiredCount = rows.filter((row) => row.is_required).length;
  const inheritedCount = rows.filter((row) => row.inherited).length;
  const typeCounts = useMemo(() => {
    const counts = new Map<AttributeDisplayType, number>();
    for (const row of rows) {
      const type = attributeDisplayType(row);
      if (!type) continue;
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return counts;
  }, [rows]);
  const usedTypes = useMemo(
    () => ATTRIBUTE_DISPLAY_TYPE_ORDER.filter((type) => (typeCounts.get(type) ?? 0) > 0),
    [typeCounts],
  );
  // The first five used types are visible; a type selected from the menu is
  // appended so its active state can be turned off without reopening the menu.
  const primaryTypes = useMemo(() => {
    const shown = usedTypes.slice(0, MAX_PRIMARY_TYPES);
    for (const type of ATTRIBUTE_DISPLAY_TYPE_ORDER) {
      if (types.includes(type) && !shown.includes(type)) shown.push(type);
    }
    return shown;
  }, [usedTypes, types]);
  const moreTypeCount = ATTRIBUTE_DISPLAY_TYPE_ORDER.length - primaryTypes.length;

  const clearFilters = () => {
    setQuery('');
    setOnlyInherited(false);
    setOnlyRequired(false);
    setTypes([]);
  };

  const toggleType = (type: AttributeDisplayType) => {
    setTypes((current) =>
      current.includes(type) ? current.filter((item) => item !== type) : [...current, type],
    );
  };

  const allCollapsed = sections.length > 0 && sections.every((section) => collapsed.has(section.key));
  const toggleCollapsed = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const setAllCollapsed = (value: boolean) => {
    setCollapsed(value ? new Set(sections.map((section) => section.key)) : new Set());
  };

  const typeLabel = (row: TypeAttribute) => {
    const type = attributeDisplayType(row);
    return type ? tr(ATTRIBUTE_TYPE_META[type].label[0], ATTRIBUTE_TYPE_META[type].label[1]) : row.value_type;
  };

  const columns: Column<TypeAttribute>[] = [
    {
      key: 'name',
      header: tr('属性名称 / Key', 'Attribute / Key'),
      width: 'w-full min-w-36',
      cell: (row) => (
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-semibold text-text">{row.alias || row.name}</span>
            <code className="cmdb-liquid-key shrink-0">{row.name}</code>
          </div>
          {row.inherited && (
            <div className="mt-0.5 text-[10px] text-text-faint">
              {tr(`继承自 ${row.inherited_from || tr('父模型', 'a parent model')}`, `from ${row.inherited_from || 'a parent model'}`)}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'type',
      header: tr('数据类型', 'Data type'),
      width: 'min-w-[6.5rem]',
      cell: (row) => {
        const type = attributeDisplayType(row);
        return (
          <div className="flex min-w-0 flex-col gap-1">
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <AttributeTypeGlyph type={type} />
              <span className="text-[11px] font-medium text-text-muted">{typeLabel(row)}</span>
            </span>
            {(row.is_list || row.is_choice) && (
              <span className="flex flex-wrap items-center gap-1">
                {row.is_list && <Chip dense>{tr('多值', 'Multi')}</Chip>}
                {row.is_choice && <Chip dense>{tr('选项', 'Choice')}</Chip>}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'index',
      header: tr('检索索引', 'Index'),
      width: 'min-w-20',
      cell: (row) => (
        <Hint content={row.storage_table}>
          <Chip tone={row.is_indexed ? 'success' : 'default'}>
            {row.is_indexed ? tr('可检索', 'Searchable') : tr('非索引', 'Unindexed')}
          </Chip>
        </Hint>
      ),
    },
    {
      key: 'policy',
      header: tr('配置策略', 'Policy'),
      width: 'min-w-[9.5rem]',
      cell: (row) => <PolicyControls row={row} isAdmin={isAdmin} onFlag={onFlag} />,
    },
  ];

  return (
    <div className="cmdb-attribute-workspace cmdb-liquid relative min-w-0 overflow-hidden">
      <div className="cmdb-liquid-blobs" aria-hidden="true">
        <span className="cmdb-liquid-blob cmdb-liquid-blob-a" />
        <span className="cmdb-liquid-blob cmdb-liquid-blob-b" />
        <span className="cmdb-liquid-blob cmdb-liquid-blob-c" />
      </div>

      <div className="cmdb-liquid-content relative flex flex-col gap-3">
        <div className="cmdb-liquid-panel rounded-2xl px-4 py-3.5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <h2 className="text-sm font-bold tracking-tight text-text">{tr('属性', 'Attributes')}</h2>
                <span className="rounded-md bg-text/5 px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
                  {tr(`${rows.length} 个属性`, `${rows.length} attributes`)}
                </span>
                <span className="inline-flex items-center gap-1.5 text-[11px] text-text-muted">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                  {tr('必填', 'Required')} <span className="font-medium text-text">{requiredCount}</span>
                </span>
                <span className="inline-flex items-center gap-1.5 text-[11px] text-text-muted">
                  <span className="h-1.5 w-1.5 rounded-full bg-sky-500" aria-hidden="true" />
                  {tr('继承', 'Inherited')} <span className="font-medium text-text">{inheritedCount}</span>
                </span>
              </div>
              <p className="mt-1.5 max-w-3xl text-[11px] leading-5 text-text-muted">
                {tr(
                  '属性优先存在于属性字典中，绑定至模型后独立生效；相同属性可在不同模型中灵活配置。',
                  'Attributes live in the dictionary first and take effect per model once bound; the same attribute can be configured differently on each model.',
                )}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 lg:justify-end">
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={onOpenDictionary}
                className="cmdb-liquid-secondary inline-flex items-center gap-1.5"
              >
                {tr('属性字典', 'Attribute dictionary')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                type="button"
                onClick={onBind}
                disabled={!isAdmin}
                className="inline-flex items-center gap-1.5"
              >
                <Plus size={12} aria-hidden="true" />
                {tr('绑定属性', 'Bind attributes')}
              </Button>
            </div>
          </div>

          <div className="cmdb-liquid-divider mt-3 border-t pt-3">
            <div className="flex flex-col gap-2.5 min-[1360px]:flex-row min-[1360px]:items-center min-[1360px]:justify-between">
              <div
                role="group"
                aria-label={tr('按数据类型筛选', 'Filter by data type')}
                className="flex min-w-0 flex-wrap items-center gap-1"
              >
                <button
                  type="button"
                  aria-label={tr('全部类型', 'All types')}
                  aria-pressed={types.length === 0}
                  onClick={() => setTypes([])}
                  className={cn('cmdb-liquid-type-filter inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]', types.length === 0 && 'is-active')}
                >
                  {tr('全部', 'All')}
                  <span aria-hidden="true" className="cmdb-attr-type-count">{rows.length}</span>
                </button>
                {primaryTypes.map((type) => {
                  const meta = ATTRIBUTE_TYPE_META[type];
                  const Icon = meta.icon;
                  const active = types.includes(type);
                  const label = tr(meta.label[0], meta.label[1]);
                  return (
                    <button
                      key={type}
                      type="button"
                      aria-label={label}
                      aria-pressed={active}
                      onClick={() => toggleType(type)}
                      title={tr(`只看${meta.label[0]}`, `Show ${meta.label[1]} only`)}
                      className={cn('cmdb-liquid-type-filter inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]', active && 'is-active')}
                    >
                      <Icon size={13} aria-hidden="true" />
                      {label}
                      <span aria-hidden="true" className="cmdb-attr-type-count">{typeCounts.get(type) ?? 0}</span>
                    </button>
                  );
                })}
                <Popover>
                  <PopoverTrigger
                    aria-label={tr('更多类型', 'More types')}
                    className="cmdb-liquid-type-filter inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]"
                  >
                    <ChevronDown size={12} aria-hidden="true" />
                    {tr('更多类型', 'More types')}
                    {moreTypeCount > 0 && (
                      <span aria-hidden="true" className="cmdb-attr-type-count">{moreTypeCount}</span>
                    )}
                  </PopoverTrigger>
                  <PopoverContent className="w-64 max-w-[calc(100vw-2rem)] p-2" aria-label={tr('全部数据类型', 'All data types')}>
                    <div className="mb-1 flex items-center justify-between gap-2 px-1">
                      <span className="text-[11px] font-medium text-text">{tr('全部数据类型', 'All data types')}</span>
                      {types.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setTypes([])}
                          className="text-[10px] text-text-faint hover:text-text"
                        >
                          {tr('清除', 'Clear')}
                        </button>
                      )}
                    </div>
                    <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
                      {ATTRIBUTE_DISPLAY_TYPE_ORDER.map((type) => {
                        const meta = ATTRIBUTE_TYPE_META[type];
                        const Icon = meta.icon;
                        const label = tr(meta.label[0], meta.label[1]);
                        return (
                          <label
                            key={type}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-text-muted hover:bg-text/5"
                          >
                            <Checkbox
                              checked={types.includes(type)}
                              onCheckedChange={() => toggleType(type)}
                              aria-label={tr(`筛选${label}`, `Filter ${label}`)}
                            />
                            <Icon size={13} aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate">{label}</span>
                            <span className="font-mono text-[10px] text-text-faint">{typeCounts.get(type) ?? 0}</span>
                          </label>
                        );
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>

              <div className="flex flex-wrap items-center gap-2 min-[1360px]:justify-end">
                <div className="relative w-full min-w-0 sm:w-56">
                  <Search
                    size={13}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint"
                    aria-hidden="true"
                  />
                  <Input
                    type="search"
                    aria-label={tr('搜索属性', 'Search attributes')}
                    placeholder={tr('搜索属性名、Key 或别名…', 'Search name, key or alias…')}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
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

            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <label className={cn('cmdb-liquid-policy cursor-pointer', onlyRequired && 'is-required')}>
                  <Checkbox
                    checked={onlyRequired}
                    onCheckedChange={(next) => setOnlyRequired(next === true)}
                    aria-label={tr('只看必填属性', 'Required only')}
                  />
                  {tr('只看必填', 'Required')}
                </label>
                <label className={cn('cmdb-liquid-policy cursor-pointer', onlyInherited && 'is-inherited')}>
                  <Checkbox
                    checked={onlyInherited}
                    onCheckedChange={(next) => setOnlyInherited(next === true)}
                    aria-label={tr('只看继承', 'Inherited only')}
                  />
                  {tr('只看继承', 'Inherited')}
                </label>
                {filtering ? (
                  <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-text-faint">
                    {tr(`显示 ${filtered.length} / ${rows.length}`, `showing ${filtered.length} of ${rows.length}`)}
                    <Button
                      variant="plain"
                      size="sm"
                      type="button"
                      onClick={clearFilters}
                      className="cmdb-liquid-plain-action text-[10px]"
                    >
                      {tr('清除筛选', 'Clear filters')}
                    </Button>
                  </span>
                ) : (
                  <span className="text-[11px] text-text-faint">
                    {tr(`${sections.length} 个分组`, `${sections.length} sections`)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="plain"
                  size="sm"
                  type="button"
                  onClick={() => setAllCollapsed(false)}
                  className="cmdb-liquid-plain-action inline-flex items-center gap-1 text-[10px]"
                >
                  <ChevronDown size={12} aria-hidden="true" />
                  {tr('展开全部分组', 'Expand all')}
                </Button>
                <span className="text-text-faint" aria-hidden="true">/</span>
                <Button
                  variant="plain"
                  size="sm"
                  type="button"
                  onClick={() => setAllCollapsed(true)}
                  disabled={allCollapsed}
                  className="cmdb-liquid-plain-action inline-flex items-center gap-1 text-[10px]"
                >
                  <ChevronUp size={12} aria-hidden="true" />
                  {tr('收起全部分组', 'Collapse all')}
                </Button>
              </div>
            </div>
          </div>
        </div>

        {loading && rows.length === 0 ? (
          <div className="cmdb-liquid-panel flex h-40 items-center justify-center rounded-2xl text-xs text-text-muted">
            {tr('加载中…', 'Loading…')}
          </div>
        ) : rows.length === 0 ? (
          <div className="cmdb-liquid-panel rounded-2xl">
            <EmptyState
              className="flex min-h-44 flex-col items-center justify-center gap-2 px-4 py-8 text-center"
              title={tr('还没有属性', 'No attributes yet')}
              hint={tr('绑定属性后，实例表单才会出现对应字段。', 'Bind attributes and their fields will appear on the instance form.')}
              action={
                isAdmin ? (
                  <Button variant="primary" size="sm" type="button" onClick={onBind} className="inline-flex items-center gap-1.5">
                    <Plus size={12} aria-hidden="true" />
                    {tr('绑定属性', 'Bind attributes')}
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="cmdb-liquid-panel rounded-2xl">
            <EmptyState
              className="flex min-h-44 flex-col items-center justify-center gap-2 px-4 py-8 text-center"
              title={tr('没有匹配的属性', 'No matching attributes')}
              hint={tr('换一个关键词，或清除筛选条件。', 'Try another term, or clear the filters.')}
              action={
                <Button variant="ghost" size="sm" type="button" onClick={clearFilters} className="cmdb-liquid-secondary">
                  {tr('清除筛选', 'Clear filters')}
                </Button>
              }
            />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {sections.map((section, index) => {
              const open = !collapsed.has(section.key);
              const inheritedSource =
                section.rows.find((row) => row.inherited)?.inherited_from || tr('父模型', 'a parent model');
              const contentID = `cmdb-liquid-group-${section.key}`;
              return (
                <section
                  key={section.key}
                  className={cn('cmdb-liquid-group rounded-2xl', open && 'is-open')}
                  data-open={open || undefined}
                >
                  <div className="cmdb-liquid-group-header flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-lg', GROUP_TONES[index % GROUP_TONES.length])}>
                        <GitBranch size={12} aria-hidden="true" />
                      </span>
                      <h3 className="min-w-0 text-sm font-bold tracking-tight text-text">
                        <button
                          type="button"
                          onClick={() => toggleCollapsed(section.key)}
                          aria-expanded={open}
                          aria-controls={contentID}
                          className="max-w-full truncate text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
                        >
                          {section.name}
                        </button>
                      </h3>
                      <Chip tone="accent">{tr(`${section.rows.length} 项`, `${section.rows.length} items`)}</Chip>
                      {(section.key === 'other' || section.key === 'ungrouped') && (
                        <span className="text-[11px] text-text-faint">{tr('未分组属性', 'Ungrouped attributes')}</span>
                      )}
                      {section.inherited && (
                        <span className="cmdb-liquid-source inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-2 py-0.5 text-[11px] font-medium text-indigo-500">
                          <GitBranch size={10} aria-hidden="true" />
                          {tr(`来自 ${inheritedSource}`, `from ${inheritedSource}`)}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleCollapsed(section.key)}
                      aria-expanded={open}
                      aria-controls={contentID}
                      className="cmdb-liquid-plain-action inline-flex shrink-0 items-center gap-1 text-[11px] text-text-faint hover:text-text"
                    >
                      {open ? tr('点击折叠', 'Collapse') : tr('点击展开', 'Expand')}
                      <ChevronDown size={14} aria-hidden="true" className={cn('transition-transform', !open && '-rotate-90')} />
                    </button>
                  </div>

                  {open && (
                    <div id={contentID} className="cmdb-liquid-group-body">
                      {view === 'table' ? (
                        <div className="cmdb-attribute-table">
                          <DataTable
                            columns={columns}
                            rows={section.rows}
                            rowKey={(row) => row.id}
                            actionsHeader={tr('操作', 'Actions')}
                            actions={(row) => (
                              <ActionButtons
                                row={row}
                                isAdmin={isAdmin}
                                adminTip={adminTip}
                                onEdit={onEdit}
                                onUnbind={onUnbind}
                              />
                            )}
                          />
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                          {section.rows.map((row) => (
                            <AttributeCard
                              key={row.id}
                              row={row}
                              isAdmin={isAdmin}
                              adminTip={adminTip}
                              onEdit={onEdit}
                              onUnbind={onUnbind}
                              onFlag={onFlag}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function PolicyControls({
  row,
  isAdmin,
  onFlag,
}: {
  row: TypeAttribute;
  isAdmin: boolean;
  onFlag(row: TypeAttribute, patch: { is_required?: boolean; default_show?: boolean }): void;
}) {
  const { tr } = useI18n();
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <label className={cn('cmdb-liquid-policy', row.is_required && 'is-required')}>
        <Checkbox
          checked={row.is_required}
          disabled={!isAdmin}
          onCheckedChange={(next) => onFlag(row, { is_required: next === true })}
          aria-label={tr(`${row.name} 必填`, `${row.name} required`)}
        />
        {tr('必填', 'Required')}
      </label>
      <label className={cn('cmdb-liquid-policy', row.default_show && 'is-shown')}>
        <Checkbox
          checked={row.default_show}
          disabled={!isAdmin}
          onCheckedChange={(next) => onFlag(row, { default_show: next === true })}
          aria-label={tr(`${row.name} 默认显示`, `${row.name} shown by default`)}
        />
        {tr('默认显示', 'Shown')}
      </label>
    </span>
  );
}

function ActionButtons({
  row,
  isAdmin,
  adminTip,
  onEdit,
  onUnbind,
}: {
  row: TypeAttribute;
  isAdmin: boolean;
  adminTip?: string;
  onEdit(row: TypeAttribute): void;
  onUnbind(row: TypeAttribute): void;
}) {
  const { tr } = useI18n();
  return (
    <span className="flex items-center gap-3 whitespace-nowrap">
      <Hint content={row.inherited ? tr('这个属性来自父模型，请到父模型上编辑', 'It comes from a parent model; edit it there') : adminTip}>
        <Button
          variant="link"
          size="sm"
          type="button"
          onClick={() => onEdit(row)}
          disabled={!isAdmin || row.inherited}
          aria-label={tr(`编辑 ${row.name}`, `Edit ${row.name}`)}
          className="cmdb-liquid-action-edit inline-flex items-center gap-1"
        >
          <Pencil size={12} aria-hidden="true" />
          {tr('编辑', 'Edit')}
        </Button>
      </Hint>
      <Hint content={row.inherited ? tr('这个属性来自父模型，请到父模型上解绑', 'It comes from a parent model; unbind it there') : adminTip}>
        <Button
          variant="link"
          size="sm"
          type="button"
          onClick={() => onUnbind(row)}
          disabled={!isAdmin || row.inherited}
          aria-label={tr(`解绑 ${row.name}`, `Unbind ${row.name}`)}
          className="cmdb-liquid-action-danger inline-flex items-center gap-1"
        >
          <Trash2 size={12} aria-hidden="true" />
          {tr('解绑', 'Unbind')}
        </Button>
      </Hint>
    </span>
  );
}

function AttributeTypeGlyph({
  type,
  size = 'sm',
}: {
  type: AttributeDisplayType | null;
  size?: 'sm' | 'lg';
}) {
  const Icon = type ? ATTRIBUTE_TYPE_META[type].icon : Type;
  return (
    <span
      data-attribute-type-icon={type ?? 'unknown'}
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center border border-sky-500/10 bg-sky-500/10 text-sky-500 dark:border-sky-400/10 dark:bg-sky-400/10 dark:text-sky-300',
        size === 'lg' ? 'h-10 w-10 rounded-xl' : 'h-6 w-6 rounded-md',
      )}
    >
      <Icon size={size === 'lg' ? 18 : 13} strokeWidth={1.8} />
    </span>
  );
}

function AttributeFlags({ row }: { row: TypeAttribute }) {
  const { tr } = useI18n();
  const flags: { key: string; label: string; icon: LucideIcon }[] = [];
  if (row.is_unique) {
    flags.push({ key: 'unique', label: tr('唯一', 'Unique'), icon: Fingerprint });
  }
  if (row.default_show) {
    flags.push({ key: 'shown', label: tr('默认显示', 'Shown by default'), icon: Eye });
  }
  if (row.is_sortable) {
    flags.push({ key: 'sortable', label: tr('可排序', 'Sortable'), icon: ArrowUpDown });
  }
  if (row.is_indexed) {
    flags.push({ key: 'indexed', label: tr('可检索', 'Searchable'), icon: Hash });
  }
  if (flags.length === 0) return null;

  return (
    <span className="flex shrink-0 items-center gap-1.5 text-sky-500/80 dark:text-sky-300/80">
      {flags.map(({ key, label, icon: Icon }) => (
        <span key={key} role="img" aria-label={label} title={label} className="inline-flex">
          <Icon size={12} strokeWidth={1.8} aria-hidden="true" />
        </span>
      ))}
    </span>
  );
}

function AttributeCard({
  row,
  isAdmin,
  adminTip,
  onEdit,
  onUnbind,
  onFlag,
}: {
  row: TypeAttribute;
  isAdmin: boolean;
  adminTip?: string;
  onEdit(row: TypeAttribute): void;
  onUnbind(row: TypeAttribute): void;
  onFlag(row: TypeAttribute, patch: { is_required?: boolean; default_show?: boolean }): void;
}) {
  const { tr } = useI18n();
  const type = attributeDisplayType(row);
  const typeLabel = type
    ? tr(ATTRIBUTE_TYPE_META[type].label[0], ATTRIBUTE_TYPE_META[type].label[1])
    : row.value_type;

  return (
    <article className="cmdb-liquid-card relative flex min-w-0 flex-col rounded-xl p-4">
      {row.is_unique && (
        <span className="absolute end-0 top-0 z-10 rounded-bl-lg rounded-tr-xl bg-amber-500 px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm">
          {tr('唯一', 'Unique')}
        </span>
      )}

      <div className="flex min-w-0 items-start gap-3">
        <AttributeTypeGlyph type={type} size="lg" />
        <div className={cn('min-w-0 flex-1', row.is_unique && 'pe-12')}>
          <h4 className="truncate text-sm font-bold text-text">
            {row.is_required && (
              <span aria-hidden="true" className="me-0.5 text-rose-500 dark:text-rose-400">
                *
              </span>
            )}
            {row.alias || row.name}
          </h4>
          <p className="mt-0.5 truncate text-xs text-text-muted">{typeLabel}</p>
          <code className="cmdb-liquid-key mt-1 inline-block max-w-full truncate" title={row.name}>
            {row.name}
          </code>
          {(row.is_list || row.is_choice) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {row.is_list && <Chip dense>{tr('多值', 'Multi')}</Chip>}
              {row.is_choice && <Chip dense>{tr('选项', 'Choice')}</Chip>}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3">
        <PolicyControls row={row} isAdmin={isAdmin} onFlag={onFlag} />
      </div>

      <div className="mt-auto pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3">
          <div className="flex min-w-0 items-center gap-2">
            <AttributeFlags row={row} />
            <span className="min-w-0 truncate text-[11px] text-text-faint">
              {row.inherited
                ? tr(`继承自 ${row.inherited_from || tr('父模型', 'a parent model')}`, `from ${row.inherited_from || 'a parent model'}`)
                : tr('本模型独立属性', 'This model')}
            </span>
          </div>
          <ActionButtons
            row={row}
            isAdmin={isAdmin}
            adminTip={adminTip}
            onEdit={onEdit}
            onUnbind={onUnbind}
          />
        </div>
      </div>
    </article>
  );
}
