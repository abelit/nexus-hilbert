import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/test/msw-server';
import { FormAssistDialog } from './FormAssistDialog';

beforeEach(() => localStorage.setItem('ongrid-locale', 'zh-CN'));

const fields = [
  { name: 'hostname', label: '主机名', current: '', valueType: '2' },
  { name: 'owner', label: '负责人', current: '张三', valueType: '2' },
];

describe('FormAssistDialog', () => {
  it('accepts empty fields by default and leaves the filled one unchecked', async () => {
    const user = userEvent.setup();
    let posted: Record<string, unknown> | null = null;
    server.use(
      http.post('/api/v1/aiops/cmdb/form-assist', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          kind: 'instance',
          values: { hostname: 'web-01', owner: '李四' },
          explanations: { hostname: '按描述生成' },
        });
      }),
    );
    const onAccept = vi.fn();
    render(
      <FormAssistDialog
        open
        onClose={() => {}}
        mode="instance"
        ciType="host"
        fields={fields}
        onAccept={onAccept}
      />,
    );

    await user.type(screen.getByLabelText('描述你要填写的内容'), '一台生产 Web 服务器');
    await user.click(screen.getByRole('button', { name: '生成建议' }));

    await screen.findByText('web-01');
    expect(posted).toMatchObject({
      kind: 'instance',
      ci_type: 'host',
      fields: ['hostname', 'owner'],
      values: { owner: '张三' },
    });
    // The existing owner is shown but not selected for overwrite.
    expect(screen.queryByLabelText('采用 负责人')).not.toBeChecked();

    await user.click(screen.getByRole('button', { name: '接受选中' }));
    expect(onAccept).toHaveBeenCalledWith({ hostname: 'web-01' });
  });

  it('lets the operator explicitly overwrite a non-empty field', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/v1/aiops/cmdb/form-assist', () =>
        HttpResponse.json({ kind: 'instance', values: { owner: '李四' } }),
      ),
    );
    const onAccept = vi.fn();
    render(
      <FormAssistDialog
        open
        onClose={() => {}}
        mode="instance"
        ciType="host"
        fields={fields}
        onAccept={onAccept}
      />,
    );

    await user.type(screen.getByLabelText('描述你要填写的内容'), '改负责人');
    await user.click(screen.getByRole('button', { name: '生成建议' }));
    await screen.findByText('李四');
    await user.click(screen.getByLabelText('采用 负责人'));
    await user.click(screen.getByRole('button', { name: '接受选中' }));

    expect(onAccept).toHaveBeenCalledWith({ owner: '李四' });
  });

  it('reports an unavailable backend without breaking the form', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/v1/aiops/cmdb/form-assist', () => new HttpResponse(null, { status: 503 })),
    );
    render(
      <FormAssistDialog open onClose={() => {}} mode="instance" ciType="host" fields={fields} onAccept={() => {}} />,
    );

    await user.type(screen.getByLabelText('描述你要填写的内容'), '任意');
    await user.click(screen.getByRole('button', { name: '生成建议' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/AI 不可用/));
    expect(screen.getByRole('button', { name: '生成建议' })).toBeEnabled();
  });

  it('fills the chosen attribute when several are suggested', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/v1/aiops/cmdb/form-assist', () =>
        HttpResponse.json({
          kind: 'attribute',
          attributes: [
            { name: 'room', alias: '机房', value_type: '2' },
            { name: 'rack', alias: '机柜', value_type: '2', is_required: true },
          ],
        }),
      ),
    );
    const onAccept = vi.fn();
    render(
      <FormAssistDialog open onClose={() => {}} mode="attribute" modelRef="host" onAccept={onAccept} />,
    );

    await user.type(screen.getByLabelText('描述你要填写的内容'), '机房和机柜');
    await user.click(screen.getByRole('button', { name: '生成建议' }));
    await screen.findByText('机柜');
    await user.click(screen.getByLabelText('采用 机柜'));
    await user.click(screen.getByRole('button', { name: '接受选中' }));

    expect(onAccept).toHaveBeenCalledWith(expect.objectContaining({ name: 'rack' }));
  });

  it('accepts a suggested relation type with its colour', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/v1/aiops/cmdb/form-assist', () =>
        HttpResponse.json({
          kind: 'relation_type',
          name: 'runs_on',
          color: '#123456',
          warnings: ['relation type name already exists: runs_on'],
        }),
      ),
    );
    const onAccept = vi.fn();
    render(<FormAssistDialog open onClose={() => {}} mode="relation_type" onAccept={onAccept} />);

    await user.type(screen.getByLabelText('描述你要填写的内容'), '主机运行虚拟机');
    await user.click(screen.getByRole('button', { name: '生成建议' }));
    await screen.findByText('runs_on');
    expect(screen.getByText(/#123456/)).toBeInTheDocument();
    expect(screen.getByText(/already exists/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '接受选中' }));

    expect(onAccept).toHaveBeenCalledWith({ name: 'runs_on', color: '#123456' });
  });

  it('accepts a suggested model relation with resolved ids', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/v1/aiops/cmdb/form-assist', () =>
        HttpResponse.json({
          kind: 'model_relation',
          source_model_id: 1,
          target_model_id: 2,
          relation_type_id: 3,
          constraint: '0',
          parent_attr_ids: [11],
          child_attr_ids: [21],
        }),
      ),
    );
    const onAccept = vi.fn();
    render(
      <FormAssistDialog
        open
        onClose={() => {}}
        mode="model_relation"
        models={[
          { id: 1, name: 'host', alias: '主机' },
          { id: 2, name: 'vm', alias: '虚拟机' },
        ]}
        relationTypes={[{ id: 3, name: 'runs_on' }]}
        onAccept={onAccept}
      />,
    );

    await user.type(screen.getByLabelText('描述你要填写的内容'), '主机运行虚拟机');
    await user.click(screen.getByRole('button', { name: '生成建议' }));
    await screen.findByText('runs_on');
    expect(screen.getByText('一对多')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '接受选中' }));

    expect(onAccept).toHaveBeenCalledWith({
      source_model_id: 1,
      target_model_id: 2,
      relation_type_id: 3,
      constraint: '0',
      parent_attr_ids: [11],
      child_attr_ids: [21],
    });
  });
});
