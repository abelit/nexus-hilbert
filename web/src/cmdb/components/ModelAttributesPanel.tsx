import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  GitBranch,
  LayoutGrid,
  Lightbulb,
  Pencil,
  Plus,
  Search,
  Table2,
  Trash2,
} from 'lucide-react';

import { Button, EmptyState } from '@/components/ui';
import { Chip } from '@/components/ui/Chip';
import { Checkbox } from '@/components/ui/Checkbox';
import { Hint } from '@/components/ui/Tooltip';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import type { AttributeGroup, TypeAttribute } from '../api/citype';
import { DataTable, type Column } from './DataTable';
import { VALUE_TYPE_LABELS, isValueTypeCode } from '../lib/valuetype';

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
  const [view, setView] = useState<View>(() =>
    window.matchMedia?.('(max-width: 1279px)')?.matches ? 'grid' : 'table',
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const needle = query.trim().toLowerCase();
  const filtering = needle.length > 0 || onlyInherited || onlyRequired;

  const filtered = useMemo(
    () =>
      rows.filter((row) => {
        if (onlyInherited && !row.inherited) return false;
        if (onlyRequired && !row.is_required) return false;
        if (!needle) return true;
        return row.name.toLowerCase().includes(needle) || row.alias.toLowerCase().includes(needle);
      }),
    [rows, onlyInherited, onlyRequired, needle],
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

  const clearFilters = () => {
    setQuery('');
    setOnlyInherited(false);
    setOnlyRequired(false);
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
    const label = isValueTypeCode(row.value_type) ? VALUE_TYPE_LABELS[row.value_type] : null;
    return label ? tr(label[0], label[1]) : row.value_type;
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
      width: 'min-w-[4.5rem]',
      cell: (row) => (
        <span className="flex items-center gap-1 whitespace-nowrap">
          <Chip>{typeLabel(row)}</Chip>
          {row.is_list && <Chip>{tr('多值', 'Multi')}</Chip>}
          {row.is_password && <Chip tone="warning">{tr('密码', 'Secret')}</Chip>}
          {row.is_reference && <Chip tone="info">{tr('引用', 'Reference')}</Chip>}
        </span>
      ),
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
    <div className="cmdb-liquid relative min-w-0 overflow-hidden">
      <div className="cmdb-liquid-blobs" aria-hidden="true">
        <span className="cmdb-liquid-blob cmdb-liquid-blob-a" />
        <span className="cmdb-liquid-blob cmdb-liquid-blob-b" />
        <span className="cmdb-liquid-blob cmdb-liquid-blob-c" />
      </div>

      <div className="cmdb-liquid-content relative flex flex-col gap-4">
        <div className="cmdb-liquid-panel rounded-2xl p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-3 text-xs text-text-muted">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-500">
                <Lightbulb size={14} aria-hidden="true" />
              </span>
              <p className="leading-5">
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

          <div className="cmdb-liquid-divider mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-3">
            <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 sm:w-auto">
              <label className="cmdb-liquid-filter inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-text-muted">
                <Checkbox
                  checked={onlyRequired}
                  onCheckedChange={(next) => setOnlyRequired(next === true)}
                  aria-label={tr('只看必填属性', 'Required only')}
                />
                {tr('只看必填属性', 'Required only')}
              </label>
              <label className="cmdb-liquid-filter inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-text-muted">
                <Checkbox
                  checked={onlyInherited}
                  onCheckedChange={(next) => setOnlyInherited(next === true)}
                  aria-label={tr('只看继承', 'Inherited only')}
                />
                {tr('只看继承', 'Inherited only')}
              </label>
            </div>
            <div className="relative w-full min-w-0 sm:w-60">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint"
                aria-hidden="true"
              />
              <Input
                type="search"
                aria-label={tr('搜索属性', 'Search attributes')}
                placeholder={tr('搜索属性名或 Key…', 'Search name or key…')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="w-full pl-7 text-xs"
              />
            </div>
            <div className="cmdb-liquid-segment ms-auto flex shrink-0 items-center gap-1 p-1">
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

        <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-text-muted">
          <div className="flex flex-wrap items-center gap-2">
            <span>{tr('模型共有', 'Model has')}</span>
            <span className="font-medium text-text">{tr(`${rows.length} 个属性`, `${rows.length} attributes`)}</span>
            <span className="text-text-faint" aria-hidden="true">·</span>
            <span className="font-medium text-amber-500">{tr(`必填 ${requiredCount}`, `${requiredCount} required`)}</span>
            <span className="text-text-faint" aria-hidden="true">·</span>
            <span className="font-medium text-sky-500">{tr(`继承 ${inheritedCount}`, `${inheritedCount} inherited`)}</span>
            {filtering && (
              <>
                <span className="text-text-faint" aria-hidden="true">·</span>
                <span className="text-text-faint">
                  {tr(`显示 ${filtered.length} / ${rows.length}`, `showing ${filtered.length} of ${rows.length}`)}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="plain"
              size="sm"
              type="button"
              onClick={() => setAllCollapsed(false)}
              className="cmdb-liquid-plain-action inline-flex items-center gap-1"
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
              className="cmdb-liquid-plain-action inline-flex items-center gap-1"
            >
              <ChevronUp size={12} aria-hidden="true" />
              {tr('收起全部分组', 'Collapse all')}
            </Button>
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
                      ) : (
                        <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
                          {section.rows.map((row) => (
                            <AttributeCard
                              key={row.id}
                              row={row}
                              typeLabel={typeLabel(row)}
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

function AttributeCard({
  row,
  typeLabel,
  isAdmin,
  adminTip,
  onEdit,
  onUnbind,
  onFlag,
}: {
  row: TypeAttribute;
  typeLabel: string;
  isAdmin: boolean;
  adminTip?: string;
  onEdit(row: TypeAttribute): void;
  onUnbind(row: TypeAttribute): void;
  onFlag(row: TypeAttribute, patch: { is_required?: boolean; default_show?: boolean }): void;
}) {
  const { tr } = useI18n();
  return (
    <div className="cmdb-liquid-card flex min-w-0 flex-col justify-between rounded-xl p-4">
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h4 className="truncate text-sm font-bold text-text">{row.alias || row.name}</h4>
            <p className="mt-0.5 truncate font-mono text-[11px] text-text-faint">{row.name}</p>
          </div>
          <Chip tone={row.is_indexed ? 'success' : 'default'}>
            {row.is_indexed ? tr('可检索', 'Searchable') : tr('非索引', 'Unindexed')}
          </Chip>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Chip>{typeLabel}</Chip>
          {row.is_list && <Chip>{tr('多值', 'Multi')}</Chip>}
          {row.is_password && <Chip tone="warning">{tr('密码', 'Secret')}</Chip>}
          {row.is_reference && <Chip tone="info">{tr('引用', 'Reference')}</Chip>}
        </div>
        <div className="mt-3">
          <PolicyControls row={row} isAdmin={isAdmin} onFlag={onFlag} />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3">
        <span className="text-[11px] text-text-faint">
          {row.inherited
            ? tr(`继承自 ${row.inherited_from || tr('父模型', 'a parent model')}`, `from ${row.inherited_from || 'a parent model'}`)
            : tr('本模型独立属性', 'This model')}
        </span>
        <ActionButtons
          row={row}
          isAdmin={isAdmin}
          adminTip={adminTip}
          onEdit={onEdit}
          onUnbind={onUnbind}
        />
      </div>
    </div>
  );
}
