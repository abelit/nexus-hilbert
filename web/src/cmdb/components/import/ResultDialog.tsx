import { CheckCircle2, FileSpreadsheet } from 'lucide-react';

import { Button } from '@/components/ui';
import { Modal } from '@/components/Modal';
import { useI18n } from '@/i18n/locale';

import type { ImportResult } from '../../api/import';

// The end of an import. Cantor counted per-row failures here because its
// upload was a loop of requests; this import is one transaction, so the only
// outcomes are "the sheet was written" and "nothing was written" — and the
// second never reaches this dialog.

export function ResultDialog({
  open,
  onClose,
  onAgain,
  result,
  total,
}: {
  open: boolean;
  onClose(): void;
  onAgain(): void;
  result: ImportResult;
  total: number;
}) {
  const { tr } = useI18n();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tr('导入完成', 'Import finished')}
      size="md"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" type="button" onClick={onAgain}>
            <FileSpreadsheet size={12} className="me-1.5" aria-hidden="true" />
            {tr('再导入一份', 'Import another sheet')}
          </Button>
          <Button variant="primary" type="button" onClick={onClose}>
            {tr('完成', 'Done')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <CheckCircle2 size={28} className="mt-0.5 shrink-0 text-emerald-500" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-text">
              {tr(`已写入 ${result.written} 行`, `Wrote ${result.written} rows`)}
            </p>
            <p className="mt-0.5 text-xs text-text-muted">
              {tr(
                '整个表格在一次事务中提交；任何一行失败都不会留下部分数据。',
                'The whole sheet committed in one transaction; one bad row would have left nothing behind.',
              )}
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-3 gap-2 rounded-md border border-border p-3 text-center">
          <div>
            <dt className="text-[11px] text-text-muted">{tr('表格行数', 'Rows in sheet')}</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums text-text">{total}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-text-muted">{tr('新建', 'Created')}</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums text-emerald-500">{result.creates}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-text-muted">{tr('更新', 'Updated')}</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums text-indigo-400">{result.updates}</dd>
          </div>
        </dl>
      </div>
    </Modal>
  );
}
