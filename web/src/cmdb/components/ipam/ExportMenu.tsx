import { Download } from 'lucide-react';

import { Button } from '@/components/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { useI18n } from '@/i18n/locale';

import {
  EXPORT_FORMATS,
  exportRows,
  type ExportColumn,
  type ExportFormat,
} from '../../lib/export';
import { useToast } from '../Toast';

// One export control for every IPAM table. The rows passed here are the rows
// the table is showing (filtered, and selected when the page says so), so the
// file and the screen agree.
export function ExportMenu<T>({
  filename,
  columns,
  rows,
  disabled = false,
  onExported,
}: {
  filename: string;
  columns: ExportColumn<T>[];
  rows: T[];
  disabled?: boolean;
  onExported?(format: ExportFormat): void;
}) {
  const { tr } = useI18n();
  const toast = useToast();

  const run = async (format: ExportFormat) => {
    if (rows.length === 0) {
      toast.error(tr('没有可导出的数据', 'There is nothing to export'));
      return;
    }
    try {
      await exportRows(filename, columns, rows, format);
      toast.success(tr('已导出', 'Exported'));
      onExported?.(format);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : tr('导出失败', 'The export failed'),
      );
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
            disabled={disabled}
            className="inline-flex items-center gap-1.5"
          />
        }
      >
        <Download size={12} aria-hidden="true" />
        {tr('导出', 'Export')}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40 p-1">
        {EXPORT_FORMATS.map((format) => (
          <DropdownMenuItem
            key={format.value}
            onClick={() => void run(format.value)}
            className="gap-2"
          >
            {tr(format.zh, format.en)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
