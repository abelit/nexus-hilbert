import { useMemo, useState } from 'react';

import { Button } from '@/components/ui';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Radio } from '@/components/ui/Radio';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import {
  CRON_FIELDS,
  allFields,
  buildCronExpression,
  buildCronField,
  fieldIsValid,
  fieldsAreValid,
  parseCronFields,
  type CronFieldKey,
  type CronFieldSpec,
  type CronFieldValue,
  type CronFields,
} from '../../lib/cronBuilder';

// The cron builder popover: five tabs, one field at a time.
//
// IT ONLY WRITES THE STANDARD SYNTAX THE COLLECTOR RUNS. The mode rows are the
// four ways an operator normally needs to describe a field; a value that uses
// anything else stays in the text input instead of being rewritten here.

export function CronBuilder({
  value,
  onApply,
  onCancel,
}: {
  value: string;
  onApply(next: string): void;
  onCancel(): void;
}) {
  const { tr } = useI18n();
  const parsed = useMemo(() => parseCronFields(value), [value]);
  const [fields, setFields] = useState<CronFields>(() => parsed ?? allFields());
  const [active, setActive] = useState<CronFieldKey>('minute');

  const patch = (key: CronFieldKey, next: Partial<CronFieldValue>) => {
    setFields((current) => ({
      ...current,
      [key]: { ...current[key], ...next },
    }));
  };

  const selectMode = (spec: CronFieldSpec, mode: CronFieldValue['mode']) => {
    const current = fields[spec.key];
    switch (mode) {
      case 'all':
        patch(spec.key, { mode });
        return;
      case 'range':
        patch(spec.key, {
          mode,
          start: current.mode === 'range' ? current.start : spec.min,
          end: current.mode === 'range' ? current.end : Math.min(spec.min + 1, spec.max),
        });
        return;
      case 'step':
        patch(spec.key, {
          mode,
          start: current.mode === 'step' ? current.start : spec.min,
          step: current.mode === 'step' ? current.step : 1,
        });
        return;
      case 'list':
        patch(spec.key, {
          mode,
          values: current.mode === 'list' && current.values.length > 0 ? current.values : [spec.min],
        });
        return;
    }
  };

  if (!parsed) {
    return (
      <div className="space-y-4 p-4">
        <div role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-300">
          {tr(
            '当前表达式包含构建器不支持的形式，请直接在输入框中编辑，或重置后再使用构建器。',
            'This expression uses syntax the builder does not support. Edit it in the text field, or reset it before using the builder.',
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => {
              setFields(allFields());
              onApply('* * * * *');
            }}
          >
            {tr('重置为每分钟', 'Reset to every minute')}
          </Button>
          <Button variant="ghost" size="sm" type="button" onClick={onCancel}>
            {tr('取消', 'Cancel')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4">
      <Tabs value={active} onValueChange={(next) => setActive(next as CronFieldKey)}>
        <TabsList className="grid w-full grid-cols-5 rounded-lg border border-border bg-card/50 p-0.5">
          {CRON_FIELDS.map((spec) => (
            <TabsTrigger
              key={spec.key}
              value={spec.key}
              className="rounded-md border-b-0 px-2 py-1.5 text-xs data-[active]:bg-indigo-500/15 data-[active]:text-indigo-600 dark:data-[active]:text-indigo-300"
            >
              {tr(spec.zh, spec.en)}
            </TabsTrigger>
          ))}
        </TabsList>

        {CRON_FIELDS.map((spec) => (
          <TabsContent key={spec.key} value={spec.key} className="pt-4">
            <FieldEditor
              spec={spec}
              value={fields[spec.key]}
              onMode={(mode) => selectMode(spec, mode)}
              onPatch={(next) => patch(spec.key, next)}
            />
          </TabsContent>
        ))}
      </Tabs>

      <div className="mt-4 border-t border-border pt-3">
        <p className="text-[11px] font-medium text-text-muted">{tr('时间表达式', 'Expression')}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {CRON_FIELDS.map((spec) => (
            <code
              key={spec.key}
              className={cn(
                'rounded border px-1.5 py-0.5 font-mono text-[11px]',
                spec.key === active
                  ? 'border-indigo-500/40 bg-indigo-500/5 text-indigo-600 dark:text-indigo-300'
                  : 'border-border text-text-muted',
              )}
            >
              {buildCronField(fields[spec.key])}
            </code>
          ))}
          <span className="px-1 text-text-faint" aria-hidden="true">
            →
          </span>
          <code className="rounded border border-indigo-500/40 bg-indigo-500/10 px-1.5 py-0.5 font-mono text-[11px] text-indigo-600 dark:text-indigo-300">
            {buildCronExpression(fields)}
          </code>
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2 border-t border-border pt-3">
        <Button
          variant="primary"
          size="sm"
          type="button"
          onClick={() => onApply(buildCronExpression(fields))}
          disabled={!fieldsAreValid(fields)}
        >
          {tr('确认', 'Confirm')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() => setFields(allFields())}
        >
          {tr('重置', 'Reset')}
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={onCancel}>
          {tr('取消', 'Cancel')}
        </Button>
      </div>
    </div>
  );
}

function FieldEditor({
  spec,
  value,
  onMode,
  onPatch,
}: {
  spec: CronFieldSpec;
  value: CronFieldValue;
  onMode(mode: CronFieldValue['mode']): void;
  onPatch(next: Partial<CronFieldValue>): void;
}) {
  const { tr } = useI18n();
  const options = Array.from({ length: spec.max - spec.min + 1 }, (_, index) => spec.min + index);
  const name = `cron-mode-${spec.key}`;
  const unit = tr(spec.unitZh, spec.unitEn);
  const everyLabel = {
    minute: tr('每分钟', 'Every minute'),
    hour: tr('每小时', 'Every hour'),
    day: tr('每天', 'Every day'),
    month: tr('每月', 'Every month'),
    week: tr('每周', 'Every week'),
  }[spec.key];

  return (
    <div role="radiogroup" aria-label={tr(`${spec.zh}字段`, `${spec.en} field`)} className="space-y-2.5">
      <p className="text-xs font-medium text-text">{tr(spec.zh, spec.en)}</p>

      <label
        className={cn(
          'flex cursor-pointer items-center gap-2 text-xs',
          value.mode === 'all' ? 'text-text' : 'text-text-muted',
        )}
      >
        <Radio name={name} checked={value.mode === 'all'} onChange={() => onMode('all')} />
        <span>{everyLabel}</span>
        <code className="rounded border border-border px-1 py-0.5 font-mono text-[10px] text-text-faint">*</code>
        <span className="text-[10px] text-text-faint">{tr('允许 , - * /', 'allows , - * /')}</span>
      </label>

      <div
        className={cn(
          'flex cursor-pointer flex-wrap items-center gap-1.5 text-xs',
          value.mode === 'range' ? 'text-text' : 'text-text-muted',
        )}
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest('input')) onMode('range');
        }}
      >
        <Radio name={name} checked={value.mode === 'range'} onChange={() => onMode('range')} />
        <span>{tr('范围', 'Range')}</span>
        <span>{tr('从', 'from')}</span>
        <CronNumberInput
          ariaLabel={tr(`${spec.zh}范围开始`, `${spec.en} range start`)}
          min={spec.min}
          max={spec.max}
          value={value.start}
          onFocus={() => onMode('range')}
          onChange={(start) => onPatch({ start, mode: 'range' })}
        />
        <span>{tr('到', 'to')}</span>
        <CronNumberInput
          ariaLabel={tr(`${spec.zh}范围结束`, `${spec.en} range end`)}
          min={spec.min}
          max={spec.max}
          value={value.end}
          onFocus={() => onMode('range')}
          onChange={(end) => onPatch({ end, mode: 'range' })}
        />
        <span>{unit}</span>
        {value.mode === 'range' && !fieldIsValid(value) && (
          <span className="text-[10px] text-amber-600 dark:text-amber-300">
            {tr('结束值不能小于开始值', 'End must not be before start')}
          </span>
        )}
      </div>

      <div
        className={cn(
          'flex cursor-pointer flex-wrap items-center gap-1.5 text-xs',
          value.mode === 'step' ? 'text-text' : 'text-text-muted',
        )}
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest('input')) onMode('step');
        }}
      >
        <Radio name={name} checked={value.mode === 'step'} onChange={() => onMode('step')} />
        <span>{tr('从', 'from')}</span>
        <CronNumberInput
          ariaLabel={tr(`${spec.zh}起始值`, `${spec.en} step start`)}
          min={spec.min}
          max={spec.max}
          value={value.start}
          onFocus={() => onMode('step')}
          onChange={(start) => onPatch({ start, mode: 'step' })}
        />
        <span>{unit}</span>
        <span>{tr('开始，每', 'start, every')}</span>
        <CronNumberInput
          ariaLabel={tr(`${spec.zh}步长`, `${spec.en} step size`)}
          min={1}
          max={spec.max}
          value={value.step}
          onFocus={() => onMode('step')}
          onChange={(step) => onPatch({ step, mode: 'step' })}
        />
        <span>{unit}</span>
        <span>{tr('执行一次', 'run once')}</span>
      </div>

      <div>
        <label
          className={cn(
            'flex cursor-pointer items-center gap-2 text-xs',
            value.mode === 'list' ? 'text-text' : 'text-text-muted',
          )}
        >
          <Radio name={name} checked={value.mode === 'list'} onChange={() => onMode('list')} />
          <span>{tr('指定值', 'Specific values')}</span>
          <span className="text-[10px] text-text-faint">{tr('可多选', 'multiple')}</span>
          {value.mode === 'list' && value.values.length > 0 && (
            <span className="text-[10px] text-indigo-600 dark:text-indigo-300">
              {tr(`已选 ${value.values.length} 项`, `${value.values.length} selected`)}
            </span>
          )}
        </label>
        {value.mode === 'list' && (
          <div className="ms-5 mt-2 max-h-32 overflow-y-auto rounded-md border border-border bg-card/40 p-2">
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {options.map((option) => {
                const checked = value.values.includes(option);
                const label = spec.labels?.[option] ?? String(option);
                return (
                  <label key={option} className="flex items-center gap-1 text-[11px] text-text-muted">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(next) => {
                        const values = next === true
                          ? [...value.values, option]
                          : value.values.filter((item) => item !== option);
                        onPatch({ mode: 'list', values });
                      }}
                    />
                    {label}
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CronNumberInput({
  value,
  min,
  max,
  ariaLabel,
  onFocus,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  ariaLabel: string;
  onFocus(): void;
  onChange(value: number): void;
}) {
  const [text, setText] = useState(String(value));
  const [lastValue, setLastValue] = useState(value);
  if (lastValue !== value) {
    setLastValue(value);
    setText(String(value));
  }

  const commit = () => {
    const number = Number(text);
    const next = Number.isFinite(number) ? Math.min(Math.max(number, min), max) : min;
    setText(String(next));
    onChange(next);
  };

  return (
    <Input
      type="text"
      inputMode="numeric"
      aria-label={ariaLabel}
      value={text}
      onFocus={onFocus}
      onChange={(event) => {
        const raw = event.target.value.replace(/\D/g, '');
        setText(raw);
        if (raw !== '') {
          const number = Number(raw);
          if (Number.isFinite(number)) onChange(Math.min(Math.max(number, min), max));
        }
      }}
      onBlur={commit}
      className="h-7 w-14 px-1 text-center font-mono text-xs"
    />
  );
}
