import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { buildRowsBlob, buildTemplateBlob, parseSheetFile, SheetError } from './sheet';

function csvFile(text: string, name = 'hosts.csv'): File {
  return new File([text], name, { type: 'text/csv' });
}

describe('sheet parsing', () => {
  it('parses a CSV header and rows, including quoted commas', async () => {
    const parsed = await parseSheetFile(csvFile('hostname,cpu,note\nweb-01,8,"rack, A"\nweb-02,4,\n'));
    expect(parsed).toEqual({
      headers: ['hostname', 'cpu', 'note'],
      rows: [
        ['web-01', '8', 'rack, A'],
        ['web-02', '4', ''],
      ],
    });
  });

  it('parses an XLSX workbook', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('hosts');
    sheet.addRow(['hostname', 'cpu']);
    sheet.addRow(['web-01', 8]);
    const buffer = await workbook.xlsx.writeBuffer();
    const file = new File([buffer], 'hosts.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    const parsed = await parseSheetFile(file);
    expect(parsed.headers).toEqual(['hostname', 'cpu']);
    expect(parsed.rows).toEqual([['web-01', 8]]);
  });

  it('writes Excel dates as the wall clock the import parser accepts', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('hosts');
    sheet.addRow(['hostname', 'installed_on', 'last_seen']);
    sheet.addRow([
      'web-01',
      new Date(Date.UTC(2026, 9, 26)),
      new Date(Date.UTC(2026, 9, 26, 13, 45, 30)),
    ]);
    const buffer = await workbook.xlsx.writeBuffer();
    const file = new File([buffer], 'hosts.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    // A date attribute rejects the toISOString() form; the space-separated
    // wall clock is what both the date and the datetime validators parse.
    expect((await parseSheetFile(file)).rows).toEqual([
      ['web-01', '2026-10-26 00:00:00', '2026-10-26 13:45:30'],
    ]);
  });

  it('refuses too many rows and unsupported extensions', async () => {
    const tooMany = ['hostname', ...Array.from({ length: 5001 }, (_, index) => `host-${index}`)].join('\n');
    await expect(parseSheetFile(csvFile(tooMany))).rejects.toBeInstanceOf(SheetError);
    await expect(parseSheetFile(new File(['x'], 'hosts.txt'))).rejects.toThrow(/CSV or XLSX/);
  });
});

// jsdom's Blob has no arrayBuffer(); FileReader is available in both jsdom and
// the browser, which is why the production reader uses it too.
function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the blob'));
    reader.readAsArrayBuffer(blob);
  });
}

async function readWorkbook(blob: Blob): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await readBlob(blob));
  return workbook;
}

describe('the downloadable template', () => {
  it('writes the headers and choice dropdowns', async () => {
    const blob = await buildTemplateBlob([
      { header: 'hostname' },
      { header: 'cpu', choices: ['4', '8'] },
      { header: '$rack.机柜编号', headerColor: 'FFFF0000' },
    ]);
    const workbook = await readWorkbook(blob);
    const sheet = workbook.worksheets[0];
    expect(sheet.getRow(1).values).toEqual([undefined, 'hostname', 'cpu', '$rack.机柜编号']);
    expect(sheet.getCell('B2').dataValidation?.type).toBe('list');
    expect(sheet.getCell('B2').dataValidation?.formulae).toEqual(['"4,8"']);
    expect(sheet.getCell('A2').dataValidation?.type).toBeUndefined();
    expect(sheet.getCell('C1').font?.color?.argb).toBe('FFFF0000');
  });

  it('leaves a list longer than Excel allows as free text', async () => {
    const blob = await buildTemplateBlob([
      { header: 'env', choices: Array.from({ length: 60 }, (_, index) => `environment-${index}`) },
    ]);
    const workbook = await readWorkbook(blob);
    const sheet = workbook.worksheets[0];
    expect(sheet.getCell('A2').dataValidation?.type).toBeUndefined();
  });
});

describe('the issue-rows download', () => {
  it('keeps the original headers and rows', async () => {
    const blob = await buildRowsBlob(['hostname', '$rack.机柜编号'], [['web-01', ''], ['web-02', 'R-A01']]);
    const workbook = await readWorkbook(blob);
    const sheet = workbook.worksheets[0];
    expect(sheet.getRow(1).values).toEqual([undefined, 'hostname', '$rack.机柜编号']);
    expect(sheet.getRow(2).values).toEqual([undefined, 'web-01', '']);
    expect(sheet.getRow(3).values).toEqual([undefined, 'web-02', 'R-A01']);
  });
});
