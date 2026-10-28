import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { toCSV, toJSON, toTSV, toYAML, type ExportColumn } from './export';

type Row = { name: string; note: string };

const columns: ExportColumn<Row>[] = [
  { key: 'name', header: 'Name', value: (row) => row.name },
  { key: 'note', header: 'Note', value: (row) => row.note },
];

describe('table export', () => {
  it('quotes separators, quotes and newlines with a BOM', () => {
    const csv = toCSV(columns, [{ name: 'a,b', note: 'say "hi"\nnow' }]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('Name,Note');
    expect(csv).toContain('"a,b"');
    expect(csv).toContain('"say ""hi""\nnow"');
  });

  it('writes TSV for the plain-text export', () => {
    const tsv = toTSV(columns, [{ name: 'a', note: 'b,c' }]);
    expect(tsv).toContain('Name\tNote');
    expect(tsv).toContain('a\tb,c');
  });

  it('keys JSON and YAML by the column key', () => {
    expect(JSON.parse(toJSON(columns, [{ name: 'a', note: 'b' }]))).toEqual([
      { name: 'a', note: 'b' },
    ]);
    expect(load(toYAML(columns, [{ name: 'a', note: 'b' }]))).toEqual([
      { name: 'a', note: 'b' },
    ]);
  });

  it('renders a missing value as empty rather than the string "undefined"', () => {
    const withGap: ExportColumn<{ name?: string }>[] = [
      { key: 'name', header: 'Name', value: (row) => row.name },
    ];
    expect(toCSV(withGap, [{}])).toBe('﻿Name\r\n');
    expect(JSON.parse(toJSON(withGap, [{}]))).toEqual([{ name: null }]);
  });
});
