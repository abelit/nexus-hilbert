import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Search, X } from 'lucide-react';

import { Button } from '@/components/ui';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import type { RelatedType } from '../../api/citype';
import { describeError } from '../../api/http';
import { addRelation, searchInstances, type SearchRow } from '../../api/instance';
import { instanceSearchQuery } from '../../lib/instance-search';
import { relatedRowIdentifier, relatedRowTitle } from '../../lib/related-row';
import { CMDBIcon } from '../CMDBIcon';

// Adding one relation is a search, not a free-form id field. The dialog keeps
// the target model fixed (it comes from the relation rule), excludes the
// current resource and existing peers, and writes the ordered pair the backend
// expects.

const PAGE_SIZE = 20;
const SEARCH_DELAY = 250;

export function RelationAddDialog({
  open,
  currentCIID,
  related,
  side,
  existingIDs,
  onClose,
  onAdded,
}: {
  open: boolean;
  currentCIID: number;
  related: RelatedType;
  side: 'parent' | 'child';
  existingIDs: readonly number[];
  onClose(): void;
  onAdded(row: SearchRow): void;
}) {
  const { tr } = useI18n();
  const targetLabel = related.type.alias || related.type.name;
  const direction = side === 'parent' ? tr('上游', 'upstream') : tr('下游', 'downstream');
  const inputRef = useRef<HTMLInputElement>(null);
  const excluded = useRef<Set<number>>(new Set());
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<SearchRow[]>([]);
  const [selected, setSelected] = useState<SearchRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  excluded.current = new Set([currentCIID, ...existingIDs]);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setSelected(null);
    setResults([]);
    setError(null);
  }, [open, related.type.id]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void searchInstances(
        { q: instanceSearchQuery(Number(related.type.id), search), count: PAGE_SIZE, page: 1 },
        controller.signal,
      )
        .then((page) => {
          if (controller.signal.aborted) return;
          setResults((page.result ?? []).filter((row) => !excluded.current.has(row._id)));
        })
        .catch((cause) => {
          if (controller.signal.aborted) return;
          setError(describeError(cause, tr('无法搜索关联实例', 'Could not search related instances')));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, search.trim() ? SEARCH_DELAY : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, related.type.id, search, tr]);

  const submit = async () => {
    if (!selected || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const first = side === 'parent' ? selected._id : currentCIID;
      const second = side === 'parent' ? currentCIID : selected._id;
      await addRelation(first, second, {
        relation_type_id: related.relation_type?.id || undefined,
      });
      onAdded(selected);
    } catch (cause) {
      setError(describeError(cause, tr('添加关联失败', 'Could not add the relation')));
    } finally {
      setSubmitting(false);
    }
  };

  const rows = useMemo(
    () =>
      results.map((row) => ({
        row,
        title: relatedRowTitle(row, related),
        identifier: relatedRowIdentifier(row, related),
      })),
    [results, related],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        initialFocus={inputRef}
        className="flex max-h-[min(80vh,40rem)] w-[min(34rem,calc(100vw-2rem))] flex-col p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <DialogTitle className="text-sm font-semibold text-text">
              {tr(`添加${targetLabel}关联`, `Add ${targetLabel} relation`)}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs leading-5 text-text-muted">
              {tr(
                `选择一条「${targetLabel}」实例，将其添加为当前资源的${direction}。`,
                `Choose a ${targetLabel} instance and add it as the current resource's ${direction}.`,
              )}
            </DialogDescription>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={tr('关闭', 'Close')}
            className="shrink-0 rounded p-1 text-text-faint hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        <div className="relative mt-4">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint"
            aria-hidden="true"
          />
          <Input
            ref={inputRef}
            id="cmdb-relation-search"
            type="search"
            aria-label={tr(`搜索${targetLabel}`, `Search ${targetLabel}`)}
            placeholder={tr(`搜索${targetLabel}名称或标识…`, `Search ${targetLabel} name or key…`)}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setSelected(null);
            }}
            className="w-full pl-7 text-xs"
          />
        </div>

        {error && (
          <div role="alert" className="mt-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
            {error}
          </div>
        )}

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-bg/30 p-1">
          {loading && rows.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-text-muted">{tr('搜索中…', 'Searching…')}</p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-text-faint">
              {tr('没有可添加的实例', 'No instances available to add')}
            </p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {rows.map(({ row, title, identifier }) => {
                const active = selected?._id === row._id;
                return (
                  <button
                    key={row._id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSelected(row)}
                    className={cn(
                      'flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500',
                      active ? 'bg-sky-500/10' : 'hover:bg-card',
                    )}
                  >
                    <CMDBIcon value={related.type.icon} size={15} label={targetLabel} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-text" title={title}>
                        {title}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[10px] text-text-faint" title={identifier}>
                        {identifier}
                      </span>
                    </span>
                    {active && <Check size={14} className="shrink-0 text-sky-500" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button variant="primary" type="button" onClick={() => void submit()} disabled={!selected || submitting}>
            {submitting ? tr('添加中…', 'Adding…') : tr('添加关联', 'Add relation')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
