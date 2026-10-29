import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Database,
  Lock,
  LockOpen,
  Network,
  Search,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/Modal';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { useI18n } from '@/i18n/locale';

import { listTypeAttributes, type CIType, type TypeAttribute } from '../../api/citype';
import { describeError } from '../../api/http';
import { getShowFields, listTreeLevels, setShowFields, setTreeLevels } from '../../api/preferences';

export type EditorTab = 'fields' | 'tree';

type TransferItem = {
  key: string;
  label: string;
  name: string;
  password?: boolean;
};

// --- the subscription editor ---

export function SubscriptionEditor({
  model,
  initialTab,
  onClose,
  onSaved,
  onUnsubscribe,
}: {
  model: CIType;
  initialTab: EditorTab;
  onClose(): void;
  onSaved(message: string): void | Promise<void>;
  onUnsubscribe(kind: EditorTab): void;
}) {
  const { tr } = useI18n();
  const [tab, setTab] = useState<EditorTab>(initialTab);
  const [attributes, setAttributes] = useState<TypeAttribute[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [fixed, setFixed] = useState<string[]>([]);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [levels, setLevels] = useState<string[]>([]);
  const [treeSubscribed, setTreeSubscribed] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setErr(null);
    void Promise.all([listTypeAttributes(model.id), getShowFields(model.id), listTreeLevels()])
      .then(([attrs, fields, trees]) => {
        if (!live) return;
        setAttributes(attrs.attributes ?? []);
        setIsSubscribed(fields.is_subscribed);
        const fields0 = fields.fields ?? [];
        setSelected(fields0.map(fieldKey));
        setFixed(fields0.filter((field) => field.is_fixed).map(fieldKey));
        const view = trees.find((item) => item.type_id === model.id);
        setTreeSubscribed(Boolean(view));
        setLevels(view?.levels.map((attribute) => attribute.name) ?? []);
      })
      .catch((error) => live && setErr(describeError(error, tr('无法读取订阅设置', 'Could not load the subscription settings'))))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [model.id, tr]);

  const items = useMemo<TransferItem[]>(
    () => [
      ...attributes.map((attribute) => ({
        key: `attr:${attribute.id}`,
        label: attribute.alias || attribute.name,
        name: attribute.name,
        password: attribute.is_password,
      })),
      { key: 'builtin:_updated_by', label: tr('更新人', 'Updated by'), name: '_updated_by' },
      { key: 'builtin:_updated_at', label: tr('更新时间', 'Updated at'), name: '_updated_at' },
    ],
    [attributes, tr],
  );

  const itemByKey = useMemo(() => new Map(items.map((item) => [item.key, item])), [items]);
  const term = search.trim().toLowerCase();
  const leftItems = items.filter(
    (item) =>
      !selected.includes(item.key) &&
      (!term || item.label.toLowerCase().includes(term) || item.name.toLowerCase().includes(term)),
  );
  const rightItems = selected.map((key) => itemByKey.get(key)).filter((item): item is TransferItem => Boolean(item));
  const leftChecked = leftItems.filter((item) => checked.includes(item.key)).map((item) => item.key);
  const rightChecked = rightItems.filter((item) => checked.includes(item.key)).map((item) => item.key);

  const toggleChecked = (key: string) =>
    setChecked((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));

  const toggleAll = (keys: string[]) =>
    setChecked((current) => {
      const all = keys.length > 0 && keys.every((key) => current.includes(key));
      return all ? current.filter((key) => !keys.includes(key)) : [...new Set([...current, ...keys])];
    });

  const moveRight = (keys: string[]) => {
    setSelected((current) => [...current, ...keys.filter((key) => !current.includes(key))]);
    setChecked((current) => current.filter((key) => !keys.includes(key)));
  };

  const moveLeft = (keys: string[]) => {
    setSelected((current) => current.filter((key) => !keys.includes(key)));
    setChecked((current) => current.filter((key) => !keys.includes(key)));
  };

  const moveWithin = (key: string, direction: -1 | 1) => {
    setSelected((current) => {
      const index = current.indexOf(key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const toggleFixed = (key: string) =>
    setFixed((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));

  const saveFields = async () => {
    if (selected.length === 0) {
      setErr(tr('至少要选择一列，列表才不会没有可显示的内容。', 'Choose at least one column so the list has something to show.'));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await setShowFields(
        model.id,
        selected.map((key) => ({ ref: stripKey(key), is_fixed: fixed.includes(key) })),
      );
      await onSaved(tr('已保存', 'Saved'));
    } catch (error) {
      setErr(describeError(error, tr('保存失败', 'Could not save')));
    } finally {
      setSaving(false);
    }
  };

  const saveTree = async () => {
    setSaving(true);
    setErr(null);
    try {
      await setTreeLevels(model.id, levels);
      await onSaved(tr('已保存', 'Saved'));
    } catch (error) {
      setErr(describeError(error, tr('保存失败', 'Could not save')));
    } finally {
      setSaving(false);
    }
  };

  const labelOf = (name: string) => attributes.find((attribute) => attribute.name === name)?.alias || name;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={tr(`订阅设置 · ${model.alias || model.name}`, `Subscription settings · ${model.alias || model.name}`)}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {tab === 'fields' && isSubscribed && (
              <Button variant="dangerGhost" type="button" onClick={() => onUnsubscribe('fields')} disabled={saving}>
                {tr('取消数据订阅', 'Cancel column subscription')}
              </Button>
            )}
            {tab === 'tree' && treeSubscribed && (
              <Button variant="dangerGhost" type="button" onClick={() => onUnsubscribe('tree')} disabled={saving}>
                {tr('取消层级订阅', 'Cancel hierarchy subscription')}
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" type="button" onClick={onClose} disabled={saving}>
              {tr('取消', 'Cancel')}
            </Button>
            <Button
              variant="primary"
              type="button"
              onClick={() => void (tab === 'fields' ? saveFields() : saveTree())}
              disabled={saving || loading}
            >
              {saving ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
            </Button>
          </div>
        </div>
      }
    >
      {err && (
        <div role="alert" className="mb-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          {err}
        </div>
      )}

      <Tabs value={tab} onValueChange={(value) => setTab(value as EditorTab)} className="flex flex-col gap-3">
        <TabsList>
          <TabsTrigger value="fields" className="inline-flex items-center gap-1.5">
            <Database size={14} aria-hidden="true" />
            {tr('资源数据', 'Resource data')}
          </TabsTrigger>
          <TabsTrigger value="tree" className="inline-flex items-center gap-1.5">
            <Network size={14} aria-hidden="true" />
            {tr('资源层级', 'Resource hierarchy')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="fields">
          {loading ? (
            <p className="py-8 text-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
              <div className="flex min-w-0 flex-col">
                <ListHeader
                  title={tr('未选属性', 'Unselected attributes')}
                  checked={leftChecked.length}
                  total={leftItems.length}
                  onToggleAll={() => toggleAll(leftItems.map((item) => item.key))}
                />
                <div className="relative mt-2">
                  <Search
                    size={13}
                    className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-text-faint"
                    aria-hidden="true"
                  />
                  <Input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={tr('搜索属性', 'Search attributes')}
                    aria-label={tr('搜索属性', 'Search attributes')}
                    className="ps-8"
                  />
                </div>
                <div className="mt-2 min-h-40 flex-1 overflow-y-auto rounded-md border border-border">
                  {leftItems.length === 0 ? (
                    <p className="py-6 text-center text-xs text-text-muted">
                      {term ? tr('没有匹配的属性', 'No attribute matches') : tr('属性都已选中', 'Every attribute is selected')}
                    </p>
                  ) : (
                    leftItems.map((item) => (
                      <div
                        key={item.key}
                        className="flex items-center gap-2 border-b border-border px-2 py-1.5 text-xs last:border-0 hover:bg-card"
                      >
                        <Checkbox
                          className="border-text-faint"
                          checked={checked.includes(item.key)}
                          onCheckedChange={() => toggleChecked(item.key)}
                          aria-label={item.label}
                        />
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        <span className="shrink-0 font-mono text-[11px] text-text-faint">{item.name}</span>
                        <Button
                          variant="subtle"
                          size="sm"
                          type="button"
                          onClick={() => moveRight([item.key])}
                          aria-label={tr(`选中 ${item.label}`, `Move ${item.label} to selected`)}
                          title={tr('移到已选', 'Move to selected')}
                        >
                          <ChevronRight size={12} aria-hidden="true" />
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="flex flex-row items-center justify-center gap-2 md:flex-col">
                <Button
                  variant="outline"
                  size="icon"
                  type="button"
                  disabled={leftChecked.length === 0}
                  onClick={() => moveRight(leftChecked)}
                  aria-label={tr('移入已选', 'Move checked to selected')}
                  title={tr('移到已选', 'Move to selected')}
                >
                  <ChevronRight size={14} aria-hidden="true" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  type="button"
                  disabled={rightChecked.length === 0}
                  onClick={() => moveLeft(rightChecked)}
                  aria-label={tr('移回未选', 'Move checked to unselected')}
                  title={tr('移到未选', 'Move to unselected')}
                >
                  <ChevronLeft size={14} aria-hidden="true" />
                </Button>
              </div>

              <div className="flex min-w-0 flex-col">
                <ListHeader
                  title={tr('已选属性', 'Selected attributes')}
                  checked={rightChecked.length}
                  total={rightItems.length}
                  onToggleAll={() => toggleAll(rightItems.map((item) => item.key))}
                />
                <p className="mt-2 text-[11px] text-text-faint">
                  {tr('顺序决定列表里的列顺序；锁定的列保持固定。', 'Order sets the column order; locked columns stay pinned.')}
                </p>
                <div className="mt-2 min-h-40 flex-1 overflow-y-auto rounded-md border border-border">
                  {rightItems.length === 0 ? (
                    <p className="py-6 text-center text-xs text-text-muted">
                      {tr('还没有选择属性', 'No attribute selected yet')}
                    </p>
                  ) : (
                    rightItems.map((item) => {
                      const index = selected.indexOf(item.key);
                      const pinned = fixed.includes(item.key);
                      return (
                        <div
                          key={item.key}
                          className="flex items-center gap-1 border-b border-border px-2 py-1.5 text-xs last:border-0"
                        >
                          <Checkbox
                            className="border-text-faint"
                            checked={checked.includes(item.key)}
                            onCheckedChange={() => toggleChecked(item.key)}
                            aria-label={item.label}
                          />
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                          <span className="shrink-0 font-mono text-[11px] text-text-faint">{item.name}</span>
                          <Button
                            variant="subtle"
                            size="sm"
                            type="button"
                            onClick={() => toggleFixed(item.key)}
                            aria-label={
                              pinned
                                ? tr(`取消固定 ${item.label}`, `Unpin ${item.label}`)
                                : tr(`固定 ${item.label}`, `Pin ${item.label}`)
                            }
                            title={pinned ? tr('取消固定', 'Unpin') : tr('固定列', 'Pin column')}
                          >
                            {pinned ? (
                              <Lock size={12} className="text-accent" aria-hidden="true" />
                            ) : (
                              <LockOpen size={12} aria-hidden="true" />
                            )}
                          </Button>
                          <Button
                            variant="subtle"
                            size="sm"
                            type="button"
                            onClick={() => moveWithin(item.key, -1)}
                            disabled={index <= 0}
                            aria-label={tr(`上移 ${item.label}`, `Move ${item.label} up`)}
                          >
                            <ArrowUp size={12} aria-hidden="true" />
                          </Button>
                          <Button
                            variant="subtle"
                            size="sm"
                            type="button"
                            onClick={() => moveWithin(item.key, 1)}
                            disabled={index === selected.length - 1}
                            aria-label={tr(`下移 ${item.label}`, `Move ${item.label} down`)}
                          >
                            <ArrowDown size={12} aria-hidden="true" />
                          </Button>
                          <Button
                            variant="subtle"
                            size="sm"
                            type="button"
                            onClick={() => moveLeft([item.key])}
                            aria-label={tr(`移除 ${item.label}`, `Remove ${item.label}`)}
                            title={tr('移到未选', 'Move to unselected')}
                          >
                            <ChevronLeft size={12} aria-hidden="true" />
                          </Button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="tree">
          {loading ? (
            <p className="py-8 text-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</p>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="rounded-md border border-border bg-card p-3">
                <h3 className="text-xs font-medium text-text">{tr('已选层级', 'Chosen levels')}</h3>
                {levels.length === 0 ? (
                  <p className="mt-2 text-xs text-text-muted">{tr('还没有选择层级', 'No level chosen yet')}</p>
                ) : (
                  <ol className="mt-2 space-y-1">
                    {levels.map((name, index) => (
                      <li
                        key={name}
                        className="flex items-center gap-1.5 rounded-md border-s-2 border-accent/60 bg-bg px-2 py-1 text-xs"
                      >
                        <span className="w-4 shrink-0 text-text-faint">{index + 1}.</span>
                        <span className="min-w-0 flex-1 truncate">{labelOf(name)}</span>
                        <Button
                          variant="subtle"
                          size="sm"
                          type="button"
                          onClick={() =>
                            setLevels((current) => {
                              if (index === 0) return current;
                              const next = [...current];
                              [next[index - 1], next[index]] = [next[index], next[index - 1]];
                              return next;
                            })
                          }
                          disabled={index === 0}
                          aria-label={tr(`上移 ${name}`, `Move ${name} up`)}
                        >
                          <ArrowUp size={12} aria-hidden="true" />
                        </Button>
                        <Button
                          variant="subtle"
                          size="sm"
                          type="button"
                          onClick={() =>
                            setLevels((current) => {
                              if (index === current.length - 1) return current;
                              const next = [...current];
                              [next[index + 1], next[index]] = [next[index], next[index + 1]];
                              return next;
                            })
                          }
                          disabled={index === levels.length - 1}
                          aria-label={tr(`下移 ${name}`, `Move ${name} down`)}
                        >
                          <ArrowDown size={12} aria-hidden="true" />
                        </Button>
                        <Button
                          variant="dangerGhost"
                          size="sm"
                          type="button"
                          onClick={() => setLevels((current) => current.filter((item) => item !== name))}
                          aria-label={tr(`移除 ${name}`, `Remove ${name}`)}
                        >
                          <Trash2 size={12} aria-hidden="true" />
                        </Button>
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              <div>
                <h3 className="text-xs font-medium text-text-muted">{tr('可选属性', 'Available attributes')}</h3>
                <div className="mt-1 max-h-64 overflow-y-auto rounded-md border border-border">
                  {attributes.length === 0 ? (
                    <p className="py-6 text-center text-xs text-text-muted">
                      {tr('这个模型还没有属性', 'This model has no attributes yet')}
                    </p>
                  ) : (
                    attributes.map((attribute) => {
                      const checkedLevel = levels.includes(attribute.name);
                      return (
                        <label
                          key={attribute.id}
                          className="flex cursor-pointer items-center gap-2 border-b border-border px-2 py-1.5 text-xs last:border-0 hover:bg-card"
                        >
                          <Checkbox
                            className="border-text-faint"
                            checked={checkedLevel}
                            onCheckedChange={() =>
                              setLevels((current) =>
                                current.includes(attribute.name)
                                  ? current.filter((name) => name !== attribute.name)
                                  : [...current, attribute.name],
                              )
                            }
                            aria-label={attribute.alias || attribute.name}
                          />
                          <span className="min-w-0 flex-1 truncate">{attribute.alias || attribute.name}</span>
                          <span className="shrink-0 font-mono text-[11px] text-text-faint">{attribute.name}</span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
              <p className="text-[11px] text-text-faint">
                {tr('层级顺序就是资源树的展开顺序。', 'The order is how the resource hierarchy expands.')}
              </p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </Modal>
  );
}

function ListHeader({
  title,
  checked,
  total,
  onToggleAll,
}: {
  title: string;
  checked: number;
  total: number;
  onToggleAll(): void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs font-medium text-text">
      <span className="truncate">{title}</span>
      <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] font-normal text-text-muted">
        <Checkbox
          className="border-text-faint"
          checked={total > 0 && checked === total}
          indeterminate={checked > 0 && checked < total}
          onCheckedChange={onToggleAll}
          aria-label={title}
        />
        <span>
          {checked}/{total}
        </span>
      </label>
    </div>
  );
}

function stripKey(key: string): string {
  return key.replace(/^(attr|builtin):/, '');
}

function fieldKey(field: { attr_id?: number; builtin?: string }): string {
  return field.builtin ? `builtin:${field.builtin}` : `attr:${field.attr_id}`;
}
