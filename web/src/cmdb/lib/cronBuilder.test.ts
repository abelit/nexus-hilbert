import { describe, expect, it } from 'vitest';

import {
  allFields,
  buildCronExpression,
  fieldsAreValid,
  parseCronFields,
} from './cronBuilder';

describe('cron builder model', () => {
  it('round-trips the common shapes', () => {
    for (const [expr, expected] of [
      ['* * * * *', '* * * * *'],
      ['0/1 * * * *', '0/1 * * * *'],
      // The builder writes an explicit start for a step, so `*/5` becomes `0/5`.
      ['*/5 * * * *', '0/5 * * * *'],
      ['30 2 * * 1-5', '30 2 * * 1-5'],
      ['0 0 1,15 * *', '0 0 1,15 * *'],
    ] as const) {
      const parsed = parseCronFields(expr);
      expect(parsed, expr).not.toBeNull();
      expect(buildCronExpression(parsed!), expr).toBe(expected);
    }
  });

  it('normalizes a six-field expression whose seconds are zero', () => {
    const parsed = parseCronFields('0 0/5 * * * *');
    expect(parsed).not.toBeNull();
    expect(buildCronExpression(parsed!)).toBe('0/5 * * * *');
  });

  it('leaves unsupported Quartz syntax to the text editor', () => {
    expect(parseCronFields('0 2 * * ?')).toBeNull();
    expect(parseCronFields('0 2 L * *')).toBeNull();
    expect(parseCronFields('0 2 * * 1#1')).toBeNull();
    expect(parseCronFields('30 * * * * *')).toBeNull();
  });

  it('treats an empty expression as an editable all-fields draft', () => {
    const parsed = parseCronFields('');
    expect(parsed).not.toBeNull();
    expect(buildCronExpression(parsed!)).toBe('* * * * *');
    expect(buildCronExpression(allFields())).toBe('* * * * *');
  });

  it('rejects a range that runs backwards and an empty list mode', () => {
    const fields = allFields();
    fields.hour = { mode: 'range', start: 18, end: 8, step: 1, values: [] };
    expect(fieldsAreValid(fields)).toBe(false);

    fields.hour = { mode: 'list', start: 0, end: 1, step: 1, values: [] };
    expect(fieldsAreValid(fields)).toBe(false);

    fields.hour = { mode: 'list', start: 0, end: 1, step: 1, values: [8, 18] };
    expect(fieldsAreValid(fields)).toBe(true);
    expect(buildCronExpression(fields)).toBe('* 8,18 * * *');
  });
});
