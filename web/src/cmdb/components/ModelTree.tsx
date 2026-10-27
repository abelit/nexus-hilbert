import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Folder, FolderOpen, Plus, Search } from 'lucide-react';

import { Button } from '@/components/ui';
import { Chip } from '@/components/ui/Chip';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import type { CIType } from '../api/citype';
import type { ModelGroup } from '../api/preferences';
import { CMDBIcon } from './CMDBIcon';

// The model tree is the navigation half of the model configuration workspace.
//
// A MODEL LIST IS NOT A TREE. The list page answers "which models exist"; this
// tree answers "where is the model I am looking for", using the same shared
// groups the rest of the CMDB uses. The right pane owns the detail and the
// write actions; the tree deliberately stays a navigation surface so a row
// cannot accidentally become a destructive menu.
//
// Models are grouped by the shared group definitions, with an "Other" bucket
// for ungrouped models. Searching flattens across groups: an operator who
// knows the name should not have to remember which folder it lives in.

type TreeGroup = {
  key: string;
  name?: string;
  isOther?: boolean;
  models: CIType[];
};

export function ModelTree({
  models,
  groups,
  selectedID,
  loading,
  error,
  onRetry,
  onSelect,
}: {
  models: CIType[];
  groups: ModelGroup[];
  selectedID?: number;
  loading: boolean;
  error?: string | null;
  onRetry?(): void;
  onSelect?(): void;
}) {
  const { tr } = useI18n();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const selectedRef = useRef<HTMLAnchorElement | null>(null);

  const treeGroups = useMemo<TreeGroup[]>(() => {
    const byModel = new Map<number, CIType>();
    models.forEach((model) => byModel.set(model.id, model));
    const assigned = new Set<number>();
    const fromAPI: TreeGroup[] = groups.map((group) => {
      const groupModels = (group.ci_types ?? [])
        .map((item) => byModel.get(item.id) ?? item)
        .filter((item) => byModel.has(item.id));
      groupModels.forEach((item) => assigned.add(item.id));
      return {
        key: group.id != null ? `g-${group.id}` : 'other',
        name: group.name,
        isOther: group.is_other || group.id == null,
        models: groupModels,
      };
    });
    const ungrouped = models.filter((model) => !assigned.has(model.id));
    if (ungrouped.length > 0) {
      const existingOther = fromAPI.find((group) => group.isOther);
      if (existingOther) {
        existingOther.models = [...existingOther.models, ...ungrouped];
      } else {
        fromAPI.push({ key: 'other', name: tr('其他', 'Other'), isOther: true, models: ungrouped });
      }
    }
    if (fromAPI.length === 0 && models.length > 0) {
      return [{ key: 'other', name: tr('全部模型', 'All models'), isOther: true, models }];
    }
    return fromAPI;
  }, [groups, models, tr]);

  const needle = query.trim().toLowerCase();
  const visibleGroups = useMemo(
    () =>
      treeGroups
        .map((group) => ({
          ...group,
          models: group.models.filter(
            (model) => !needle || model.name.toLowerCase().includes(needle) || model.alias.toLowerCase().includes(needle),
          ),
        }))
        .filter((group) => group.models.length > 0),
    [needle, treeGroups],
  );

  useEffect(() => {
    if (!selectedID) return;
    const group = treeGroups.find((item) => item.models.some((model) => model.id === selectedID));
    if (!group) return;
    setCollapsed((current) => {
      if (!current.has(group.key)) return current;
      const next = new Set(current);
      next.delete(group.key);
      return next;
    });
    requestAnimationFrame(() => selectedRef.current?.scrollIntoView?.({ block: 'nearest' }));
  }, [selectedID, treeGroups]);

  const toggle = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-border bg-bg lg:w-64 lg:shrink-0" aria-label={tr('模型导航', 'Model navigation')}>
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text">{tr('模型', 'Models')}</h2>
            <p className="text-[11px] text-text-faint">{tr(`${models.length} 个模型`, `${models.length} models`)}</p>
          </div>
          <Link
            to="/cmdb/models?new=1"
            className="inline-flex h-7 items-center gap-1 rounded-md bg-indigo-600 px-2 text-[11px] font-medium text-white hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
            onClick={onSelect}
          >
            <Plus size={12} aria-hidden="true" />
            {tr('新建', 'New')}
          </Link>
        </div>
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint" aria-hidden="true" />
          <Input
            type="search"
            aria-label={tr('搜索模型', 'Search models')}
            placeholder={tr('搜索模型', 'Search models')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full pl-7 text-xs"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <p className="px-2 py-6 text-center text-xs text-text-muted">{tr('加载中…', 'Loading…')}</p>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
            <p className="text-xs text-red-300">{error}</p>
            {onRetry && (
              <Button variant="outline" size="sm" type="button" onClick={onRetry}>
                {tr('重试', 'Retry')}
              </Button>
            )}
          </div>
        ) : visibleGroups.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-text-muted">
            {needle ? tr('没有匹配的模型', 'No model matches that') : tr('还没有模型', 'No models yet')}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {visibleGroups.map((group) => {
              const open = !!needle || !collapsed.has(group.key);
              return (
                <div key={group.key}>
                  <button
                    type="button"
                    onClick={() => toggle(group.key)}
                    aria-expanded={open}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-text-muted hover:bg-card hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
                  >
                    <ChevronRight size={12} className={cn('shrink-0 transition-transform', open && 'rotate-90')} aria-hidden="true" />
                    {open ? <FolderOpen size={13} className="shrink-0 text-indigo-400" aria-hidden="true" /> : <Folder size={13} className="shrink-0 text-indigo-400" aria-hidden="true" />}
                    <span className="min-w-0 truncate">{group.isOther ? tr('其他', 'Other') : group.name || tr('未命名分组', 'Untitled group')}</span>
                    <span className="ms-auto text-[10px] text-text-faint">{group.models.length}</span>
                  </button>
                  {open && (
                    <div className="ms-3 flex flex-col gap-0.5 border-s border-border ps-1">
                      {group.models.map((model) => {
                        const selected = selectedID === model.id;
                        return (
                          <Link
                            key={model.id}
                            ref={selected ? selectedRef : undefined}
                            to={`/cmdb/models/${model.id}`}
                            onClick={onSelect}
                            aria-current={selected ? 'page' : undefined}
                            className={cn(
                              'flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500',
                              selected ? 'bg-indigo-500/15 text-text' : 'text-text-muted hover:bg-card hover:text-text',
                            )}
                          >
                            <CMDBIcon value={model.icon} size={14} label={model.alias || model.name} />
                            <span className="min-w-0 flex-1 truncate">{model.alias || model.name}</span>
                            {!model.enabled && <Chip className="shrink-0 px-1 py-0 text-[10px]">{tr('停用', 'Off')}</Chip>}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        <Link
          to="/cmdb/preferences?tab=groups"
          className="text-[11px] text-text-faint underline-offset-2 hover:text-text hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
        >
          {tr('管理模型分组', 'Manage model groups')}
        </Link>
      </div>
    </aside>
  );
}
