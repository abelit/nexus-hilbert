// The pure half of the cron builder.
//
// THE BUILDER EDITS THE SAME 5-FIELD SYNTAX THE COLLECTOR ACCEPTS. It does not
// offer `?`, `L`, `W` or `#`: robfig/cron does not understand them, so a
// builder that emitted one would produce a schedule euler silently drops.
// Expressions outside the four shapes below are left to the text input rather
// than rewritten lossily.

export type CronFieldKey = 'minute' | 'hour' | 'day' | 'month' | 'week';

export type CronFieldMode = 'all' | 'range' | 'step' | 'list';

export type CronFieldValue = {
  mode: CronFieldMode;
  start: number;
  end: number;
  step: number;
  values: number[];
};

export type CronFields = Record<CronFieldKey, CronFieldValue>;

export type CronFieldSpec = {
  key: CronFieldKey;
  min: number;
  max: number;
  zh: string;
  en: string;
  unitZh: string;
  unitEn: string;
  /** Week values use 0=Sunday; labels follow that order. */
  labels?: string[];
};

export const CRON_FIELDS: CronFieldSpec[] = [
  { key: 'minute', min: 0, max: 59, zh: '分', en: 'Minute', unitZh: '分钟', unitEn: 'minute' },
  { key: 'hour', min: 0, max: 23, zh: '时', en: 'Hour', unitZh: '小时', unitEn: 'hour' },
  { key: 'day', min: 1, max: 31, zh: '日', en: 'Day', unitZh: '日', unitEn: 'day' },
  { key: 'month', min: 1, max: 12, zh: '月', en: 'Month', unitZh: '月', unitEn: 'month' },
  {
    key: 'week',
    min: 0,
    max: 6,
    zh: '周',
    en: 'Week',
    unitZh: '周',
    unitEn: 'weekday',
    labels: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
  },
];

export function emptyField(min: number): CronFieldValue {
  return { mode: 'all', start: min, end: Math.min(min + 1, 59), step: 1, values: [] };
}

function intIn(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return number >= min && number <= max ? number : null;
}

function parseField(raw: string, min: number, max: number): CronFieldValue | null {
  if (raw === '*') return emptyField(min);
  if (raw.includes(',')) {
    const values = raw.split(',').map((item) => intIn(item, min, max));
    if (values.some((value) => value == null)) return null;
    return { mode: 'list', start: min, end: min + 1, step: 1, values: values as number[] };
  }
  if (raw.includes('/')) {
    const [startRaw, stepRaw] = raw.split('/');
    if (raw.split('/').length !== 2) return null;
    const step = intIn(stepRaw, 1, max);
    if (step == null) return null;
    if (startRaw === '*') return { mode: 'step', start: min, end: Math.min(min + 1, max), step, values: [] };
    const start = intIn(startRaw, min, max);
    return start == null
      ? null
      : { mode: 'step', start, end: Math.min(start + 1, max), step, values: [] };
  }
  if (raw.includes('-')) {
    const [startRaw, endRaw] = raw.split('-');
    if (raw.split('-').length !== 2) return null;
    const start = intIn(startRaw, min, max);
    const end = intIn(endRaw, min, max);
    return start == null || end == null || end < start
      ? null
      : { mode: 'range', start, end, step: 1, values: [] };
  }
  const single = intIn(raw, min, max);
  return single == null
    ? null
    : { mode: 'list', start: min, end: min + 1, step: 1, values: [single] };
}

/**
 * Parse a 5-field expression. A 6-field expression is accepted only when its
 * seconds field is `0`; a nonzero seconds field has no representation in the
 * five tabs and returns null so the caller can keep the text editor.
 */
export function parseCronFields(expr: string): CronFields | null {
  const parts = (expr || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 6) {
    if (parts[0] !== '0') return null;
    parts.shift();
  }
  if (parts.length !== 5) {
    // An empty expression is an empty draft rather than a parse failure: the
    // builder opens on `* * * * *` and Apply is what writes it.
    if (parts.length === 0) return allFields();
    return null;
  }
  const fields = {} as CronFields;
  for (let index = 0; index < CRON_FIELDS.length; index += 1) {
    const spec = CRON_FIELDS[index];
    const parsed = parseField(parts[index], spec.min, spec.max);
    if (!parsed) return null;
    fields[spec.key] = parsed;
  }
  return fields;
}

export function buildCronField(value: CronFieldValue): string {
  switch (value.mode) {
    case 'all':
      return '*';
    case 'range':
      return `${value.start}-${value.end}`;
    case 'step':
      return `${value.start}/${value.step}`;
    case 'list': {
      const values = [...new Set(value.values)].sort((a, b) => a - b);
      return values.length > 0 ? values.join(',') : '*';
    }
  }
}

export function buildCronExpression(fields: CronFields): string {
  return CRON_FIELDS.map((spec) => buildCronField(fields[spec.key])).join(' ');
}

export function allFields(): CronFields {
  const fields = {} as CronFields;
  for (const spec of CRON_FIELDS) fields[spec.key] = { ...emptyField(spec.min), end: spec.min + 1 };
  return fields;
}

/** Whether a field's range/step inputs are internally consistent. */
export function fieldIsValid(value: CronFieldValue): boolean {
  if (value.mode === 'range') return value.start <= value.end;
  if (value.mode === 'step') return value.step >= 1;
  if (value.mode === 'list') return value.values.length > 0;
  return true;
}

export function fieldsAreValid(fields: CronFields): boolean {
  return CRON_FIELDS.every((spec) => fieldIsValid(fields[spec.key]));
}

