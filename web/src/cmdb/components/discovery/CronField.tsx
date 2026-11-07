import { useMemo, useState } from 'react';
import { Clock } from 'lucide-react';

import { Button } from '@/components/ui';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/Popover';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import { cronPreview, formatCronDate } from '../../lib/cron';
import { CronBuilder } from './CronBuilder';

// The schedule input, with the two things an operator needs beside it: what
// the expression means and when it will next run. The clock button opens the
// field-by-field builder; the text input stays freely editable for anything
// the builder does not cover.

export function CronField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange(value: string): void;
}) {
  const { tr } = useI18n();
  const preview = useMemo(() => cronPreview(value, tr), [tr, value]);
  const [open, setOpen] = useState(false);

  return (
    <div className="min-w-0">
      <Label htmlFor={id}>{tr('Cron 表达式', 'Cron expression')}</Label>
      <div className="mt-1 flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Input
            id={id}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="0 * * * *"
            className={cn('w-full font-mono', preview.text && 'pe-32')}
          />
          {preview.text && (
            <span className="pointer-events-none absolute end-2 top-1/2 max-w-[45%] -translate-y-1/2 truncate rounded-md border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 dark:text-indigo-300">
              {preview.text}
            </span>
          )}
        </div>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                type="button"
                aria-label={tr('编辑 Cron 表达式', 'Edit cron expression')}
                title={tr('编辑 Cron 表达式', 'Edit cron expression')}
                className="size-9 shrink-0 px-0"
              >
                <Clock size={13} aria-hidden="true" />
              </Button>
            }
          />
          <PopoverContent align="end" className="w-[34rem] max-w-[calc(100vw-1rem)] !p-0">
            <div className="border-b border-border px-4 py-2.5">
              <PopoverTitle className="text-xs font-medium text-text">
                {tr('编辑 Cron 表达式', 'Edit cron expression')}
              </PopoverTitle>
            </div>
            <CronBuilder
              key={`${open}-${value}`}
              value={value}
              onApply={(next) => {
                onChange(next);
                setOpen(false);
              }}
              onCancel={() => setOpen(false)}
            />
          </PopoverContent>
        </Popover>
      </div>
      {preview.next && (
        <p className="mt-1 text-[11px] text-text-faint">
          {tr('下次预计执行：', 'Next run: ')}
          {formatCronDate(preview.next)}
        </p>
      )}
      {!preview.text && value.trim() !== '' && (
        <p className="mt-1 text-[11px] text-text-faint">
          {tr('由采集器解释该表达式。', 'The collector interprets this expression.')}
        </p>
      )}
    </div>
  );
}
