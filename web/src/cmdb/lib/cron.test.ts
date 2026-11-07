import { describe, expect, it } from 'vitest';

import { cronPreview, formatCronDate } from './cron';

const tr = (zh: string, _en: string) => zh;
const at = (value: string) => new Date(value);

describe('cron preview', () => {
  it('describes every-minute forms, including cantor’s 0/1', () => {
    expect(cronPreview('* * * * *', tr, at('2026-11-07T20:00:30')).text).toBe('每分钟执行');
    expect(cronPreview('0/1 * * * *', tr, at('2026-11-07T20:00:30')).text).toBe('每分钟执行');
  });

  it('computes the next five-minute boundary', () => {
    const got = cronPreview('*/5 * * * *', tr, at('2026-11-07T20:02:30'));
    expect(got.text).toBe('每 5 分钟执行');
    expect(formatCronDate(got.next!)).toBe('2026-11-07 20:05:00');
  });

  it('describes hourly and daily schedules', () => {
    const hourly = cronPreview('15 * * * *', tr, at('2026-11-07T20:20:00'));
    expect(hourly.text).toBe('每小时第 15 分钟执行');
    expect(formatCronDate(hourly.next!)).toBe('2026-11-07 21:15:00');

    const daily = cronPreview('30 2 * * *', tr, at('2026-11-07T20:20:00'));
    expect(daily.text).toBe('每天 02:30 执行');
    expect(formatCronDate(daily.next!)).toBe('2026-11-08 02:30:00');
  });

  it('accepts a six-field expression whose seconds are zero', () => {
    const got = cronPreview('0 0 * * * *', tr, at('2026-11-07T20:20:00'));
    expect(got.text).toBe('每小时第 0 分钟执行');
  });

  it('leaves expressions it cannot describe without a preview', () => {
    expect(cronPreview('30 2 * * 1', tr)).toEqual({ text: '', next: null });
    expect(cronPreview('0 2 * * 1-5', tr)).toEqual({ text: '', next: null });
    expect(cronPreview('not a cron', tr)).toEqual({ text: '', next: null });
    expect(cronPreview('30 * * * * *', tr)).toEqual({ text: '', next: null });
  });
});
