import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/test/msw-server';
import { selectOption } from '@/test/select-option';
import { AttributeForm } from './AttributeForm';

const models = [
  { id: 1, name: 'host', alias: '主机', enabled: true, is_attached: true, order: 0, parent_ids: [] },
  { id: 2, name: 'disk', alias: '磁盘', enabled: true, is_attached: true, order: 0, parent_ids: [] },
];

function renderForm(attribute: Parameters<typeof AttributeForm>[0]['attribute'] = null) {
  const onSaved = vi.fn();
  render(<AttributeForm attribute={attribute} onClose={() => {}} onSaved={onSaved} />);
  return { onSaved };
}

beforeEach(() => {
  server.use(http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: models, total: models.length })));
});

describe('the full attribute editor', () => {
  it('creates flags, static choices, validation and presentation options', async () => {
    const user = userEvent.setup();
    let posted: Record<string, unknown> | null = null;
    server.use(
      http.post('/api/v1/cmdb/attributes', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 99, ...posted });
      }),
    );
    const { onSaved } = renderForm();

    await user.type(screen.getByLabelText('属性名'), 'env');
    await user.type(screen.getByLabelText('别名'), '环境');
    await user.click(screen.getByRole('checkbox', { name: '密码' }));
    await user.click(screen.getByLabelText('静态选项'));
    await user.click(screen.getByRole('button', { name: '添加选项' }));
    await user.type(screen.getByLabelText('值'), 'prod');
    await user.type(screen.getByLabelText('标签'), '生产');
    fireEvent.change(screen.getByLabelText('正则校验'), { target: { value: '^[a-z]+$' } });
    await user.clear(screen.getByLabelText('展示选项 JSON'));
    fireEvent.change(screen.getByLabelText('展示选项 JSON'), { target: { value: '{"fontOptions":{"color":"#123456"}}' } });
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toMatchObject({
      name: 'env',
      alias: '环境',
      is_password: true,
      re_check: '^[a-z]+$',
      option: { fontOptions: { color: '#123456' } },
      choice_value: [{ value: 'prod', option: { label: '生产' } }],
      choice_web_hook: {},
      choice_other: {},
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('sends a reference model and keeps a text attribute unindexed when asked', async () => {
    const user = userEvent.setup();
    let posted: Record<string, unknown> | null = null;
    server.use(
      http.post('/api/v1/cmdb/attributes', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 100, ...posted });
      }),
    );
    renderForm();

    await user.type(screen.getByLabelText('属性名'), 'owner');
    await user.click(screen.getByRole('checkbox', { name: '引用' }));
    await selectOption(screen.getByLabelText('引用模型'), '主机');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toMatchObject({ is_reference: true, reference_type_id: 1 });
  });

  it('does not edit the immutable value type or list flag on an existing attribute', () => {
    renderForm({
      id: 10,
      name: 'hostname',
      alias: '主机名',
      value_type: '2',
      is_choice: false,
      is_list: true,
      is_unique: false,
      is_index: true,
      is_link: false,
      is_password: false,
      is_sortable: false,
      is_dynamic: false,
      is_bool: false,
      is_file: false,
      is_reference: false,
      is_computed: false,
      has_compute_script: false,
      has_choice_web_hook: false,
      has_choice_other: false,
      is_indexed: true,
      storage_table: 'c_value_index_texts',
    });

    expect(screen.getByLabelText('值类型')).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: '多值' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('值类型创建后不能修改，避免已有值落入错误的存储表。')).toBeInTheDocument();
  });

  it('rejects malformed presentation JSON before sending', async () => {
    const user = userEvent.setup();
    let requests = 0;
    server.use(
      http.post('/api/v1/cmdb/attributes', () => {
        requests += 1;
        return HttpResponse.json({ id: 101 });
      }),
    );
    renderForm();

    await user.type(screen.getByLabelText('属性名'), 'bad');
    fireEvent.change(screen.getByLabelText('展示选项 JSON'), { target: { value: '{' } });
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/JSON/i);
    expect(requests).toBe(0);
  });
});
