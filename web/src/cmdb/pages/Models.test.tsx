import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { server } from '@/test/msw-server';
import { selectOption } from '@/test/select-option';
import { useAuth } from '@/store/auth';
import ModelsPage from './Models';
import { ToastProvider } from '../components/Toast';

const models = [
  {
    id: 1,
    name: 'host',
    alias: '主机',
    enabled: true,
    is_attached: true,
    icon: '',
    order: 0,
    unique_key: 'hostname',
    parent_ids: [],
  },
  {
    id: 2,
    name: 'switch',
    alias: '交换机',
    enabled: false,
    is_attached: false,
    icon: '',
    order: 1,
    unique_key: 'hostname',
    parent_ids: [1],
  },
];

const attributes = [
  { id: 10, name: 'hostname', alias: '主机名', value_type: '2', is_list: false, is_index: true },
  { id: 11, name: 'cpu', alias: '核数', value_type: '0', is_list: false, is_index: true },
];

const database = {
  id: 3,
  name: 'database',
  alias: '数据库',
  enabled: true,
  is_attached: true,
  icon: '',
  order: 2,
  unique_key: 'db_name',
  parent_ids: [],
};

const modelGroups = [
  { id: 10, name: '服务器', ci_types: [models[0], database] },
  { id: 11, name: '网络', ci_types: [models[1]] },
];

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ModelsPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  useAuth.setState({ token: null, role: 'admin' });
  // THE SHELL ALSO LOADS GROUPS, and MSW treats an unhandled request as an
  // error. A default empty answer keeps the flat-list cases honest; grouped
  // cases override it.
  server.use(http.get('/api/v1/cmdb/preferences/model-groups', () => HttpResponse.json({ items: [], total: 0 })));
});

describe('the list', () => {
  it('keeps the workspace bar above the tree and the content', async () => {
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: models, total: models.length })),
      http.get('/api/v1/cmdb/attributes', () => HttpResponse.json({ items: attributes, total: attributes.length })),
    );
    renderPage();

    const bar = await screen.findByRole('banner');
    expect(within(bar).getByText('CMDB 资源管理平台')).toBeInTheDocument();
    expect(within(bar).getByRole('heading', { level: 1, name: '模型配置' })).toBeInTheDocument();
    expect(within(bar).getByText('总数')).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: /新建模型/ })).toBeInTheDocument();
    // The tree is a sibling of the bar, not a child: it starts below it.
    expect(within(bar).queryByPlaceholderText('搜索模型分组或模型…')).not.toBeInTheDocument();
  });

  it('draws the models and their navigation links', async () => {
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: models, total: models.length })),
      http.get('/api/v1/cmdb/attributes', () => HttpResponse.json({ items: attributes, total: attributes.length })),
    );
    renderPage();

    expect(await screen.findByRole('link', { name: '主机' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '交换机' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '主机' })).toHaveAttribute('href', '/cmdb/models/1');
    expect(screen.getByRole('link', { name: '交换机' })).toHaveAttribute('href', '/cmdb/models/2');
  });

  it('filters by name or alias without a request per keystroke', async () => {
    const user = userEvent.setup();
    let requests = 0;
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => {
        requests += 1;
        return HttpResponse.json({ items: models, total: models.length });
      }),
    );
    renderPage();

    await screen.findByRole('link', { name: '主机' });
    const before = requests;
    await user.type(screen.getByLabelText('搜索模型列表'), '交换');
    // THE LIST IS THE SCHEMA: a deployment has tens of models, so the filter runs
    // over the page's own rows rather than issuing a request per character.
    expect(requests).toBe(before);
    expect(screen.queryByRole('link', { name: '主机' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '交换机' })).toBeInTheDocument();
  });

  it('pages a long model list and reports the visible range', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 21 }, (_, index) => ({
      ...models[0],
      id: index + 1,
      name: `model_${String(index + 1).padStart(2, '0')}`,
      alias: `模型 ${String(index + 1).padStart(2, '0')}`,
      order: index,
    }));
    server.use(http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: many, total: many.length })));
    renderPage();

    expect(await screen.findByText('显示 1 至 20 条，共 21 条模型')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: '模型 01' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: '模型 21' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '第 2 页' }));
    expect(await screen.findByText('显示 21 至 21 条，共 21 条模型')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: '模型 21' }).length).toBeGreaterThan(0);
  }, 30000);

  it('presents the schema as cards and keeps the actions', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: models, total: models.length })));
    renderPage();

    await screen.findByRole('link', { name: '主机' });
    await user.click(screen.getByRole('button', { name: '网格' }));

    expect(await screen.findByRole('heading', { name: '主机' })).toBeInTheDocument();
    expect(screen.getByText('host')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑 host' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '停用 host' })).toBeInTheDocument();
  });

  it('does not turn cantor’s stored is_attached flag into a usability claim', async () => {
    // THE FLAG IS NOT "HAS BOUND ATTRIBUTES". cantor data carries false on
    // models with dozens of bindings, so the list must not tell an operator a
    // model cannot hold instances based on it.
    const user = userEvent.setup();
    server.use(http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: models, total: models.length })));
    renderPage();

    await screen.findByRole('link', { name: '交换机' });
    expect(screen.queryByText('不可存实例')).not.toBeInTheDocument();
    expect(screen.getByText('含继承')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '网格' }));
    expect(screen.queryByText('不可存实例')).not.toBeInTheDocument();
  });

  it('disables the writes for a non-administrator', async () => {
    useAuth.setState({ token: null, role: 'user' });
    server.use(http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: models, total: models.length })));
    renderPage();

    expect(await screen.findByRole('button', { name: /新建模型/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: '编辑 host' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '启用 switch' })).toBeDisabled();
  });

  it('offers the built-in bootstrap and reports what it did', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [], total: 0 })),
      http.post('/api/v1/cmdb/ci-types/builtin-models', () => HttpResponse.json({ created: ['dcim_rack'], existing: [] })),
    );
    renderPage();

    await screen.findByText('还没有模型。可以先创建内建模型，或新建一个。');
    await user.click(screen.getByRole('button', { name: /内建模型/ }));
    expect(await screen.findByText('已创建 1 个内建模型')).toBeInTheDocument();
  });
});

describe('grouping', () => {
  function groupedHandlers() {
    server.use(
      http.get('/api/v1/cmdb/ci-types', () =>
        HttpResponse.json({ items: [...models, database], total: 3 }),
      ),
      http.get('/api/v1/cmdb/preferences/model-groups', () =>
        HttpResponse.json({ items: modelGroups, total: modelGroups.length }),
      ),
    );
  }

  it('groups the table rows by the shared groups when asked', async () => {
    const user = userEvent.setup();
    groupedHandlers();
    renderPage();

    await screen.findByRole('link', { name: '主机' });
    // THE DEFAULT IS STILL FLAT: the feature is an opt-in display mode.
    expect(screen.queryByRole('rowheader')).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: '按分组显示' }));

    const headers = screen.getAllByRole('rowheader');
    expect(headers).toHaveLength(2);
    expect(headers[0]).toHaveTextContent('服务器');
    expect(headers[1]).toHaveTextContent('网络');

    const serverBody = headers[0].closest('tbody');
    const networkBody = headers[1].closest('tbody');
    expect(serverBody).not.toBeNull();
    expect(networkBody).not.toBeNull();
    if (!serverBody || !networkBody) return;

    expect(within(serverBody).getByRole('link', { name: '主机' })).toBeInTheDocument();
    expect(within(serverBody).getByRole('link', { name: '数据库' })).toBeInTheDocument();
    expect(within(networkBody).getByRole('link', { name: '交换机' })).toBeInTheDocument();
    expect(within(serverBody).getByText('2 个模型')).toBeInTheDocument();
    expect(within(networkBody).getByText('1 个模型')).toBeInTheDocument();

    const table = screen.getByRole('table');
    // ONE ROW PER MODEL, not one flat row set plus one grouped row set.
    expect(within(table).getAllByRole('link', { name: '主机' })).toHaveLength(1);
    expect(within(table).getByRole('button', { name: '编辑 host' })).toBeInTheDocument();
  });

  it('keeps the group sections in the grid view', async () => {
    const user = userEvent.setup();
    groupedHandlers();
    renderPage();

    await screen.findByRole('link', { name: '主机' });
    await user.click(screen.getByRole('checkbox', { name: '按分组显示' }));
    await user.click(screen.getByRole('button', { name: '网格' }));

    const serverRegion = await screen.findByRole('region', { name: '服务器' });
    const networkRegion = screen.getByRole('region', { name: '网络' });
    expect(within(serverRegion).getByRole('heading', { name: '主机' })).toBeInTheDocument();
    expect(within(serverRegion).getByRole('heading', { name: '数据库' })).toBeInTheDocument();
    expect(within(networkRegion).getByRole('heading', { name: '交换机' })).toBeInTheDocument();
    expect(within(serverRegion).getByRole('button', { name: '编辑 host' })).toBeInTheDocument();
  });

  it('filters within groups and hides groups with no match', async () => {
    const user = userEvent.setup();
    groupedHandlers();
    renderPage();

    await screen.findByRole('link', { name: '主机' });
    await user.click(screen.getByRole('checkbox', { name: '按分组显示' }));
    await user.type(screen.getByLabelText('搜索模型列表'), '数据');

    expect(screen.getByRole('rowheader', { name: /服务器/ })).toBeInTheDocument();
    expect(screen.queryByRole('rowheader', { name: /网络/ })).not.toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByRole('link', { name: '数据库' })).toBeInTheDocument();
    expect(within(table).queryByRole('link', { name: '主机' })).not.toBeInTheDocument();
    expect(screen.getByText('显示 1 / 3')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(await screen.findByRole('rowheader', { name: /网络/ })).toBeInTheDocument();
  });

  it('applies only-enabled inside every group', async () => {
    const user = userEvent.setup();
    groupedHandlers();
    renderPage();

    await screen.findByRole('link', { name: '主机' });
    await user.click(screen.getByRole('checkbox', { name: '按分组显示' }));
    await user.click(screen.getByRole('button', { name: /已启用/ }));

    const serverHeader = screen.getByRole('rowheader', { name: /服务器/ });
    expect(screen.queryByRole('rowheader', { name: /网络/ })).not.toBeInTheDocument();
    const serverBody = serverHeader.closest('tbody');
    expect(serverBody).not.toBeNull();
    if (!serverBody) return;
    expect(serverBody).toHaveTextContent('主机');
    expect(serverBody).toHaveTextContent('数据库');
    expect(serverBody).not.toHaveTextContent('交换机');
    expect(screen.getByText('显示 2 / 3')).toBeInTheDocument();
  });

  it('assembles a fallback list when the groups cannot be loaded, then retries', async () => {
    const user = userEvent.setup();
    let failed = true;
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [...models, database], total: 3 })),
      http.get('/api/v1/cmdb/preferences/model-groups', () =>
        failed
          ? new HttpResponse(null, { status: 500 })
          : HttpResponse.json({ items: modelGroups, total: modelGroups.length }),
      ),
    );
    renderPage();

    expect(await screen.findByRole('link', { name: '主机' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/模型分组/);
    expect(screen.queryByRole('checkbox', { name: '按分组显示' })).not.toBeInTheDocument();

    failed = false;
    await user.click(screen.getByRole('button', { name: '重试分组' }));
    expect(await screen.findByRole('checkbox', { name: '按分组显示' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('lets a non-administrator view groups while keeping writes disabled', async () => {
    const user = userEvent.setup();
    useAuth.setState({ token: null, role: 'user' });
    groupedHandlers();
    renderPage();

    await screen.findByRole('link', { name: '主机' });
    const toggle = screen.getByRole('checkbox', { name: '按分组显示' });
    expect(toggle).not.toBeDisabled();
    await user.click(toggle);

    expect(screen.getByRole('rowheader', { name: /服务器/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑 host' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '停用 host' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除 host' })).toBeDisabled();
  });
});

describe('creating a model', () => {
  it('requires an identifying attribute that already exists', async () => {
    const user = userEvent.setup();
    const posted: unknown[] = [];
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: models, total: models.length })),
      http.get('/api/v1/cmdb/attributes', () => HttpResponse.json({ items: attributes, total: attributes.length })),
      http.post('/api/v1/cmdb/ci-types', async ({ request }) => {
        posted.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ id: 3, ...(posted.at(-1) as object) }, { status: 201 });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: /新建模型/ }));
    await user.type(screen.getByLabelText('名称（唯一标识）'), 'database');
    await user.type(screen.getByLabelText('别名（显示名）'), '数据库');
    await user.click(screen.getByRole('button', { name: '保存' }));

    // THE BACKEND REFUSES A MODEL WHOSE `unique_key` NAMES NO ATTRIBUTE, so the
    // form refuses it first and says why.
    expect(await screen.findByRole('alert')).toHaveTextContent('标识属性');
    expect(posted).toHaveLength(0);
  });

  it('carries the display attribute, default sort and inherited parents on create', async () => {
    const user = userEvent.setup();
    const posted: Record<string, unknown>[] = [];
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [models[0]], total: 1 })),
      http.get('/api/v1/cmdb/attributes', () =>
        HttpResponse.json({
          items: [
            { id: 10, name: 'hostname', alias: '主机名', value_type: '2', is_list: false, is_index: true },
            { id: 11, name: 'cpu', alias: '核数', value_type: '0', is_list: false, is_index: true },
          ],
          total: 2,
        }),
      ),
      http.post('/api/v1/cmdb/ci-types', async ({ request }) => {
        posted.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ id: 3 }, { status: 201 });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: /新建模型/ }));
    await user.type(screen.getByLabelText('名称（唯一标识）'), 'database');
    await user.type(screen.getByLabelText('别名（显示名）'), '数据库');
    await selectOption(screen.getByLabelText('标识属性'), 'hostname（主机名）');
    await selectOption(screen.getByLabelText('展示属性'), '主机名（hostname）');
    await selectOption(screen.getByLabelText('默认排序列'), '主机名（hostname）');
    await selectOption(screen.getByLabelText('排序方向'), '降序');
    await user.click(screen.getByRole('checkbox', { name: '主机' }));
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      name: 'database',
      unique_key: 'hostname',
      show_key: 'hostname',
      default_order_attr: '-hostname',
      parent_ids: [1],
    });
  });

  it('creates the identifying attribute inline, then the model', async () => {
    const user = userEvent.setup();
    const createdAttributes: unknown[] = [];
    const createdModels: unknown[] = [];
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/attributes', () => HttpResponse.json({ items: [], total: 0 })),
      http.post('/api/v1/cmdb/attributes', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        createdAttributes.push(body);
        return HttpResponse.json({ id: 12, ...body }, { status: 201 });
      }),
      http.post('/api/v1/cmdb/ci-types', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        createdModels.push(body);
        return HttpResponse.json({ id: 3, ...body }, { status: 201 });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: /新建模型/ }));
    await user.type(screen.getByLabelText('名称（唯一标识）'), 'database');
    await user.type(screen.getByLabelText('别名（显示名）'), '数据库');

    // A FRESH DEPLOYMENT HAS NO ATTRIBUTES AT ALL, so without this the page would
    // be unusable the first time it is opened: no model means no place to add an
    // attribute, and no attribute means no model.
    await user.click(screen.getByRole('button', { name: '新建属性' }));
    await user.type(screen.getByLabelText('属性名'), 'db_name');
    await user.click(screen.getByRole('button', { name: '创建并选用' }));

    await waitFor(() => expect(createdAttributes).toHaveLength(1));
    expect(createdAttributes[0]).toMatchObject({ name: 'db_name', value_type: '2' });

    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(createdModels).toHaveLength(1));
    // THE INLINE ATTRIBUTE BECAME THE UNIQUE KEY, which is the only reason the
    // inline form exists.
    expect(createdModels[0]).toMatchObject({ name: 'database', alias: '数据库', unique_key: 'db_name' });
  });
});

describe('deleting', () => {
  it('asks first and says what the cascade removes', async () => {
    const user = userEvent.setup();
    let deleted = 0;
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: models, total: models.length })),
      http.delete('/api/v1/cmdb/ci-types/:id', () => {
        deleted += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: '删除 host' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/已存的值都会一起删除/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(deleted).toBe(0);

    await user.click(screen.getByRole('button', { name: '删除 host' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '确认' }));
    await waitFor(() => expect(deleted).toBe(1));
  });
});
