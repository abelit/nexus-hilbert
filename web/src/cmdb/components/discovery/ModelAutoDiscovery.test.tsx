import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { server } from '@/test/msw-server';
import { selectOption } from '@/test/select-option';
import { ToastProvider } from '../Toast';
import { ModelAutoDiscovery } from './ModelAutoDiscovery';
import type { Rule, Target } from '../../api/discovery';

const rule: Rule = {
  id: 2,
  name: 'server',
  type: 'agent',
  is_inner: true,
  is_plugin: false,
  unique_key: 'hostname',
  attribute_count: 3,
  has_plugin_script: false,
  attributes: [
    { name: 'ip', type: 'string' },
    { name: 'uuid', type: 'string' },
    { name: 'host_name', type: 'string' },
  ],
};

const target: Target = {
  id: 13,
  type_id: 1,
  adr_id: rule.id,
  attributes: { ip: 'ip', uuid: 'uuid', host_name: 'host_name' },
  auto_accept: false,
  agent_id: '0xabc',
  query_expr: '',
  cron: '*/5 * * * *',
  extra_option: {},
  has_secret: false,
  has_password: false,
  enabled: true,
  adr_name: rule.name,
};

const attributes = {
  type_id: 1,
  unique_id: 10,
  unique: 'uuid',
  attributes: [
    {
      id: 10,
      name: 'uuid',
      alias: 'UUID',
      value_type: '2',
      is_list: false,
      is_index: true,
      is_indexed: true,
      inherited: false,
      is_required: true,
      order: 0,
      default_show: true,
      storage_table: 'c_value_index_texts',
    },
    {
      id: 11,
      name: 'ip',
      alias: 'IP 地址',
      value_type: '2',
      is_list: false,
      is_index: true,
      is_indexed: true,
      inherited: false,
      is_required: false,
      order: 1,
      default_show: true,
      storage_table: 'c_value_index_texts',
    },
  ],
};

const peer = {
  ctr_id: 8,
  type: {
    id: 9,
    name: 'rack',
    alias: '机柜',
    enabled: true,
    is_attached: true,
    icon: '',
    order: 0,
    unique_key: 'name',
    parent_ids: [],
  },
  show_key: 'name',
  attributes: [
    {
      id: 12,
      name: 'name',
      alias: '名称',
      value_type: '2',
      is_list: false,
      is_index: true,
      is_indexed: true,
      inherited: false,
      is_required: false,
      order: 0,
      default_show: true,
      storage_table: 'c_value_index_texts',
    },
  ],
  relation_type: { id: 1, name: '属于', color: '#6366f1' },
  constraint: '0',
  parent_attr_ids: [],
  child_attr_ids: [],
};

function localStamp(msAgo: number): string {
  const date = new Date(Date.now() - msAgo);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function baseHandlers(gotTargets: Target[]) {
  server.use(
    http.get('/api/v1/cmdb/discovery/rules', () => HttpResponse.json({ items: [rule], total: 1 })),
    http.get('/api/v1/cmdb/discovery/ci-types/1/targets', () =>
      HttpResponse.json({ items: gotTargets, total: gotTargets.length }),
    ),
    http.get('/api/v1/cmdb/ci-types/1/attributes', () => HttpResponse.json(attributes)),
    http.get('/api/v1/cmdb/discovery/ci-types/1/discoverable-attributes', () =>
      HttpResponse.json(['ip', 'uuid', 'host_name', 'rack']),
    ),
    http.get('/api/v1/cmdb/ci-types/1/relation-children', () => HttpResponse.json({ items: [], total: 0 })),
    http.get('/api/v1/cmdb/ci-types/1/relation-parents', () => HttpResponse.json({ items: [], total: 0 })),
    http.get('/api/v1/cmdb/discovery/ci-types/1/target-relations', () =>
      HttpResponse.json({ items: [], total: 0 }),
    ),
    http.get('/api/v1/cmdb/discovery/targets/13/health', () =>
      HttpResponse.json({
        target_id: 13,
        enabled: true,
        rule_type: 'agent',
        checked_at: localStamp(0),
        online_window_seconds: 600,
        agents: [],
      }),
    ),
  );
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ModelAutoDiscovery modelRef="1" modelLabel="主机" isAdmin />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
});

describe('model auto discovery', () => {
  it('shows the mapping, execution scope and collector health of a target', async () => {
    baseHandlers([target]);
    server.use(
      http.get('/api/v1/cmdb/discovery/targets/13/health', () =>
        HttpResponse.json({
          target_id: 13,
          enabled: true,
          rule_type: 'agent',
          checked_at: localStamp(0),
          online_window_seconds: 600,
          agents: [
            {
              euler_id: '0xabc',
              euler_name: 'host-1',
              status: 'active',
              registered: true,
              eligible: true,
              online: true,
              last_seen_at: localStamp(60_000),
              last_handover_at: localStamp(120_000),
            },
          ],
        }),
      ),
    );
    renderPanel();

    expect(await screen.findByRole('heading', { name: 'server' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '发现池' })).toHaveAttribute('href', '/cmdb/adc');
    expect(screen.getByRole('heading', { name: '属性映射' })).toBeInTheDocument();
    expect(screen.getByText('3/3 已匹配')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '执行配置' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '健康检查' })).toBeInTheDocument();
    expect(await screen.findByText(/共 1 个采集器，1 个在线/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '编辑规则' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '触发检查' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('host-1');
    expect(screen.getByRole('dialog')).toHaveTextContent('在线');
  });

  it('disables the health check until the unsaved mapping is saved', async () => {
    baseHandlers([target]);
    renderPanel();

    const check = await screen.findByRole('button', { name: '触发检查' });
    expect(check).toBeEnabled();
    await selectOption(screen.getByRole('combobox', { name: '映射 ip' }), 'UUID · 标识');
    expect(check).toBeDisabled();
    expect(screen.getByText('检查前请先保存当前配置。')).toBeInTheDocument();
  });

  it('requires a cron expression before saving an enabled target', async () => {
    baseHandlers([{ ...target, cron: '*/5 * * * *' }]);
    renderPanel();

    const cron = await screen.findByLabelText('Cron 表达式');
    await userEvent.clear(cron);
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('启用目标需要填写 Cron 表达式。');
  });

  it('invites the operator to add the first target', async () => {
    baseHandlers([]);
    renderPanel();

    expect(await screen.findByText('这个模型还没有发现目标')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加发现目标' })).toBeEnabled();
  });

  it('loads and replaces a relation row', async () => {
    let body: unknown;
    baseHandlers([target]);
    server.use(
      http.get('/api/v1/cmdb/ci-types/1/relation-children', () => HttpResponse.json({ items: [peer], total: 1 })),
      http.get('/api/v1/cmdb/discovery/ci-types/1/target-relations', () =>
        HttpResponse.json({
          items: [{ id: 5, ad_key: 'rack', peer_type_id: 9, peer_attr_id: 12 }],
          total: 1,
        }),
      ),
      http.put('/api/v1/cmdb/discovery/ci-types/1/target-relations', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          added: 0,
          removed: 0,
          relations: [{ id: 5, ad_key: 'rack', peer_type_id: 9, peer_attr_id: 12 }],
        });
      }),
    );
    renderPanel();

    await screen.findByRole('heading', { name: 'server' });
    await userEvent.click(screen.getByRole('tab', { name: '关系自动发现' }));

    expect(await screen.findByText('rack')).toBeInTheDocument();
    expect(screen.getByText('机柜')).toBeInTheDocument();
    expect(screen.getByText('名称')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '保存关系' }));
    await waitFor(() =>
      expect(body).toEqual({ relations: [{ ad_key: 'rack', peer_type_id: 9, peer_attr_id: 12 }] }),
    );
  });
});
