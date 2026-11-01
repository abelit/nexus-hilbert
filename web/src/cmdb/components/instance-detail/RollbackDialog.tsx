import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';

import { Button, EmptyState, Input, Label } from '@/components/ui';
import { useDialogs } from '@/components/ui/useDialogs';
import { useI18n } from '@/i18n/locale';
import { fullDateTime } from '@/lib/format';

import { describeError } from '../../api/http';
import {
  previewInstanceBaseline,
  rollbackInstance,
  type BaselineChange,
  type BaselinePreview,
  type BaselineSkip,
  type RollbackTarget,
} from '../../api/history';
import { DataTable, type Column } from '../DataTable';
import { Drawer } from '../Drawer';
import { useToast } from '../Toast';

// Roll one resource back to the state it had before a point in time.
//
// THE PREVIEW IS THE POINT. cantor let the operator pick a date and press a
// button labelled "confirm" that only fetched a diff; here the two steps are
// named for what they do, the row entry auto-previews the write that was
// clicked, and the destructive button stays disabled until a current preview
// exists. Nothing is written until the confirmation dialog is accepted.
//
// THE SERVER RECOMPUTES THE VALUES AT APPLY TIME. The request carries the
// rewind point, not the diff: the instance may have changed between preview and
// confirmation, and replaying a stale value list would overwrite those edits.

type Props = {
  open: boolean;
  ciID: number;
  /** The operation time of the history row that opened this dialog. */
  initialBefore?: string;
  /** The operation record id of that row; it is the exact rewind point. */
  initialRecordID?: number;
  onOpenChange(open: boolean): void;
  /** Lets the history list and the drawer behind refresh after a write. */
  onRolledBack?(): void;
};

export function RollbackDialog({
  open,
  ciID,
  initialBefore,
  initialRecordID,
  onOpenChange,
  onRolledBack,
}: Props) {
  const { tr } = useI18n();
  const toast = useToast();
  const { confirmAction, dialog: confirmDialog } = useDialogs();

  const [beforeInput, setBeforeInput] = useState('');
  const [timeISO, setTimeISO] = useState('');
  const [recordID, setRecordID] = useState<number | undefined>(undefined);
  const [preview, setPreview] = useState<BaselinePreview | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  // Bumped whenever the dialog opens or the input changes, so a preview that
  // resolves late cannot paint the diff for a point the operator already left.
  const session = useRef(0);

  const reset = useCallback(() => {
    session.current += 1;
    setBeforeInput('');
    setTimeISO('');
    setRecordID(undefined);
    setPreview(null);
    setStale(false);
    setLoading(false);
    setError(null);
    setApplying(false);
  }, []);

  const runPreview = useCallback(
    async (target: RollbackTarget) => {
      const seq = ++session.current;
      setLoading(true);
      setError(null);
      setStale(false);
      try {
        const got = await previewInstanceBaseline(ciID, target);
        if (seq === session.current) setPreview(got);
      } catch (err) {
        if (seq === session.current) {
          setPreview(null);
          setError(describeError(err, tr('无法读取回滚预览', 'Could not load the rollback preview')));
        }
      } finally {
        if (seq === session.current) setLoading(false);
      }
    },
    [ciID, tr],
  );

  // Opening from a history row pre-fills and auto-previews that write; the
  // toolbar entry opens an empty picker.
  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    reset();
    if (initialRecordID) {
      setRecordID(initialRecordID);
      setBeforeInput(localInput(initialBefore));
      setTimeISO(initialBefore ?? '');
      void runPreview(
        initialBefore ? { before: initialBefore, record_id: initialRecordID } : { record_id: initialRecordID },
      );
      return;
    }
    if (initialBefore) {
      setBeforeInput(localInput(initialBefore));
      setTimeISO(initialBefore);
      void runPreview({ before: initialBefore });
    }
  }, [open, initialBefore, initialRecordID, reset, runPreview]);

  const request: RollbackTarget | null = timeISO
    ? { ...(recordID ? { record_id: recordID } : {}), before: timeISO }
    : recordID
      ? { record_id: recordID }
      : null;
  const canPreview = Boolean(request) && !loading && !applying;
  const canApply = Boolean(preview && preview.changes.length > 0) && !loading && !applying;

  const editTime = (value: string) => {
    session.current += 1;
    const iso = isoOfInput(value);
    setBeforeInput(value);
    setTimeISO(iso);
    // A typed time is no longer the selected write, so the exact record id
    // must not leak into the next preview.
    setRecordID(undefined);
    setStale(preview !== null);
    setPreview(null);
    setError(null);
    setLoading(false);
  };

  const apply = async () => {
    if (!preview || !request || applying) return;
    const count = preview.changes.length;
    const when = timeISO || preview.before;
    const message = when
      ? tr(
          `将把 ${count} 个属性恢复到 ${fullDateTime(when)} 之前的值，并写入一条新的变更记录。是否继续？`,
          `Restore ${count} attribute${count === 1 ? '' : 's'} to the values before ${fullDateTime(when)}? This writes a new change record.`,
        )
      : tr(
          `将把 ${count} 个属性恢复到该次写入之前的值，并写入一条新的变更记录。是否继续？`,
          `Restore ${count} attribute${count === 1 ? '' : 's'} to the values before that write? This writes a new change record.`,
        );
    const confirmed = await confirmAction(message);
    if (!confirmed) return;
    setApplying(true);
    try {
      await rollbackInstance(ciID, request);
      toast.success(tr('已回滚到指定时间点', 'Rolled back to the selected point'));
      onRolledBack?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err, tr('回滚失败', 'Rollback failed')));
    } finally {
      setApplying(false);
    }
  };

  const columns: Column<BaselineChange>[] = [
    {
      key: 'attribute',
      header: tr('属性', 'Attribute'),
      cell: (row) => (
        <span className="text-xs">
          <span className="font-medium text-text">{row.attr_alias || row.attr_name || `#${row.attr_id}`}</span>
          {row.attr_name && row.attr_alias && (
            <code className="ml-1.5 font-mono text-[10px] text-text-faint">{row.attr_name}</code>
          )}
        </span>
      ),
    },
    {
      key: 'change',
      header: tr('当前值 → 回滚后', 'Current → restored'),
      width: 'w-full',
      cell: (row) => (
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-[11px]">
          {row.current.length > 0 ? (
            <code
              className="max-w-[16rem] truncate rounded bg-bg/60 px-1.5 py-0.5 text-text-muted"
              title={row.current.join(', ')}
            >
              {row.current.join(', ')}
            </code>
          ) : (
            <span className="text-text-faint">—</span>
          )}
          <span className="text-text-faint" aria-hidden="true">→</span>
          {row.target.length > 0 ? (
            <code
              className="max-w-[16rem] truncate rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-300"
              title={row.target.join(', ')}
            >
              {row.target.join(', ')}
            </code>
          ) : (
            <span className="text-amber-600 dark:text-amber-300">{tr('已清空', 'Cleared')}</span>
          )}
        </span>
      ),
    },
  ];

  const skipLabel = (skip: BaselineSkip): string =>
    skip.attr_alias || skip.attr_name || `#${skip.attr_id}`;

  return (
    <>
      <Drawer
        open={open}
        onClose={() => {
          if (!applying) onOpenChange(false);
        }}
        size="lg"
        title={tr('回滚资源', 'Roll back resource')}
        description={tr(
          '把属性值恢复到指定时间点之前的状态，作为一次新的变更写入历史。',
          'Restore the values from before a point in time, recorded as a new change.',
        )}
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-text-faint">
              {tr(
                '回滚会写入新的变更记录，原有历史不会被删除。',
                'A rollback writes a new change record; existing history is kept.',
              )}
            </span>
            <div className="flex gap-2">
              <Button type="button" onClick={() => onOpenChange(false)} disabled={applying}>
                {tr('取消', 'Cancel')}
              </Button>
              <Button type="button" variant="danger" onClick={() => void apply()} disabled={!canApply}>
                {applying ? tr('回滚中…', 'Rolling back…') : tr('确认回滚', 'Confirm rollback')}
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          {/* A form so Enter in the time field previews too; the button is the
              visible equivalent for pointer and assistive input. */}
          <form
            className="space-y-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (request) void runPreview(request);
            }}
          >
            <Label htmlFor="cmdb-rollback-time">{tr('回滚到', 'Roll back to')}</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="cmdb-rollback-time"
                type="datetime-local"
                step="1"
                value={beforeInput}
                onChange={(event) => editTime(event.target.value)}
                className="w-64 max-w-full"
              />
              <Button type="submit" variant="outline" disabled={!canPreview}>
                <RotateCcw size={13} aria-hidden="true" />
                {tr('预览变更', 'Preview changes')}
              </Button>
            </div>
            <p className="text-[11px] text-text-muted">
              {tr(
                '该时间点及之后的变更会被撤销。密码、链接、文件、计算和动态属性不会回滚。',
                'Changes at or after this time are undone. Passwords, links, files, computed and dynamic attributes are not restored.',
              )}
            </p>
          </form>

          {stale && (
            <p role="status" className="text-[11px] text-amber-600 dark:text-amber-300">
              {tr('时间已修改，请重新预览', 'The time changed; preview again')}
            </p>
          )}

          {preview || loading || error ? (
            <div className="overflow-hidden rounded-xl border border-border bg-card/40">
              <DataTable
                columns={columns}
                rows={preview?.changes ?? []}
                rowKey={(row) => row.attr_id}
                loading={loading}
                error={error}
                onRetry={() => {
                  if (request) void runPreview(request);
                }}
                empty={tr('该时间点之后没有可回滚的变更', 'Nothing changed after this point')}
              />
            </div>
          ) : (
            <EmptyState
              icon={RotateCcw}
              title={tr('尚未预览', 'Nothing previewed yet')}
              hint={tr(
                '选择时间后点击“预览变更”，这里会列出要恢复的属性。',
                'Pick a time and preview to see the attributes that will be restored.',
              )}
            />
          )}

          {preview && preview.skipped.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
              <span className="font-medium">{tr('不参与回滚：', 'Not restored: ')}</span>
              {preview.skipped.map((skip, index) => {
                const label = skipLabel(skip);
                const reason = skipReason(skip.reason, tr);
                return (
                  <span key={skip.attr_id} className="whitespace-nowrap">
                    {index > 0 && tr('、', ', ')}
                    {tr(`${label}（${reason}）`, `${label} (${reason})`)}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </Drawer>
      {confirmDialog}
    </>
  );
}

function skipReason(reason: string, tr: (zh: string, en: string) => string): string {
  switch (reason) {
    case 'sensitive':
      return tr('敏感属性', 'sensitive');
    case 'computed':
      return tr('计算属性', 'computed');
    case 'dynamic':
      return tr('动态属性', 'dynamic');
    case 'unavailable':
      return tr('属性已不在模型中', 'no longer in the model');
    case 'required':
      return tr('必填属性不能清空', 'required, cannot be cleared');
    case 'identity':
      return tr('唯一标识不能清空', 'unique identifier, cannot be cleared');
    default:
      return tr('不支持的类型', 'unsupported type');
  }
}

/** RFC 3339 → the local value a `datetime-local` input expects. */
function localInput(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join('T');
}

/** A `datetime-local` value → RFC 3339. Empty or malformed input is empty. */
function isoOfInput(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}
