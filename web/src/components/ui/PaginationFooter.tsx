import type { ReactNode } from 'react';
import { Button } from './Button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

type Props = {
  page: number; // zero-based
  pageSize: number;
  shown: number;
  total?: number;
  loading?: boolean;
  hasNext?: boolean;
  matchLabel?: boolean;
  /**
   * Whether the bar floats at the bottom of the viewport. A table that is
   * taller than the viewport should leave this off: a sticky bar covers the
   * rows it is supposed to sit after.
   */
  sticky?: boolean;
  /**
   * A caller-owned summary on the start side. When present the bar spreads
   * across the row instead of aligning everything to the end — the model list
   * uses this for "showing 1–20 of 89 models".
   */
  summary?: ReactNode;
  /** Render the page numbers between Prev and Next. */
  showPageNumbers?: boolean;
  /**
   * Render as a card footer instead of a page-level bar: no outer margin, no
   * background, a lighter divider, and never sticky. The model list embeds it
   * at the bottom of its full-height table card, so the card and the pager are
   * one surface.
   */
  embedded?: boolean;
  className?: string;
  onPageChange(page: number): void;
};

export function PaginationFooter({
  page,
  pageSize,
  shown,
  total,
  loading,
  hasNext,
  matchLabel,
  sticky = true,
  summary,
  showPageNumbers,
  embedded,
  className,
  onPageChange,
}: Props) {
  const { tr } = useI18n();
  const currentPage = Math.max(0, page);
  const first = shown === 0 ? 0 : currentPage * pageSize + 1;
  const last = shown === 0 ? 0 : currentPage * pageSize + shown;
  const canPrev = currentPage > 0;
  const canNext = total != null ? last < total : Boolean(hasNext);

  if (!canPrev && !canNext && total != null && total <= pageSize) return null;
  if (!canPrev && !canNext && total == null && shown < pageSize) return null;

  const rangeLabel = total != null
    ? matchLabel
      ? tr(`${first}-${last} / 共 ${total} 条匹配`, `${first}-${last} of ${total} matches`)
      : tr(`${first}-${last} / 共 ${total} 条`, `${first}-${last} of ${total}`)
    : tr(`第 ${currentPage + 1} 页`, `Page ${currentPage + 1}`);

  const pageCount = total != null && pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : undefined;
  const pages = showPageNumbers && pageCount && pageCount > 1 ? pageWindow(currentPage, pageCount) : [];

  const controls = (
    <>
      <Button variant="outline" size="sm"
        type="button"
        disabled={loading || !canPrev}
        onClick={() => onPageChange(Math.max(0, currentPage - 1))}
        className="inline-flex items-center gap-1 px-2.5 py-1"
      >
        <ChevronLeft size={13} /> {tr('上一页', 'Prev')}
      </Button>
      {pages.map((number, index) =>
        number === null ? (
          <span key={`gap-${index}`} className="px-1 text-text-faint" aria-hidden="true">
            …
          </span>
        ) : (
          <Button
            key={number}
            variant="outline"
            size="sm"
            type="button"
            aria-current={number === currentPage ? 'page' : undefined}
            aria-label={tr(`第 ${number + 1} 页`, `Page ${number + 1}`)}
            onClick={() => onPageChange(number)}
            className={cn(
              'min-w-7 px-2 py-1 tabular-nums',
              number === currentPage && 'border-indigo-500 bg-indigo-500/10 font-medium text-indigo-600 dark:text-indigo-300',
            )}
          >
            {number + 1}
          </Button>
        ),
      )}
      <Button variant="outline" size="sm"
        type="button"
        disabled={loading || !canNext}
        onClick={() => onPageChange(currentPage + 1)}
        className="inline-flex items-center gap-1 px-2.5 py-1"
      >
        {tr('下一页', 'Next')} <ChevronRight size={13} />
      </Button>
    </>
  );

  if (summary !== undefined) {
    return (
      <div
        data-slot="pagination-footer"
        className={cn(
          'flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted',
          embedded ? 'border-t border-border/60 px-4 py-2' : 'mt-2 border-t border-border bg-bg py-3',
          sticky && !embedded && 'sticky bottom-0 z-10',
          className,
        )}
      >
        <span className="min-w-0 text-text-muted">{summary}</span>
        <div className="flex flex-wrap items-center gap-1.5">{controls}</div>
      </div>
    );
  }

  return (
    <div
      data-slot="pagination-footer"
      className={cn(
        'flex flex-wrap items-center justify-end gap-2 text-xs text-text-muted',
        embedded ? 'border-t border-border/60 px-4 py-2' : 'mt-2 border-t border-border bg-bg py-3',
        sticky && !embedded && 'sticky bottom-0 z-10',
        className,
      )}
    >
      <span className="mr-2 text-text-faint">{rangeLabel}</span>
      {controls}
    </div>
  );
}

// A small window around the current page, with a gap marker where pages are
// skipped. Cantor's list showed every page; that stops working at eighty-nine
// models on a phone.
function pageWindow(current: number, count: number): Array<number | null> {
  if (count <= 7) return Array.from({ length: count }, (_, index) => index);
  const wanted = new Set([0, count - 1, current - 1, current, current + 1]);
  const sorted = [...wanted].filter((page) => page >= 0 && page < count).sort((a, b) => a - b);
  const out: Array<number | null> = [];
  let previous = -1;
  for (const page of sorted) {
    if (previous >= 0 && page - previous > 1) out.push(null);
    out.push(page);
    previous = page;
  }
  return out;
}
