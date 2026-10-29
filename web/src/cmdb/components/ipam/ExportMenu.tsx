import { useState } from 'react';
import {
  AlignLeft,
  Braces,
  Download,
  FileCode,
  FileSpreadsheet,
  FileText,
  type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import {
  EXPORT_FORMATS,
  exportRows,
  type ExportColumn,
  type ExportFormat,
} from '../../lib/export';
import { useToast } from '../Toast';

export type ExportScope = 'all' | 'page' | 'selected';

// The format icons are cantor's: the file type is recognisable before the label
// is read, and the colours stay legible in both themes.
const FORMAT_ICONS: Record<ExportFormat, { icon: LucideIcon; className: string }> = {
  xlsx: { icon: FileSpreadsheet, className: 'text-emerald-500' },
  csv: { icon: FileText, className: 'text-sky-500' },
  json: { icon: Braces, className: 'text-amber-500' },
  yaml: { icon: FileCode, className: 'text-violet-500' },
  txt: { icon: AlignLeft, className: 'text-text-faint' },
};

// One export control for every CMDB table.
//
// THE ROWS AND THE SCOPE ARE THE CALLER'S. A page passes the rows it is
// showing; a server-paginated page also passes `fetchAll`, because its current
// page is not the whole result set. The file and the screen then agree for the
// page scope, while 全部 means "the current query", the way cantor's export did.
//
// SELECTED ROWS MAY LIVE ON ANOTHER PAGE. A caller with cross-page selection
// passes `fetchSelected` rather than a page-local array, so 已选 exports the
// checked instances themselves and not just the ones still on screen.
//
// THE FETCH RUNS ONLY WHEN A SCOPE IS EXPORTED. Opening the menu must not load
// an unbounded result set; errors and an empty result are reported by the
// caller's fetch and by the menu respectively.
export function ExportMenu<T>({
  filename,
  columns,
  rows,
  disabled = false,
  fetchAll,
  totalCount,
  selectedCount,
  fetchSelected,
  scopes = ['page'],
  label,
  onExported,
}: {
  filename: string;
  columns: ExportColumn<T>[];
  rows: T[];
  disabled?: boolean;
  /** Loads the whole current query for the 全部 scope. */
  fetchAll?: () => T[] | Promise<T[]>;
  /** The current query's match count, for the 全部 label. */
  totalCount?: number;
  /** The checked-row count, for the 已选 label. */
  selectedCount?: number;
  /** Loads the checked rows for the 已选 scope, including those off this page. */
  fetchSelected?: () => T[] | Promise<T[]>;
  /** Page-only by default; pass 全部 / 已选 when the caller can resolve them. */
  scopes?: ExportScope[];
  /** Trigger label override; defaults to 导出. */
  label?: string;
  onExported?(format: ExportFormat): void;
}) {
  const { tr } = useI18n();
  const toast = useToast();
  const [scope, setScope] = useState<ExportScope>(
    scopes.includes('all') ? 'all' : (scopes[0] ?? 'page'),
  );
  const [busy, setBusy] = useState(false);

  const countFor = (item: ExportScope) => {
    if (item === 'all') return totalCount;
    if (item === 'selected') return selectedCount;
    return rows.length;
  };

  const run = async (format: ExportFormat) => {
    if (busy) return;
    setBusy(true);
    try {
      let data = rows;
      if (scope === 'all' && fetchAll) data = await fetchAll();
      else if (scope === 'selected') data = fetchSelected ? await fetchSelected() : [];
      if (data.length === 0) {
        toast.error(tr('没有可导出的数据', 'There is nothing to export'));
        return;
      }
      await exportRows(filename, columns, data, format);
      toast.success(tr('已导出', 'Exported'));
      onExported?.(format);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : tr('导出失败', 'The export failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={disabled || busy}
            className="inline-flex items-center gap-1.5"
          />
        }
      >
        <Download size={12} aria-hidden="true" />
        {busy ? tr('导出中…', 'Exporting…') : (label ?? tr('导出', 'Export'))}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className={scopes.length > 2 ? 'w-72 p-1' : scopes.length > 1 ? 'w-52 p-1' : 'w-40 p-1'}
      >
        {scopes.length > 1 && (
          <>
            <div className="px-1 pb-1 text-[11px] font-medium text-text-faint">
              {tr('数据范围', 'Data range')}
            </div>
            <div
              role="group"
              aria-label={tr('数据范围', 'Data range')}
              className="mb-1 flex items-center gap-0.5 rounded-md border border-border p-0.5"
            >
              {scopes.map((item) => {
                const count = countFor(item);
                const noSelection = item === 'selected' && count === 0;
                return (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={scope === item}
                    disabled={busy || noSelection}
                    title={noSelection ? tr('先勾选要导出的实例', 'Select the instances to export first') : undefined}
                    onClick={() => setScope(item)}
                    className={cn(
                      'min-w-0 flex-1 truncate whitespace-nowrap rounded px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                      scope === item
                        ? 'bg-card font-medium text-text shadow-sm'
                        : 'text-text-muted hover:text-text',
                    )}
                  >
                    {item === 'all'
                      ? tr('全部', 'All')
                      : item === 'page'
                        ? tr('当前页', 'Page')
                        : tr('已选', 'Selected')}
                    {count != null ? ` (${count})` : ''}
                  </button>
                );
              })}
            </div>
            <div className="my-1 border-t border-border" />
          </>
        )}
        {EXPORT_FORMATS.map((format) => {
          const { icon: Icon, className } = FORMAT_ICONS[format.value];
          return (
            <DropdownMenuItem
              key={format.value}
              disabled={busy}
              onClick={() => void run(format.value)}
              className="gap-2"
            >
              <Icon size={12} className={className} aria-hidden="true" />
              {tr(format.zh, format.en)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
