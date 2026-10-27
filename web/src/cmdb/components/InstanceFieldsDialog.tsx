import { useMemo, useRef, useState } from 'react';
import { Check, Columns3, Lock, Search, X } from 'lucide-react';

import { Button } from '@/components/ui';
import { Checkbox } from '@/components/ui/Checkbox';
import { Chip } from '@/components/ui/Chip';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import type { CIType, TypeAttribute } from '../api/citype';
import { describeError } from '../api/http';
import { setShowFields } from '../api/preferences';
import { isValueTypeCode, VALUE_TYPE_LABELS } from '../lib/valuetype';
import { useToast } from './Toast';

// The model's attribute dictionary, opened from the resource list.
//
// CANTOR'S 属性说明, WITH THE COLUMN PICKER ATTACHED: the table answers "what is
// this field" (name, alias, type, and the seven flags the backend derives) while
// the first checkbox column answers "should this list show it". Splitting those
// into two screens would make the operator open one to learn a field's type and
// the other to add it.
//
// THE COMPLETE LIST IS THE POINT: an operator who can only see the current
// columns has no way to discover the rest.
//
// The identifying attribute cannot be hidden — a row without it has no name —
// and its row carries a lock instead of an enabled checkbox.

const FLAGS = [
  { key: 'searchable', zh: '可检索', en: 'Searchable', on: (row: TypeAttribute) => row.is_indexed },
  { key: 'shown', zh: '默认展示', en: 'Shown by default', on: (row: TypeAttribute) => row.default_show },
  { key: 'unique', zh: '唯一', en: 'Unique', on: (row: TypeAttribute) => row.is_unique },
  { key: 'choice', zh: '枚举', en: 'Choice', on: (row: TypeAttribute) => row.is_choice },
  { key: 'multi', zh: '多值', en: 'Multi', on: (row: TypeAttribute) => row.is_list },
  { key: 'sortable', zh: '可排序', en: 'Sortable', on: (row: TypeAttribute) => row.is_sortable },
  { key: 'computed', zh: '计算属性', en: 'Computed', on: (row: TypeAttribute) => row.is_computed },
] as const;

export function InstanceFieldsDialog({
  model,
  attributes,
  columns,
  onSaved,
}: {
  model: CIType;
  attributes: TypeAttribute[];
  columns: TypeAttribute[];
  onSaved(next: TypeAttribute[]): void;
}) {
  const { tr } = useI18n();
  const toast = useToast();
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const modelLabel = model.alias ? `${model.alias} (${model.name})` : model.name;

  const pinnedId = useMemo(() => {
    const identifier =
      attributes.find((attribute) => attribute.name === model.unique_key) ??
      attributes.find((attribute) => attribute.is_unique);
    return identifier?.id;
  }, [attributes, model.unique_key]);

  // The identifier leads; the rest keep the model's own order so the table and
  // the resulting columns read like the model form rather than like clicks.
  const ordered = useMemo(() => {
    const sorted = [...attributes].sort(
      (left, right) =>
        left.order - right.order ||
        (left.alias || left.name).localeCompare(right.alias || right.name),
    );
    const pinned = sorted.find((attribute) => attribute.id === pinnedId);
    return pinned ? [pinned, ...sorted.filter((attribute) => attribute.id !== pinned.id)] : sorted;
  }, [attributes, pinnedId]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return ordered;
    return ordered.filter((attribute) =>
      `${attribute.alias ?? ''} ${attribute.name}`.toLowerCase().includes(needle),
    );
  }, [ordered, search]);

  const pickedCount = ordered.filter(
    (attribute) => attribute.id === pinnedId || selected.has(attribute.id),
  ).length;

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setSelected(new Set(columns.map((attribute) => attribute.id)));
      setSearch('');
      setError(null);
    }
    setOpen(next);
  };

  const toggle = (attribute: TypeAttribute) => {
    if (attribute.id === pinnedId) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(attribute.id)) next.delete(attribute.id);
      else next.add(attribute.id);
      return next;
    });
  };

  const save = async () => {
    if (saving) return;
    const picked = ordered.filter(
      (attribute) => attribute.id === pinnedId || selected.has(attribute.id),
    );
    if (picked.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await setShowFields(
        model.id,
        picked.map((attribute) => ({
          ref: String(attribute.id),
          is_fixed: attribute.id === pinnedId,
        })),
      );
      onSaved(picked);
      toast.success(tr('已保存字段显示', 'Visible fields saved'));
      setOpen(false);
    } catch (cause) {
      setError(describeError(cause, tr('保存失败', 'Could not save')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={() => handleOpenChange(true)}
        aria-label={tr('查看并选择模型字段', 'View and choose model fields')}
        className="inline-flex h-8 shrink-0 items-center gap-1.5"
      >
        <Columns3 size={13} aria-hidden="true" />
        {tr('字段', 'Fields')}
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          initialFocus={searchRef}
          className="flex max-h-[min(85vh,48rem)] w-[min(64rem,calc(100vw-2rem))] max-w-none flex-col p-0"
        >
          <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <DialogTitle className="text-base font-semibold text-text">
                {tr(`${modelLabel} · 属性说明`, `${modelLabel} · Attributes`)}
              </DialogTitle>
              <DialogDescription className="mt-1 text-xs leading-5 text-text-muted">
                {tr(
                  `当前模型「${modelLabel}」全部属性的定义；勾选决定列表和卡片显示的列。`,
                  `Every attribute defined for ${modelLabel}; the checkboxes choose the list and card columns.`,
                )}
              </DialogDescription>
            </div>
            <button
              type="button"
              onClick={() => handleOpenChange(false)}
              aria-label={tr('关闭', 'Close')}
              className="shrink-0 rounded p-1 text-text-faint hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </header>

          <div className="px-5 pt-3">
            <div className="relative max-w-sm">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint"
                aria-hidden="true"
              />
              <Input
                ref={searchRef}
                type="search"
                aria-label={tr('搜索属性', 'Search attributes')}
                placeholder={tr('搜索属性名', 'Search attributes')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="w-full pl-7 text-xs"
              />
            </div>
          </div>

          <div className="mt-3 min-h-0 flex-1 overflow-auto px-5">
            <table className="w-full min-w-[58rem] border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border text-left text-[11px] font-medium text-text-muted">
                  <th scope="col" className="w-14 whitespace-nowrap px-3 py-2">{tr('显示', 'Show')}</th>
                  <th scope="col" className="whitespace-nowrap px-3 py-2">{tr('名称', 'Name')}</th>
                  <th scope="col" className="whitespace-nowrap px-3 py-2">{tr('别名', 'Alias')}</th>
                  <th scope="col" className="whitespace-nowrap px-3 py-2">{tr('类型', 'Type')}</th>
                  {FLAGS.map((flag) => (
                    <th key={flag.key} scope="col" className="whitespace-nowrap px-3 py-2 text-center">
                      {tr(flag.zh, flag.en)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={4 + FLAGS.length} className="px-3 py-10 text-center text-text-faint">
                      {tr('没有匹配的字段', 'No fields match')}
                    </td>
                  </tr>
                ) : (
                  visible.map((attribute) => {
                    const pinned = attribute.id === pinnedId;
                    const checked = pinned || selected.has(attribute.id);
                    return (
                      <tr key={attribute.id} className="border-b border-border/60 last:border-b-0 hover:bg-card/60">
                        <td className="px-3 py-2">
                          <span className="inline-flex items-center gap-1">
                            <Checkbox
                              checked={checked}
                              disabled={pinned}
                              onCheckedChange={() => toggle(attribute)}
                              aria-label={attribute.alias || attribute.name}
                            />
                            {pinned && (
                              <Lock
                                size={10}
                                role="img"
                                aria-label={tr('标识列，固定显示', 'Identifying column, always shown')}
                                className="text-text-faint"
                              />
                            )}
                          </span>
                        </td>
                        <td className={cn('whitespace-nowrap px-3 py-2 font-mono', pinned ? 'text-text' : 'text-text-muted')}>
                          <span className="inline-flex items-center gap-1.5">
                            {attribute.name}
                            {attribute.is_password && <Chip dense>{tr('密码', 'Secret')}</Chip>}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-text-muted">{attribute.alias || '—'}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-text-muted">
                          {isValueTypeCode(attribute.value_type)
                            ? tr(VALUE_TYPE_LABELS[attribute.value_type][0], VALUE_TYPE_LABELS[attribute.value_type][1])
                            : attribute.value_type}
                        </td>
                        {FLAGS.map((flag) => (
                          <td key={flag.key} className="px-3 py-2 text-center">
                            {flag.on(attribute) ? (
                              <Check
                                size={14}
                                role="img"
                                aria-label={tr('是', 'Yes')}
                                className="mx-auto text-sky-500"
                              />
                            ) : (
                              <span className="text-text-faint" aria-hidden="true">—</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {error && (
            <p role="alert" className="px-5 pt-2 text-[11px] text-red-600 dark:text-red-300">
              {error}
            </p>
          )}

          <footer className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3">
            <span className="text-[11px] text-text-faint">
              {tr(`已选 ${pickedCount} / ${attributes.length} 个字段`, `${pickedCount} of ${attributes.length} fields selected`)}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" type="button" onClick={() => handleOpenChange(false)} disabled={saving}>
                {tr('取消', 'Cancel')}
              </Button>
              <Button variant="primary" size="sm" type="button" onClick={() => void save()} disabled={saving}>
                {saving ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
              </Button>
            </div>
          </footer>
        </DialogContent>
      </Dialog>
    </>
  );
}
