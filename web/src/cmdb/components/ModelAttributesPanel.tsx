import { useMemo, useState } from 'react';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';

import { Button, EmptyState } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { Checkbox } from '@/components/ui/Checkbox';
import { Hint } from '@/components/ui/Tooltip';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/i18n/locale';

import type { AttributeGroup, TypeAttribute } from '../api/citype';
import { VALUE_TYPE_LABELS, isValueTypeCode } from '../lib/valuetype';

// The model's attribute list, grouped by the sections that also divide its
// instance form.
//
// THE TABLE WAS FLAT; THE DATA IS NOT. A model's attributes belong to form
// sections, and those sections are what an operator already sees when editing
// an instance. Showing the same grouping here makes the configuration page and
// the form agree without opening the separate sections tab.
//
// The rows stay a dense list rather than becoming one card per attribute: a
// model can carry dozens of fields, and repeated cards turn scanning into
// scrolling. Search and the inherited filter are client-side because the page
// already has the model's effective set.

type Section = {
  key: string;
  name: string;
  inherited: boolean;
  rows: TypeAttribute[];
};

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

  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      rows.filter((row) => {
        if (onlyInherited && !row.inherited) return false;
        if (!needle) return true;
        return row.name.toLowerCase().includes(needle) || row.alias.toLowerCase().includes(needle);
      }),
    [rows, onlyInherited, needle],
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

  const requiredCount = rows.filter((row) => row.is_required).length;
  const inheritedCount = rows.filter((row) => row.inherited).length;
  const filtering = needle.length > 0 || onlyInherited;
  const clearFilters = () => {
    setQuery('');
    setOnlyInherited(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-text-muted">
          {tr(
            '属性先存在于字典里，再绑定到模型上；同名属性可以在多个模型上使用，每个模型的绑定设置各自独立。',
            'An attribute exists in the dictionary first and is then bound to a model. One attribute can be on several models, and each binding has its own settings.',
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" type="button" onClick={onOpenDictionary} className="inline-flex items-center gap-1.5">
            {tr('属性字典', 'Attribute dictionary')}
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={onBind} disabled={!isAdmin} className="inline-flex items-center gap-1.5">
            <Plus size={12} aria-hidden="true" />
            {tr('绑定属性', 'Bind attributes')}
          </Button>
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-text">{tr(`${rows.length} 个属性`, `${rows.length} attributes`)}</span>
            <span className="text-text-faint" aria-hidden="true">·</span>
            <span className="text-text-muted">{tr(`必填 ${requiredCount}`, `${requiredCount} required`)}</span>
            <span className="text-text-faint" aria-hidden="true">·</span>
            <span className="text-text-muted">{tr(`继承 ${inheritedCount}`, `${inheritedCount} inherited`)}</span>
          </div>
          <div className="ms-auto flex w-full flex-wrap items-center gap-3 sm:w-auto">
            <div className="relative min-w-0 flex-1 sm:flex-none">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint"
                aria-hidden="true"
              />
              <Input
                type="search"
                aria-label={tr('搜索属性', 'Search attributes')}
                placeholder={tr('搜索属性名或别名', 'Search name or alias')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="w-full pl-7 text-xs sm:w-56"
              />
            </div>
            <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-text-muted">
              <Checkbox
                checked={onlyInherited}
                onCheckedChange={(next) => setOnlyInherited(next === true)}
                aria-label={tr('只看继承', 'Inherited only')}
              />
              {tr('只看继承', 'Inherited only')}
            </label>
          </div>
        </div>

        {loading && rows.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</div>
        ) : rows.length === 0 ? (
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
        ) : filtered.length === 0 ? (
          <EmptyState
            className="flex min-h-44 flex-col items-center justify-center gap-2 px-4 py-8 text-center"
            title={tr('没有匹配的属性', 'No matching attributes')}
            hint={tr('换一个关键词，或清除筛选条件。', 'Try another term, or clear the filters.')}
            action={
              <Button variant="outline" size="sm" type="button" onClick={clearFilters}>
                {tr('清除筛选', 'Clear filters')}
              </Button>
            }
          />
        ) : (
          <div className="divide-y divide-border">
            {sections.map((section) => {
              const inheritedSource =
                section.rows.find((row) => row.inherited)?.inherited_from || tr('父模型', 'a parent model');
              return (
                <section key={section.key} className="px-3 py-2 sm:px-4">
                  <div className="flex flex-wrap items-center gap-2 px-2 pb-1.5 pt-1">
                    <h3 className="text-[11px] font-medium text-text-muted">{section.name}</h3>
                    <span className="text-[10px] text-text-faint">{section.rows.length}</span>
                    {section.inherited && (
                      <Chip tone="info">{tr(`继承自 ${inheritedSource}`, `from ${inheritedSource}`)}</Chip>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-1 lg:grid-cols-2">
                    {section.rows.map((row) => (
                      <AttributeRow
                        key={row.id}
                        row={row}
                        sectionInherited={section.inherited}
                        sectionSource={inheritedSource}
                        isAdmin={isAdmin}
                        adminTip={adminTip}
                        onEdit={onEdit}
                        onUnbind={onUnbind}
                        onFlag={onFlag}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </Card>

      {filtering && filtered.length > 0 && (
        <p className="text-[11px] text-text-faint">
          {tr(`显示 ${filtered.length} / ${rows.length} 个属性`, `Showing ${filtered.length} of ${rows.length} attributes`)}
        </p>
      )}
    </div>
  );
}

function AttributeRow({
  row,
  sectionInherited,
  sectionSource,
  isAdmin,
  adminTip,
  onEdit,
  onUnbind,
  onFlag,
}: {
  row: TypeAttribute;
  sectionInherited: boolean;
  sectionSource: string;
  isAdmin: boolean;
  adminTip?: string;
  onEdit(row: TypeAttribute): void;
  onUnbind(row: TypeAttribute): void;
  onFlag(row: TypeAttribute, patch: { is_required?: boolean; default_show?: boolean }): void;
}) {
  const { tr } = useI18n();
  const typeLabel = isValueTypeCode(row.value_type) ? VALUE_TYPE_LABELS[row.value_type] : null;
  const source = row.inherited_from || tr('父模型', 'a parent model');
  // The section header already names the parent model; repeating it on every
  // row in that section is noise. A mixed section still marks its own rows.
  const showInherited = row.inherited && (!sectionInherited || source !== sectionSource);

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md px-2 py-2.5 transition-colors hover:bg-card/60">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate text-xs font-medium text-text">{row.alias || row.name}</span>
            {showInherited && <Chip tone="info">{tr(`继承自 ${source}`, `from ${source}`)}</Chip>}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-text-faint">{row.name}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <Chip>{typeLabel ? tr(typeLabel[0], typeLabel[1]) : row.value_type}</Chip>
            {row.is_list && <Chip>{tr('多值', 'Multi')}</Chip>}
            {row.is_password && <Chip tone="warning">{tr('密码', 'Secret')}</Chip>}
            {row.is_reference && <Chip tone="info">{tr('引用', 'Reference')}</Chip>}
            <Hint content={row.storage_table}>
              <Chip tone={row.is_indexed ? 'success' : 'default'}>
                {row.is_indexed ? tr('可检索', 'Searchable') : tr('非索引', 'Unindexed')}
              </Chip>
            </Hint>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Hint content={row.inherited ? tr('这个属性来自父模型，请到父模型上编辑', 'It comes from a parent model; edit it there') : adminTip}>
            <Button
              variant="subtle"
              size="sm"
              type="button"
              onClick={() => onEdit(row)}
              disabled={!isAdmin || row.inherited}
              aria-label={tr(`编辑 ${row.name}`, `Edit ${row.name}`)}
              className="inline-flex items-center gap-1"
            >
              <Pencil size={12} aria-hidden="true" />
              <span className="hidden 2xl:inline">{tr('编辑', 'Edit')}</span>
            </Button>
          </Hint>
          <Hint content={row.inherited ? tr('这个属性来自父模型，请到父模型上解绑', 'It comes from a parent model; unbind it there') : adminTip}>
            <Button
              variant="dangerGhost"
              size="sm"
              type="button"
              onClick={() => onUnbind(row)}
              disabled={!isAdmin || row.inherited}
              aria-label={tr(`解绑 ${row.name}`, `Unbind ${row.name}`)}
              className="inline-flex items-center gap-1"
            >
              <Trash2 size={12} aria-hidden="true" />
              <span className="hidden 2xl:inline">{tr('解绑', 'Unbind')}</span>
            </Button>
          </Hint>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-text-muted">
        <label className="inline-flex items-center gap-1.5">
          <Checkbox
            checked={row.is_required}
            disabled={!isAdmin}
            onCheckedChange={(next) => onFlag(row, { is_required: next === true })}
            aria-label={tr(`${row.name} 必填`, `${row.name} required`)}
          />
          {tr('必填', 'Required')}
        </label>
        <label className="inline-flex items-center gap-1.5">
          <Checkbox
            checked={row.default_show}
            disabled={!isAdmin}
            onCheckedChange={(next) => onFlag(row, { default_show: next === true })}
            aria-label={tr(`${row.name} 默认显示`, `${row.name} shown by default`)}
          />
          {tr('默认显示', 'Shown by default')}
        </label>
      </div>
    </div>
  );
}
