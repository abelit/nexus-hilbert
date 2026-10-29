import { Fragment } from 'react';
import { ChevronRight, ListChecks, Pencil, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui';
import { Chip } from '@/components/ui/Chip';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import type { ServiceTree } from '../../api/preferences';
import { serviceTreeChainTokens } from '../../lib/model-relation-graph';

/** One saved definition in the relation-view rail. */
export function DefinitionCard({
  tree,
  label,
  selected,
  editing,
  unresolved,
  isAdmin,
  onSelect,
  onEdit,
  onAdvancedEdit,
  onDelete,
}: {
  tree: ServiceTree;
  label(id: number): string;
  selected: boolean;
  editing: boolean;
  unresolved: boolean;
  isAdmin: boolean;
  onSelect(): void;
  onEdit(): void;
  onAdvancedEdit(): void;
  onDelete(): void;
}) {
  const { tr } = useI18n();
  const tokens = serviceTreeChainTokens(tree.pairs, label);

  return (
    <div
      className={cn(
        'rounded-xl border bg-card p-2 transition-colors',
        selected || editing
          ? 'border-indigo-500/50 bg-indigo-500/5'
          : 'border-border hover:border-indigo-500/30',
      )}
    >
      <div className="flex items-start gap-1">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          title={tree.name}
          className="min-w-0 flex-1 rounded px-1 py-0.5 text-start focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-xs font-semibold text-text">{tree.name}</span>
            {tree.is_public && (
              <Chip tone="info" dense>
                {tr('公开', 'Public')}
              </Chip>
            )}
          </span>
        </button>
        {isAdmin && (
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              variant="subtle"
              size="sm"
              type="button"
              onClick={onEdit}
              aria-label={tr(`编辑定义 ${tree.name}`, `Edit definition ${tree.name}`)}
              title={tr('编辑定义', 'Edit definition')}
            >
              <Pencil size={12} aria-hidden="true" />
            </Button>
            <Button
              variant="subtle"
              size="sm"
              type="button"
              onClick={onAdvancedEdit}
              aria-label={tr(`精确编辑定义 ${tree.name}`, `Edit model pairs for ${tree.name}`)}
              title={tr('精确编辑模型对', 'Edit model pairs')}
            >
              <ListChecks size={12} aria-hidden="true" />
            </Button>
            <Button
              variant="dangerGhost"
              size="sm"
              type="button"
              onClick={onDelete}
              aria-label={tr(`删除定义 ${tree.name}`, `Delete definition ${tree.name}`)}
              title={tr('删除定义', 'Delete definition')}
            >
              <Trash2 size={12} aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onSelect}
        aria-label={tr(`查看定义 ${tree.name}`, `Show definition ${tree.name}`)}
        className="mt-1.5 flex w-full flex-wrap items-center gap-1 rounded-md border border-dashed border-border/60 bg-card/50 px-2 py-1.5 text-start focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
      >
        {tokens.length === 0 ? (
          <span className="text-[10px] text-text-faint">
            {tr('没有可解析的模型对', 'No resolvable model pairs')}
          </span>
        ) : (
          tokens.map((token, index) => (
            <Fragment key={`${token}-${index}`}>
              {index > 0 && (
                <ChevronRight size={10} className="shrink-0 text-text-faint" aria-hidden="true" />
              )}
              <span
                className={cn(
                  'rounded border px-1.5 py-0.5 text-[10px] whitespace-nowrap',
                  token.startsWith('+')
                    ? 'border-border/60 text-text-faint'
                    : 'border-border bg-card text-text',
                )}
              >
                {token}
              </span>
            </Fragment>
          ))
        )}
      </button>

      {unresolved && (
        <p className="mt-1 px-1 text-[10px] text-amber-600 dark:text-amber-400">
          {tr('包含已失效的模型关系', 'Contains a model relation that no longer exists')}
        </p>
      )}
    </div>
  );
}
