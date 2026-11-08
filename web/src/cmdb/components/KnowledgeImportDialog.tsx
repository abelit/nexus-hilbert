import { useEffect, useState } from 'react';
import { BookOpen, Loader2 } from 'lucide-react';

import { createDoc, listDocs, updateDoc } from '@/api/knowledge';
import { ApiError } from '@/api/client';
import { Button } from '@/components/ui';
import { Checkbox } from '@/components/ui/Checkbox';
import { Chip } from '@/components/ui/Chip';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Modal } from '@/components/Modal';
import { useI18n } from '@/i18n/locale';

import type { CMDBKnowledgeItem } from '../lib/knowledge-card';
import { useToast } from './Toast';

/**
 * Imports selected CIs into the knowledge base as one document per CI.
 *
 * THE KNOWLEDGE BASE IS GLOBALLY READABLE. It has no per-document ACL, so the
 * dialog states that plainly and requires an explicit acknowledgement before
 * the first write. One document per CI keeps each within the 2500-character
 * manual-ingestion window; re-importing updates the same document (matched by
 * the ci_id tag) instead of creating a duplicate.
 */
export function KnowledgeImportDialog({
  open,
  items,
  onClose,
  onImported,
}: {
  open: boolean;
  items: CMDBKnowledgeItem[];
  onClose(): void;
  onImported?(count: number): void;
}) {
  const { tr } = useI18n();
  const toast = useToast();
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [path, setPath] = useState('CMDB');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitles(Object.fromEntries(items.map((item) => [item.ciId, item.title])));
    const models = new Set(items.map((item) => item.modelAlias));
    setPath(items.length > 0 && models.size === 1 ? items[0].path : 'CMDB');
    setAcknowledged(false);
    setBusy(false);
    setProgress(null);
    setError(null);
  }, [open, items]);

  const run = async () => {
    if (busy || !acknowledged || items.length === 0) return;
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: items.length });
    let done = 0;
    try {
      for (const item of items) {
        const existing = (await listDocs({ tag: `ci_id:${item.ciId}` })).items.find((doc) =>
          doc.tags?.includes(`ci_id:${item.ciId}`),
        );
        const input = {
          title: titles[item.ciId]?.trim() || item.title,
          content: item.markdown,
          path: path.trim(),
          tags: item.tags,
        };
        if (existing) await updateDoc(existing.id, input);
        else await createDoc(input);
        done += 1;
        setProgress({ done, total: items.length });
      }
      toast.success(
        tr(`已导入 ${done} 篇知识库文档`, `Imported ${done} knowledge document${done === 1 ? '' : 's'}`),
      );
      onImported?.(done);
      onClose();
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 403
          ? tr('没有知识库写入权限（knowledge:doc）。', 'No knowledge-base write permission (knowledge:doc).')
          : err instanceof ApiError
            ? err.message
            : (err as Error)?.message || tr('导入失败', 'Import failed');
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={tr('导入知识库', 'Import to knowledge base')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose} disabled={busy}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            type="button"
            onClick={() => void run()}
            disabled={busy || !acknowledged || items.length === 0}
          >
            {busy ? (
              <>
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                {progress
                  ? tr(`导入中 ${progress.done}/${progress.total}…`, `Importing ${progress.done}/${progress.total}…`)
                  : tr('导入中…', 'Importing…')}
              </>
            ) : (
              <>
                <BookOpen size={12} aria-hidden="true" />
                {tr(`导入 ${items.length} 篇`, `Import ${items.length}`)}
              </>
            )}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          {tr(
            '知识库当前对所有已登录用户可读，没有文档级权限。导入前请确认这些 CI 摘要可以共享。',
            'The knowledge base is readable by every signed-in user and has no per-document ACL. Confirm these CI summaries are safe to share.',
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="cmdb-knowledge-path">{tr('存放目录', 'Folder')}</Label>
            <Input
              id="cmdb-knowledge-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              className="mt-1 w-full font-mono"
              placeholder="CMDB/主机"
            />
          </div>
          <div className="flex items-end">
            <label className="flex items-start gap-2 text-xs text-text-muted">
              <Checkbox
                checked={acknowledged}
                onCheckedChange={(next) => setAcknowledged(next === true)}
                aria-label={tr('我了解知识库全局可读', 'I understand the knowledge base is globally readable')}
              />
              <span className="min-w-0">
                {tr(
                  '我了解导入后所有已登录用户都能检索这些内容。',
                  'I understand every signed-in user can search this content after import.',
                )}
              </span>
            </label>
          </div>
        </div>

        {error && (
          <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <details key={item.ciId} className="rounded-lg border border-border bg-card/40">
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-xs text-text-muted">
                <span className="font-mono text-[11px] text-text-faint">#{item.ciId}</span>
                <span className="min-w-0 flex-1 truncate">{titles[item.ciId] || item.title}</span>
                <Chip dense>{item.modelAlias}</Chip>
              </summary>
              <div className="flex flex-col gap-2 border-t border-border/60 px-3 py-2">
                <div>
                  <Label htmlFor={`cmdb-knowledge-title-${item.ciId}`}>{tr('文档标题', 'Document title')}</Label>
                  <Input
                    id={`cmdb-knowledge-title-${item.ciId}`}
                    value={titles[item.ciId] ?? item.title}
                    onChange={(event) =>
                      setTitles((current) => ({ ...current, [item.ciId]: event.target.value }))
                    }
                    className="mt-1 w-full"
                  />
                </div>
                <div className="flex flex-wrap gap-1">
                  {item.tags.map((tag) => <Chip key={tag} dense>{tag}</Chip>)}
                </div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-bg/60 p-2 text-[11px] text-text-muted">
                  {item.markdown}
                </pre>
              </div>
            </details>
          ))}
        </div>
      </div>
    </Modal>
  );
}
