import { useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { server } from '@/test/msw-server';

import type { CIType, TypeAttribute } from '../api/citype';
import type { ReferenceLabels } from '../lib/reference-labels';
import { ReferencePicker } from './ReferencePicker';

const members: CIType = {
  id: 54,
  name: 'members',
  alias: '人员',
  enabled: true,
  is_attached: true,
  order: 0,
  unique_key: 'userid',
  show_name: 'name',
  parent_ids: [],
};

const owner: TypeAttribute = {
  id: 13,
  name: 'ops_owner',
  alias: '运维负责人',
  value_type: '0',
  is_choice: false,
  is_list: false,
  is_unique: false,
  is_index: true,
  is_link: false,
  is_password: false,
  is_sortable: false,
  is_dynamic: false,
  is_bool: false,
  is_file: false,
  is_reference: true,
  reference_type_id: 54,
  is_required: false,
  order: 13,
  default_show: true,
  inherited: false,
  is_computed: false,
  has_compute_script: false,
  has_choice_web_hook: false,
  has_choice_other: false,
  is_indexed: true,
  storage_table: 'c_value_index_ints',
};

function hits() {
  return [
    { _id: 374, _type: 54, ci_id: 374, ci_type: 'members', name: '何忠贵', userid: 'A01492' },
    { _id: 387, _type: 54, ci_id: 387, ci_type: 'members', name: '夏梅娇', userid: 'A01577' },
  ];
}

function Harness({
  initial = null,
  labels = new Map<number, string>(),
  multiple = false,
}: {
  initial?: unknown;
  labels?: ReferenceLabels;
  multiple?: boolean;
}) {
  const [value, setValue] = useState<unknown>(initial);
  return (
    <>
      <ReferencePicker
        id="owner"
        attribute={{ ...owner, is_list: multiple }}
        target={members}
        labels={labels}
        value={value}
        onChange={setValue}
      />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}

beforeEach(() => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
});

describe('the reference picker', () => {
  it('searches the referenced model and selects the instance id', async () => {
    const user = userEvent.setup();
    const queries: string[] = [];
    server.use(
      http.post('/api/v1/cmdb/ci/s', async ({ request }) => {
        const body = (await request.json()) as { q: string };
        queries.push(body.q);
        return HttpResponse.json({ numfound: 1, total: 1, page: 1, result: hits() });
      }),
    );
    render(<Harness />);

    const trigger = screen.getByRole('combobox', { name: '运维负责人' });
    await act(async () => { await user.click(trigger); });
    const input = await screen.findByRole('combobox', { name: '搜索运维负责人' });
    await act(async () => { await user.type(input, '何'); });
    await waitFor(() => expect(queries.some((query) => query.includes('*何*'))).toBe(true));
    const option = await screen.findByRole('option', { name: '何忠贵' });
    await act(async () => { await user.click(option); });

    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('374'));
    expect(trigger).toHaveTextContent('何忠贵');
  });

  it('shows the resolved name for an existing value and can clear it', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/v1/cmdb/ci/s', () => HttpResponse.json({ numfound: 0, total: 0, page: 1, result: [] })),
    );
    render(<Harness initial={374} labels={new Map([[374, '何忠贵']])} />);

    const trigger = screen.getByRole('combobox', { name: '运维负责人' });
    expect(trigger).toHaveTextContent('何忠贵');
    await act(async () => {
      await user.click(screen.getByRole('button', { name: '清除选择' }));
    });
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('null'));
  });

  it('keeps several selections for a multi-valued reference', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/v1/cmdb/ci/s', () => HttpResponse.json({ numfound: 2, total: 2, page: 1, result: hits() })),
    );
    render(<Harness multiple />);

    const trigger = screen.getByRole('combobox', { name: '运维负责人' });
    await act(async () => { await user.click(trigger); });
    const first = await screen.findByRole('option', { name: '何忠贵' });
    await act(async () => { await user.click(first); });
    const second = await screen.findByRole('option', { name: '夏梅娇' });
    await act(async () => { await user.click(second); });

    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[374,387]'));
    expect(trigger).toHaveTextContent('何忠贵, 夏梅娇');

    await act(async () => {
      await user.click(screen.getByRole('button', { name: '清除选择' }));
    });
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('[]'));
  });
});
