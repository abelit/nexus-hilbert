import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '@/test/msw-server';
import { useAuth } from '@/store/auth';
import { ToastProvider } from '../components/Toast';
import { ModelForm } from './Models';

const attribute = {
  id: 1,
  name: 'hostname',
  alias: '主机名',
  value_type: '2',
  is_list: false,
  is_password: false,
  is_file: false,
  is_link: false,
  is_reference: false,
  is_computed: false,
  is_index: true,
  is_unique: true,
  is_sortable: true,
  is_dynamic: false,
  is_bool: false,
};

describe('ModelForm AI assist', () => {
  it('fills name, alias and identifying attribute from a suggestion', async () => {
    useAuth.setState({ token: null, role: 'admin' });
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/cmdb/attributes', () => HttpResponse.json({ items: [attribute], total: 1 })),
      http.post('/api/v1/aiops/cmdb/form-assist', () =>
        HttpResponse.json({
          kind: 'model',
          name: 'k8s_node',
          alias: 'K8s 节点',
          unique_key: 'hostname',
          default_order_attr: 'hostname',
          parent_ids: [],
        }),
      ),
    );

    render(
      <ToastProvider>
        <ModelForm row={null} models={[]} onClose={() => {}} onSaved={async () => {}} />
      </ToastProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'AI 生成模型信息' }));
    await user.type(screen.getByLabelText('描述你要填写的内容'), 'K8s 节点模型');
    await user.click(screen.getByRole('button', { name: '生成建议' }));
    await screen.findByText('k8s_node');
    await user.click(screen.getByRole('button', { name: '接受选中' }));

    expect(screen.getByLabelText('名称（唯一标识）')).toHaveValue('k8s_node');
    expect(screen.getByLabelText('别名（显示名）')).toHaveValue('K8s 节点');
  });
});
