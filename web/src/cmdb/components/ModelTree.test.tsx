import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { useAuth } from '@/store/auth';
import { ModelTree } from './ModelTree';

const models = [
  { id: 1, name: 'host', alias: '主机', enabled: true, is_attached: true, order: 0, parent_ids: [] },
  { id: 2, name: 'switch', alias: '交换机', enabled: false, is_attached: true, order: 1, parent_ids: [] },
];
const groups = [
  { id: 10, name: '服务器', ci_types: [models[0]] },
  { id: 11, name: '网络', ci_types: [models[1]] },
];

beforeEach(() => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
  useAuth.setState({ token: null, role: 'user' });
});

function renderTree(selectedID?: number) {
  return render(
    <MemoryRouter>
      <ModelTree models={models} groups={groups} selectedID={selectedID} loading={false} />
    </MemoryRouter>,
  );
}

describe('the model tree', () => {
  it('groups models and marks the selected row', async () => {
    renderTree(1);
    expect(screen.getByText('服务器')).toBeInTheDocument();
    expect(screen.getByText('网络')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /主机/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /交换机/ })).not.toHaveAttribute('aria-current');
  });

  it('filters across groups without dropping the group context', async () => {
    const user = userEvent.setup();
    renderTree();
    await user.type(screen.getByLabelText('搜索模型'), '交换');

    expect(screen.getByText('网络')).toBeInTheDocument();
    expect(screen.queryByText('服务器')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /交换机/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /主机/ })).not.toBeInTheDocument();
  });

  it('offers a create link that the list page turns into the model form', () => {
    renderTree();
    expect(screen.getByRole('link', { name: /新建/ })).toHaveAttribute('href', '/cmdb/models?new=1');
  });

  it('offers drag handles to an administrator when real groups exist', () => {
    useAuth.setState({ token: null, role: 'admin' });
    renderTree();

    expect(screen.getByRole('button', { name: '拖动分组 服务器' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拖动模型 host' })).toBeInTheDocument();
  });

  it('keeps the tree static for a non-admin', () => {
    renderTree();
    expect(screen.queryByRole('button', { name: /^拖动/ })).not.toBeInTheDocument();
  });
});
