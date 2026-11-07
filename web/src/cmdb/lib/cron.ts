// A small preview helper for the cron expressions discovery targets use.
//
// THE SCHEDULE ITSELF IS THE COLLECTOR'S. This module does not decide when a
// task runs; it only turns the common forms into a sentence and a next-run
// hint so an operator does not have to read five fields to notice that
// "0/1 * * * *" means every minute. Expressions outside the forms below are
// left without a preview rather than guessed at.

export type CronPreview = {
  /** Empty when the expression is not one of the forms this helper knows. */
  text: string;
  /** Local time of the next run, or null when it cannot be computed. */
  next: Date | null;
};

type Translate = (zh: string, en: string) => string;

const MINUTE = 60_000;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function intIn(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return number >= min && number <= max ? number : null;
}

/** 5 fields, or 6 with seconds pinned to zero (the shape cantor stored). */
function fieldsOf(expr: string): string[] | null {
  const parts = expr.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 6) {
    if (parts[0] !== '0') return null;
    parts.shift();
  }
  return parts.length === 5 ? parts : null;
}

function everyNMinutes(field: string): number | null {
  if (field === '*') return 1;
  let match = /^\*\/(\d+)$/.exec(field);
  if (!match) match = /^0\/(\d+)$/.exec(field);
  if (!match) return null;
  const step = Number(match[1]);
  return step >= 1 && step <= 59 ? step : null;
}

function isEveryDay(fields: string[]): boolean {
  return fields[2] === '*' && fields[3] === '*' && fields[4] === '*';
}

function nextMinute(from: Date): Date {
  const next = new Date(from.getTime() + MINUTE);
  next.setSeconds(0, 0);
  return next;
}

function nextStep(from: Date, step: number): Date {
  let next = nextMinute(from);
  // Two days is enough to find the next minute in a minute-based step.
  for (let index = 0; index < 2 * 24 * 60; index += 1) {
    if (next.getMinutes() % step === 0) return next;
    next = new Date(next.getTime() + MINUTE);
  }
  return from;
}

function nextHourlyAt(from: Date, minute: number): Date {
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setMinutes(minute);
  if (next.getTime() <= from.getTime()) next.setHours(next.getHours() + 1);
  return next;
}

function nextDailyAt(from: Date, hour: number, minute: number): Date {
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** "2026-11-07 21:08:00" in the operator's local clock. */
export function formatCronDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function cronPreview(expr: string, tr: Translate, from = new Date()): CronPreview {
  const fields = fieldsOf(expr);
  if (!fields) return { text: '', next: null };
  const [minuteField, hourField] = fields;
  if (!isEveryDay(fields)) return { text: '', next: null };

  const step = everyNMinutes(minuteField);
  if (step != null && hourField === '*') {
    if (step === 1) {
      return { text: tr('每分钟执行', 'Every minute'), next: nextMinute(from) };
    }
    return {
      text: tr(`每 ${step} 分钟执行`, `Every ${step} minutes`),
      next: nextStep(from, step),
    };
  }

  const minute = intIn(minuteField, 0, 59);
  if (minute != null && hourField === '*') {
    return {
      text: tr(`每小时第 ${minute} 分钟执行`, `Every hour at minute ${minute}`),
      next: nextHourlyAt(from, minute),
    };
  }
  const hour = intIn(hourField, 0, 23);
  if (minute != null && hour != null) {
    return {
      text: tr(`每天 ${pad(hour)}:${pad(minute)} 执行`, `Every day at ${pad(hour)}:${pad(minute)}`),
      next: nextDailyAt(from, hour, minute),
    };
  }
  return { text: '', next: null };
}
