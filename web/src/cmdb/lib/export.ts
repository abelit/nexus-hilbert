// Exporting what a table shows, in the formats cantor offered.
//
// THE WRITER IS SHARED, the columns are the table's. A page passes the rows it
// has already filtered, so an export never disagrees with the screen; the
// `filename` carries no extension and each writer adds its own.

import { dump } from 'js-yaml';

export type ExportFormat = 'csv' | 'xlsx' | 'json' | 'yaml' | 'txt';

export type ExportColumn<T> = {
  key: string;
  header: string;
  value(row: T): unknown;
};

export const EXPORT_FORMATS: Array<{ value: ExportFormat; zh: string; en: string; extension: string }> = [
  { value: 'csv', zh: 'CSV', en: 'CSV', extension: 'csv' },
  { value: 'xlsx', zh: 'Excel', en: 'Excel', extension: 'xlsx' },
  { value: 'json', zh: 'JSON', en: 'JSON', extension: 'json' },
  { value: 'yaml', zh: 'YAML', en: 'YAML', extension: 'yaml' },
  { value: 'txt', zh: '文本', en: 'Text', extension: 'txt' },
];

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function quote(value: string, separator: string): string {
  if (!value.includes(separator) && !value.includes('"') && !value.includes('\n') && !value.includes('\r')) {
    return value;
  }
  return `"${value.split('"').join('""')}"`;
}

/** RFC 4180, with a BOM so Excel reads UTF-8. */
export function toCSV<T>(columns: ExportColumn<T>[], rows: T[], separator = ','): string {
  const lines = [columns.map((column) => quote(column.header, separator)).join(separator)];
  for (const row of rows) {
    lines.push(columns.map((column) => quote(cell(column.value(row)), separator)).join(separator));
  }
  return `${String.fromCharCode(0xfeff)}${lines.join('\r\n')}`;
}

export function toTSV<T>(columns: ExportColumn<T>[], rows: T[]): string {
  return toCSV(columns, rows, '\t');
}

export function toJSON<T>(columns: ExportColumn<T>[], rows: T[]): string {
  return JSON.stringify(
    rows.map((row) =>
      Object.fromEntries(columns.map((column) => [column.key, column.value(row) ?? null])),
    ),
    null,
    2,
  );
}

export function toYAML<T>(columns: ExportColumn<T>[], rows: T[]): string {
  const documents = rows.map((row) =>
    Object.fromEntries(columns.map((column) => [column.key, column.value(row) ?? null])),
  );
  return dump(documents, { noRefs: true, lineWidth: 120 });
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.click();
  } finally {
    // The click has already claimed the URL; revoking now keeps the page from
    // leaking one per export.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Writes and downloads one export. Excel is loaded only when chosen. */
export async function exportRows<T>(
  filename: string,
  columns: ExportColumn<T>[],
  rows: T[],
  format: ExportFormat,
): Promise<void> {
  const base = filename.replace(/\.(csv|xlsx|json|yaml|yml|txt)$/i, '');
  switch (format) {
    case 'csv':
      downloadBlob(`${base}.csv`, new Blob([toCSV(columns, rows)], { type: 'text/csv;charset=utf-8' }));
      return;
    case 'txt':
      downloadBlob(`${base}.txt`, new Blob([toTSV(columns, rows)], { type: 'text/tab-separated-values;charset=utf-8' }));
      return;
    case 'json':
      downloadBlob(`${base}.json`, new Blob([toJSON(columns, rows)], { type: 'application/json;charset=utf-8' }));
      return;
    case 'yaml':
      downloadBlob(`${base}.yaml`, new Blob([toYAML(columns, rows)], { type: 'text/yaml;charset=utf-8' }));
      return;
    case 'xlsx': {
      const mod = await import('exceljs');
      const ExcelJS = mod.default ?? mod;
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.columns = columns.map((column) => ({ header: column.header, key: column.key, width: 24 }));
      for (const row of rows) {
        sheet.addRow(Object.fromEntries(columns.map((column) => [column.key, column.value(row) ?? ''])));
      }
      const buffer = await workbook.xlsx.writeBuffer();
      downloadBlob(
        `${base}.xlsx`,
        new Blob([buffer], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      );
      return;
    }
    default:
      return;
  }
}
