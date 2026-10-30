import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import {
  Download,
  Eye,
  File as FileIcon,
  FileArchive,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  Inbox,
  Loader2,
  Paperclip,
  Trash2,
  type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/ui';
import { Chip } from '@/components/ui/Chip';
import { Modal } from '@/components/Modal';
import { useDialogs } from '@/components/ui/useDialogs';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import {
  deleteCIFiles,
  getFilePreviewLink,
  parseCIFiles,
  serializeCIFiles,
  uploadCIFiles,
  type CIFile,
} from '../../api/files';
import { useToast } from '../Toast';
import { FilePreview } from './FilePreview';

type FileFieldProps = {
  /** Attribute metadata; the id lets the server apply attribute-level limits. */
  attribute: { id: number; name: string; alias?: string };
  value: unknown;
  /** Omitted in read-only mode: the manager then only previews and downloads. */
  onChange?(files: CIFile[], serialized: string): void | Promise<void>;
  disabled?: boolean;
  /** Keep the field and its manager to viewing and downloading. */
  readOnly?: boolean;
  /**
   * Compact trigger for table cells and grid cards. The default trigger keeps
   * its dashed attachment-button shape for forms and detail fields.
   */
  compact?: boolean;
  /**
   * Load the current value before opening the manager. List rows normally
   * carry file metadata, but search results do not; opening from a result
   * without this fetch would replace a non-empty file list with only the new
   * upload. Returning undefined means the attribute has no files.
   */
  loadValue?: () => Promise<unknown>;
};

const formatSize = (bytes: number): string => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const isImage = (mime?: string): boolean => Boolean(mime?.startsWith('image/'));

const fileIconFor = (name: string): LucideIcon => {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext)) return FileImage;
  if (['xls', 'xlsx', 'csv'].includes(ext)) return FileSpreadsheet;
  if (['zip', '7z', 'rar', 'tar', 'gz'].includes(ext)) return FileArchive;
  if (ext === 'json') return FileJson;
  if (['txt', 'md', 'log', 'py', 'js', 'ts', 'html', 'css', 'sh', 'sql'].includes(ext)) return FileText;
  return FileIcon;
};

/**
 * A CMDB file attribute.
 *
 * The stored value is a JSON string, not a server-side relation: upload returns
 * metadata, the form serializes it, and the ordinary CI write persists it in
 * c_value_texts. The manager dialog is also the only place a person sees the
 * file preview, so an unconfigured kkFileView still leaves download available.
 */
export function FileField({
  attribute,
  value,
  onChange,
  disabled = false,
  readOnly = false,
  compact = false,
  loadValue,
}: FileFieldProps) {
  const { tr } = useI18n();
  const toast = useToast();
  const { confirmAction, dialog } = useDialogs();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<{ value: unknown } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [preview, setPreview] = useState<CIFile | null>(null);
  const [uploading, setUploading] = useState<{ name: string; percent: number } | null>(null);
  const [links, setLinks] = useState<Record<string, { inline: string; download: string }>>({});
  const effectiveValue = loaded ? loaded.value : value;
  const files = parseCIFiles(effectiveValue);
  const fileIDs = files.map((file) => file.file_id).filter(Boolean).join(',');

  // Capability URLs are short-lived and file-scoped. Fetch them when the
  // manager opens so image thumbnails and downloads never carry the user's JWT
  // in a URL (which would end up in access logs and Referer headers).
  useEffect(() => {
    if (!open) return;
    let live = true;
    const ids = fileIDs ? fileIDs.split(',') : [];
    void Promise.all(
      ids.map(async (id) => {
        try {
          const [inline, download] = await Promise.all([
            getFilePreviewLink(id, false),
            getFilePreviewLink(id, true),
          ]);
          return [id, { inline: inline.url, download: download.url }] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (!live) return;
      setLinks(Object.fromEntries(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)));
    });
    return () => {
      live = false;
    };
  }, [fileIDs, open]);

  const apply = async (next: CIFile[]) => {
    if (!onChange) return;
    try {
      const serialized = serializeCIFiles(next);
      await onChange(next, serialized);
      // Keep the manager on the value we just persisted when the trigger
      // loaded a fresher value than the row prop (search results).
      if (loadValue) setLoaded({ value: serialized });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr('保存文件失败', 'Could not save the file list'));
    }
  };

  const openManager = async () => {
    if (disabled || resolving) return;
    if (loadValue) {
      setResolving(true);
      try {
        setLoaded({ value: await loadValue() });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : tr('加载文件失败', 'Could not load files'));
        setResolving(false);
        return;
      }
      setResolving(false);
    }
    setOpen(true);
  };

  const upload = async (selected: File[]) => {
    if (disabled || readOnly || selected.length === 0 || uploading) return;
    try {
      let next = parseCIFiles(effectiveValue);
      for (const file of selected) {
        setUploading({ name: file.name, percent: 0 });
        const uploaded = await uploadCIFiles([file], attribute.id, (percent) =>
          setUploading((current) => (current ? { ...current, percent } : current)),
        );
        next = [...next, ...uploaded];
        await apply(next);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr('文件上传失败', 'Upload failed'));
    } finally {
      setUploading(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    void upload(Array.from(event.target.files ?? []));
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    if (disabled || readOnly || uploading) return;
    void upload(Array.from(event.dataTransfer.files ?? []));
  };

  const remove = async (file: CIFile) => {
    if (readOnly) return;
    const ok = await confirmAction(tr(`删除文件「${file.original_name}」？`, `Delete “${file.original_name}”?`));
    if (!ok) return;
    try {
      if (file.file_id) await deleteCIFiles([file.file_id]);
      const key = file.file_id || file.stored_path;
      await apply(parseCIFiles(effectiveValue).filter((item) => (item.file_id || item.stored_path) !== key));
      toast.success(tr('已删除', 'Deleted'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr('删除失败', 'Delete failed'));
    }
  };

  const label = attribute.alias || attribute.name;

  return (
    <>
      <button
        type="button"
        onClick={() => void openManager()}
        disabled={disabled || resolving}
        className={cn(
          'inline-flex items-center transition-colors',
          'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500',
          compact
            ? 'max-w-full gap-1 rounded px-1 py-0.5 text-[11px] text-text-muted hover:bg-bg hover:text-text'
            : 'gap-1.5 rounded-md border border-dashed px-2.5 py-1 text-xs',
          !compact &&
            (files.length
              ? 'border-border text-text hover:border-indigo-500/50'
              : 'border-indigo-500/40 text-indigo-500 hover:bg-indigo-500/5'),
          compact && !files.length && 'text-indigo-500 hover:bg-indigo-500/5',
          (disabled || resolving) && 'cursor-not-allowed opacity-50',
        )}
        title={
          readOnly
            ? tr(`查看文件：${label}`, `View files: ${label}`)
            : tr(`管理文件：${label}`, `Manage files: ${label}`)
        }
        aria-label={
          readOnly
            ? tr(`查看文件：${label}`, `View files: ${label}`)
            : tr(`管理文件：${label}`, `Manage files: ${label}`)
        }
      >
        {resolving ? (
          <Loader2 size={compact ? 11 : 13} className="animate-spin" aria-hidden="true" />
        ) : (
          <Paperclip size={compact ? 11 : 13} aria-hidden="true" />
        )}
        {compact ? (
          files.length ? (
            <span className="tabular-nums">{files.length}</span>
          ) : (
            <span>{tr('上传', 'Upload')}</span>
          )
        ) : files.length ? (
          tr(`${files.length} 个文件`, `${files.length} ${files.length === 1 ? 'file' : 'files'}`)
        ) : readOnly ? (
          tr('没有文件', 'No files')
        ) : (
          tr('未上传文件', 'No files')
        )}
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={readOnly ? tr(`文件 · ${label}`, `Files · ${label}`) : tr(`文件管理 · ${label}`, `Files · ${label}`)}
        size="xl"
        footer={
          <div className="flex w-full items-center justify-between gap-3">
            <span className="text-[11px] text-text-faint">
              {files.length > 0 ? tr(`共 ${files.length} 个文件`, `${files.length} files`) : tr('还没有文件', 'No files yet')}
            </span>
            <Button variant="outline" type="button" onClick={() => setOpen(false)}>
              {tr('关闭', 'Close')}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          {!readOnly && (
          <label
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-border px-4 py-5 text-center transition-colors',
              'hover:border-indigo-500/50',
              (disabled || uploading) && 'pointer-events-none opacity-60',
            )}
          >
            <Inbox size={24} className="text-text-muted" aria-hidden="true" />
            <span className="text-xs text-text">{tr('点击选择或拖入文件', 'Click to choose, or drop files here')}</span>
            <span className="text-[11px] text-text-faint">{tr('文件类型和大小受管理员配置限制', 'Type and size limits follow the administrator settings')}</span>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              disabled={disabled}
              onChange={onInput}
              aria-label={tr('上传文件', 'Upload files')}
            />
          </label>
          )}

          {uploading && (
            <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
              <Loader2 size={14} className="shrink-0 animate-spin text-indigo-500" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-xs text-text">{uploading.name}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-text-muted">{uploading.percent}%</span>
              <div
                role="progressbar"
                aria-label={tr('上传进度', 'Upload progress')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={uploading.percent}
                className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-border"
              >
                <div className="h-full rounded-full bg-indigo-500 transition-[width] duration-150" style={{ width: `${uploading.percent}%` }} />
              </div>
            </div>
          )}

          {files.length === 0 && !uploading ? (
            <p className="py-8 text-center text-xs text-text-muted">{tr('还没有文件', 'No files yet')}</p>
          ) : (
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {files.map((file) => {
                const Icon = fileIconFor(file.original_name);
                return (
                  <div key={file.file_id || file.stored_path} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-bg">
                      {file.file_id && isImage(file.mime_type) && links[file.file_id]?.inline ? (
                        <img src={links[file.file_id].inline} alt="" className="size-9 object-cover" />
                      ) : (
                        <Icon size={18} className="text-text-muted" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-xs font-medium text-text" title={file.original_name}>
                          {file.original_name}
                        </span>
                        {file.storage_backend && (
                          <Chip dense tone={file.storage_backend === 's3' ? 'warning' : 'default'}>
                            {file.storage_backend === 's3' ? 'S3' : tr('本地', 'Local')}
                          </Chip>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-text-faint">
                        {formatSize(file.size)} · {file.mime_type || '—'}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        variant="plain"
                        size="sm"
                        type="button"
                        onClick={() => setPreview(file)}
                        disabled={!file.file_id}
                        aria-label={tr(`预览 ${file.original_name}`, `Preview ${file.original_name}`)}
                        title={tr('预览', 'Preview')}
                      >
                        <Eye size={13} aria-hidden="true" />
                      </Button>
                      <a
                        href={links[file.file_id]?.download}
                        download={file.original_name}
                        aria-label={tr(`下载 ${file.original_name}`, `Download ${file.original_name}`)}
                        title={tr('下载', 'Download')}
                        className={cn(
                          'inline-flex h-8 items-center justify-center rounded px-2 text-text-muted hover:bg-bg hover:text-text',
                          (!file.file_id || !links[file.file_id]?.download) && 'pointer-events-none opacity-40',
                        )}
                      >
                        <Download size={13} aria-hidden="true" />
                      </a>
                      {!readOnly && (
                        <Button
                          variant="dangerGhost"
                          size="sm"
                          type="button"
                          onClick={() => void remove(file)}
                          disabled={disabled}
                          aria-label={tr(`删除 ${file.original_name}`, `Delete ${file.original_name}`)}
                          title={tr('删除', 'Delete')}
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={preview != null}
        onClose={() => setPreview(null)}
        title={preview?.original_name ?? tr('文件预览', 'File preview')}
        size="xl"
      >
        {preview && <FilePreview file={preview} />}
      </Modal>

      {dialog}
    </>
  );
}
