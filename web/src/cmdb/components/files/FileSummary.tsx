import { Paperclip } from 'lucide-react';

import { useI18n } from '@/i18n/locale';

import { parseCIFiles } from '../../api/files';

/**
 * A compact, read-only file count for table cells and cards. The full manager
 * lives in the detail drawer and edit form; a list row should not carry a
 * dialog that competes with opening the resource.
 */
export function FileSummary({ value }: { value: unknown }) {
  const { tr } = useI18n();
  const files = parseCIFiles(value);
  if (files.length === 0) return <span className="text-text-faint">—</span>;
  const names = files.map((file) => file.original_name).join(', ');
  return (
    <span
      className="inline-flex items-center gap-1 text-text-muted"
      title={names}
      aria-label={tr(`${files.length} 个文件`, `${files.length} ${files.length === 1 ? 'file' : 'files'}`)}
    >
      <Paperclip size={11} aria-hidden="true" />
      <span className="tabular-nums">{files.length}</span>
    </span>
  );
}
