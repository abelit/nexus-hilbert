// DeviceFiles — managed file manager for Windows/Linux devices.
//
// Read access can browse any absolute path on the device; write actions
// (upload, new folder, rename) are restricted by the edge to the transfer
// sandbox plus ONGRID_DEVICE_FILE_ROOTS. The UI disables write controls when
// the current directory is not under a writable root.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowUp,
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  FolderUp,
  HardDrive,
  Link2,
  Pencil,
  RefreshCw,
  Shield,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, EmptyState, PageHeader, Select } from '@/components/ui';
import { Input, Label } from '@/components/ui';
import { Modal } from '@/components/Modal';
import { useDialogs } from '@/components/ui/useDialogs';
import { Hint } from '@/components/ui/Tooltip';
import { useAssistantPage } from '@/lib/assistantPage';
import { usePermissions } from '@/store/me';
import { useI18n } from '@/i18n/locale';
import { formatBytes, relativeTime } from '@/lib/format';
import { getEdge, listEdges, type Edge } from '@/api/edges';
import {
  downloadPath,
  listFileRoots,
  listFiles,
  makeDirectory,
  renamePath,
  uploadFile,
  type FileManagerEntry,
  type FileManagerRoot,
} from '@/api/filemanager';

function sepOf(path: string): string {
  return path.includes('\\') ? '\\' : '/';
}

function joinPath(dir: string, name: string): string {
  const sep = sepOf(dir);
  const normalized = name.replace(/[\\/]+/g, sep).replace(new RegExp(`^\\${sep}+`), '');
  return dir.endsWith(sep) ? `${dir}${normalized}` : `${dir}${sep}${normalized}`;
}

function parentPath(path: string): string | null {
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, '') : path;
  const sep = sepOf(trimmed);
  const idx = trimmed.lastIndexOf(sep);
  if (idx < 0) return null;
  if (idx === 0) return sep;
  const parent = trimmed.slice(0, idx);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}${sep}`;
  return parent;
}

function normalizeLower(path: string): string {
  return path.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
}

function isUnder(root: string, path: string): boolean {
  const r = normalizeLower(root);
  const p = normalizeLower(path);
  if (r === '') return true;
  return p === r || p.startsWith(`${r}\\`);
}

function breadcrumb(path: string, roots: FileManagerRoot[]): Array<{ label: string; path: string }> {
  const root = roots.find((item) => isUnder(item.path, path));
  const sep = sepOf(path);
  const rootPath = root?.path ?? (sep === '\\' ? path.slice(0, 3) : '/');
  const rest = path.slice(rootPath.length).split(/[\\/]/).filter(Boolean);
  const parts = [{ label: rootPath, path: rootPath }];
  let acc = rootPath;
  for (const segment of rest) {
    acc = joinPath(acc, segment);
    parts.push({ label: segment, path: acc });
  }
  return parts;
}

export default function DeviceFilesPage() {
  const { tr } = useI18n();
  const { canMutate } = usePermissions();
  useAssistantPage('设备文件管理', 'Device file manager', canMutate ? undefined : { access: 'read_only' });

  if (!canMutate) {
    return (
      <main className="anim-fade flex flex-1 flex-col overflow-hidden p-6">
        <PageHeader title={tr('文件管理', 'File manager')} subtitle={tr('需要设备文件权限', 'Device file permission required')} />
        <Card className="p-6">
          <EmptyState
            icon={Shield}
            title={tr('只读账号不能使用文件管理', 'Viewer accounts cannot use the file manager')}
            hint={tr('文件管理可以读写设备目录，只有 admin / user 能打开。', 'The file manager reads and writes device paths. Only admin and user roles can open it.')}
          />
        </Card>
      </main>
    );
  }

  return <FileManager />;
}

export function FileManager() {
  const { tr } = useI18n();
  const { deviceId = '' } = useParams<{ deviceId: string }>();
  const { confirmAction, dialog } = useDialogs();

  const [edge, setEdge] = useState<Edge | null>(null);
  const [roots, setRoots] = useState<FileManagerRoot[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<FileManagerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<FileManagerEntry | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listFiles(deviceId, path);
        setCurrentPath(result.path || path);
        setEntries(result.items ?? []);
      } catch (cause) {
        setError((cause as Error)?.message || tr('无法读取目录', 'Unable to list the directory'));
      } finally {
        setLoading(false);
      }
    },
    [deviceId, tr],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await listFileRoots(deviceId);
        if (cancelled) return;
        const items = result.items ?? [];
        setRoots(items);
        const preferred =
          items.find((item) => item.kind === 'volume') ??
          items[0] ?? { path: '/', label: '/', kind: 'volume', writable: false };
        void refresh(preferred.path);
      } catch (cause) {
        if (!cancelled) {
          setError((cause as Error)?.message || tr('无法读取设备根目录', 'Unable to load device roots'));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId, refresh, tr]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await listEdges();
        if (cancelled) return;
        const target = (r.items ?? []).find((item) => String(item.device_id ?? '') === String(deviceId));
        if (!target) return;
        try {
          const detail = await getEdge(target.id);
          if (!cancelled) setEdge(detail);
        } catch {
          if (!cancelled) setEdge(target);
        }
      } catch {
        /* the page still works with the device id */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  const writableRoots = useMemo(() => roots.filter((item) => item.writable), [roots]);
  const writable = useMemo(
    () => writableRoots.some((item) => isUnder(item.path, currentPath)),
    [currentPath, writableRoots],
  );
  const parent = parentPath(currentPath);
  const parts = useMemo(() => breadcrumb(currentPath, roots), [currentPath, roots]);
  const currentRoot = roots.find((item) => isUnder(item.path, currentPath));

  const sortedEntries = useMemo(
    () =>
      [...entries].sort((a, b) => {
        if (a.dir !== b.dir) return a.dir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      }),
    [entries],
  );

  const saveBlob = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, []);

  const download = useCallback(
    async (entry: FileManagerEntry) => {
      try {
        setProgress(tr(`下载 ${entry.name}…`, `Downloading ${entry.name}…`));
        const { blob, filename } = await downloadPath(deviceId, entry.path);
        saveBlob(blob, filename);
        setProgress(tr('下载完成', 'Download complete'));
      } catch (cause) {
        setError((cause as Error)?.message || tr('下载失败', 'Download failed'));
      }
    },
    [deviceId, saveBlob, tr],
  );

  const uploadOne = useCallback(
    async (file: File, destination: string, overwriteAll: boolean): Promise<boolean> => {
      try {
        await uploadFile(deviceId, destination, file, overwriteAll, (loaded, total) => {
          const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
          setProgress(tr(`上传 ${file.name} ${pct}%`, `Uploading ${file.name} ${pct}%`));
        });
        return overwriteAll;
      } catch (cause) {
        const message = (cause as Error)?.message ?? '';
        if (/exist/i.test(message) && !overwriteAll) {
          const ok = await confirmAction(
            tr(`“${file.name}”已存在，覆盖？`, `“${file.name}” already exists. Overwrite?`),
          );
          if (!ok) return overwriteAll;
          await uploadFile(deviceId, destination, file, true);
          return true;
        }
        throw cause;
      }
    },
    [confirmAction, deviceId, tr],
  );

  const uploadFiles = useCallback(
    async (uploads: Array<{ file: File; destination: string }>) => {
      if (uploads.length === 0) return;
      let overwriteAll = false;
      try {
        for (const [index, item] of uploads.entries()) {
          setProgress(
            tr(
              `上传 ${index + 1}/${uploads.length}：${item.file.name}`,
              `Uploading ${index + 1}/${uploads.length}: ${item.file.name}`,
            ),
          );
          overwriteAll = await uploadOne(item.file, item.destination, overwriteAll);
        }
        setProgress(tr('上传完成', 'Upload complete'));
        await refresh(currentPath);
      } catch (cause) {
        setError((cause as Error)?.message || tr('上传失败', 'Upload failed'));
      }
    },
    [currentPath, refresh, tr, uploadOne],
  );

  const pickFiles = useCallback(() => uploadInputRef.current?.click(), []);

  const pickFolder = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) return;
      const sep = sepOf(currentPath);
      const uploads = files.map((file) => {
        const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        return { file, destination: joinPath(currentPath, relative.replace(/[\\/]+/g, sep)) };
      });
      void uploadFiles(uploads);
    };
    input.click();
  }, [currentPath, uploadFiles]);

  const hostname = edge?.name || deviceId || tr('设备', 'device');

  return (
    <main className="anim-fade flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        title={tr('文件管理', 'File manager')}
        subtitle={tr(`${hostname} · 浏览任意目录，写操作仅限可写根`, `${hostname} · browse any path; writes are limited to writable roots`)}
        leading={
          <Link to={`/devices/${encodeURIComponent(deviceId)}`} className="text-zinc-400 hover:text-zinc-200">
            ← {tr('返回设备', 'Back to device')}
          </Link>
        }
        actions={
          <>
            <Hint content={writable ? tr('上传文件到当前目录', 'Upload files to this folder') : tr('当前目录不在可写根内', 'This folder is not inside a writable root')}>
              <Button size="sm" variant="primary" disabled={!writable} onClick={pickFiles}>
                <Upload size={13} /> {tr('上传文件', 'Upload files')}
              </Button>
            </Hint>
            <Hint content={writable ? tr('上传整个文件夹（保留目录结构）', 'Upload a folder (keeps its structure)') : tr('当前目录不在可写根内', 'This folder is not inside a writable root')}>
              <Button size="sm" variant="subtle" disabled={!writable} onClick={pickFolder}>
                <FolderUp size={13} /> {tr('上传文件夹', 'Upload folder')}
              </Button>
            </Hint>
            <Hint content={writable ? tr('在当前目录新建文件夹', 'Create a folder here') : tr('当前目录不在可写根内', 'This folder is not inside a writable root')}>
              <Button size="sm" variant="subtle" disabled={!writable} onClick={() => setMkdirOpen(true)}>
                <FolderPlus size={13} /> {tr('新建文件夹', 'New folder')}
              </Button>
            </Hint>
            <Button size="sm" variant="subtle" onClick={() => void refresh(currentPath)}>
              <RefreshCw size={13} /> {tr('刷新', 'Refresh')}
            </Button>
          </>
        }
        extra={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label={tr('根目录', 'Root')}
              value={currentRoot?.path ?? ''}
              onValueChange={(value) => void refresh(value)}
              options={roots.map((item) => ({
                value: item.path,
                label: `${item.label}${item.writable ? tr('（可写）', ' (writable)') : ''}`,
              }))}
              className="w-44"
            />
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 text-xs">
              <Hint content={tr('上一级', 'Parent folder')}>
                <Button
                  size="sm"
                  variant="subtle"
                  disabled={!parent}
                  onClick={() => parent && void refresh(parent)}
                  aria-label={tr('上一级', 'Parent folder')}
                  className="h-7 w-7 p-0"
                >
                  <ArrowUp size={13} />
                </Button>
              </Hint>
              {parts.map((part, index) => (
                <span key={part.path} className="flex min-w-0 items-center gap-0.5">
                  {index > 0 && <ChevronRight size={12} className="shrink-0 text-zinc-600" />}
                  <button
                    type="button"
                    onClick={() => void refresh(part.path)}
                    className="max-w-[180px] truncate rounded px-1 py-0.5 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                    title={part.path}
                  >
                    {part.label}
                  </button>
                </span>
              ))}
            </div>
            {progress && <span className="text-[11px] text-zinc-500">{progress}</span>}
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        {error && (
          <div role="alert" className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-zinc-800/60 px-4 py-2 text-[11px] text-zinc-500">
            <span>
              {tr(`${sortedEntries.length} 项`, `${sortedEntries.length} items`)}
              {!writable && <span className="ml-2 text-amber-400/90">{tr('只读目录', 'Read-only folder')}</span>}
            </span>
            <span className="truncate" title={currentPath}>{currentPath}</span>
          </div>
          {loading ? (
            <div className="px-4 py-10 text-center text-sm text-zinc-500">{tr('加载中…', 'Loading…')}</div>
          ) : sortedEntries.length === 0 ? (
            <EmptyState
              icon={Folder}
              title={tr('目录为空', 'This folder is empty')}
              hint={writable ? tr('可以上传文件或新建文件夹', 'Upload files or create a folder') : tr('当前目录只读', 'This folder is read-only')}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 z-10 bg-zinc-900/95 text-left text-[11px] text-zinc-500">
                  <tr>
                    <th className="px-4 py-2 font-normal">{tr('名称', 'Name')}</th>
                    <th className="hidden px-4 py-2 font-normal sm:table-cell">{tr('大小', 'Size')}</th>
                    <th className="hidden px-4 py-2 font-normal lg:table-cell">{tr('修改时间', 'Modified')}</th>
                    <th className="px-4 py-2 text-right font-normal">{tr('操作', 'Actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedEntries.map((entry) => (
                    <tr
                      key={entry.path}
                      className="border-t border-zinc-800/40 hover:bg-white/[0.03]"
                      onDoubleClick={() => entry.dir && void refresh(entry.path)}
                    >
                      <td className="max-w-[420px] px-4 py-2">
                        <button
                          type="button"
                          onClick={() => entry.dir && void refresh(entry.path)}
                          className="flex min-w-0 items-center gap-2 text-left text-zinc-200"
                          title={entry.path}
                        >
                          {entry.dir ? (
                            <Folder size={14} className="shrink-0 text-amber-300/80" />
                          ) : (
                            <FileIcon size={14} className="shrink-0 text-zinc-500" />
                          )}
                          <span className="truncate">{entry.name}</span>
                          {entry.symlink && <Link2 size={11} className="shrink-0 text-zinc-500" aria-label={tr('符号链接', 'Symlink')} />}
                        </button>
                      </td>
                      <td className="hidden px-4 py-2 text-zinc-500 sm:table-cell">
                        {entry.dir ? '—' : formatBytes(entry.size)}
                      </td>
                      <td className="hidden px-4 py-2 text-zinc-500 lg:table-cell">
                        {entry.modified ? relativeTime(entry.modified) : '—'}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <Hint content={entry.dir ? tr('下载文件夹（tar.gz）', 'Download folder (tar.gz)') : tr('下载文件', 'Download file')}>
                            <Button
                              size="sm"
                              variant="subtle"
                              aria-label={tr('下载', 'Download')}
                              onClick={() => void download(entry)}
                              className="h-6 w-6 p-0"
                            >
                              {entry.dir ? <HardDrive size={13} /> : <Download size={13} />}
                            </Button>
                          </Hint>
                          <Hint content={writable ? tr('重命名', 'Rename') : tr('当前目录不在可写根内', 'Not inside a writable root')}>
                            <Button
                              size="sm"
                              variant="subtle"
                              disabled={!writable}
                              aria-label={tr('重命名', 'Rename')}
                              onClick={() => setRenameTarget(entry)}
                              className="h-6 w-6 p-0"
                            >
                              <Pencil size={13} />
                            </Button>
                          </Hint>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          const sep = sepOf(currentPath);
          void uploadFiles(
            files.map((file) => ({
              file,
              destination: joinPath(currentPath, file.name.replace(/[\\/]+/g, sep)),
            })),
          );
        }}
      />

      <NameModal
        open={mkdirOpen}
        title={tr('新建文件夹', 'New folder')}
        submitLabel={tr('创建', 'Create')}
        onClose={() => setMkdirOpen(false)}
        onSubmit={(name) => {
          setMkdirOpen(false);
          void (async () => {
            try {
              await makeDirectory(deviceId, joinPath(currentPath, name));
              await refresh(currentPath);
            } catch (cause) {
              setError((cause as Error)?.message || tr('创建失败', 'Create failed'));
            }
          })();
        }}
      />

      <NameModal
        open={renameTarget !== null}
        title={tr('重命名', 'Rename')}
        initial={renameTarget?.name ?? ''}
        submitLabel={tr('保存', 'Save')}
        onClose={() => setRenameTarget(null)}
        onSubmit={(name) => {
          const target = renameTarget;
          setRenameTarget(null);
          if (!target) return;
          void (async () => {
            try {
              await renamePath(deviceId, target.path, joinPath(currentPath, name));
              await refresh(currentPath);
            } catch (cause) {
              setError((cause as Error)?.message || tr('重命名失败', 'Rename failed'));
            }
          })();
        }}
      />
      {dialog}
    </main>
  );
}

function NameModal({
  open,
  title,
  initial = '',
  submitLabel,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  initial?: string;
  submitLabel: string;
  onSubmit(name: string): void;
  onClose(): void;
}) {
  const { tr } = useI18n();
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(initial);
      setError(null);
    }
  }, [initial, open]);

  if (!open) return null;

  const submit = () => {
    const value = name.trim();
    if (!value) {
      setError(tr('请输入名称', 'Enter a name'));
      return;
    }
    if (/[\\/]/.test(value)) {
      setError(tr('名称不能包含路径分隔符', 'The name cannot contain path separators'));
      return;
    }
    onSubmit(value);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>{tr('取消', 'Cancel')}</Button>
          <Button variant="primary" type="submit" form="fm-name-form">{submitLabel}</Button>
        </>
      }
    >
      <form
        id="fm-name-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Label htmlFor="fm-name" className="mb-1 block text-xs text-zinc-400">
          {tr('名称', 'Name')}
        </Label>
        <Input
          id="fm-name"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="w-full"
        />
        {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
      </form>
    </Modal>
  );
}
