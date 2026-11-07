import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/test/msw-server';
import { selectOption } from '@/test/select-option';
import { useAuth } from '@/store/auth';
import ModelDetailPage from './ModelDetail';
import { ToastProvider } from '../components/Toast';

// THE CANVAS IS REPLACED BY ITS INPUTS. React Flow measures nodes in a layout
// engine jsdom does not run, so the page test checks that the tab hands the
// graph the right center, relations and groups; the canvas itself has its own
// tests.
vi.mock('../components/model-relations/ModelRelationsTopology', () => ({
  ModelRelationsTopology: ({
    center,
    parents,
    children,
    groups,
  }: {
    center: { alias: string };
    parents: Array<{ type: { alias: string } }>;
    children: Array<{ type: { alias: string } }>;
    groups: unknown[];
  }) => (
    <div data-testid="model-topology">
      <span data-testid="topology-center">{center.alias}</span>
      <span data-testid="topology-parents">{parents.map((row) => row.type.alias).join(',')}</span>
      <span data-testid="topology-children">{children.map((row) => row.type.alias).join(',')}</span>
      <span data-testid="topology-groups">{groups.length}</span>
    </div>
  ),
}));

const model = {
  id: 1,
  name: 'host',
  alias: '主机',
  enabled: true,
  is_attached: true,
  icon: '',
  order: 0,
  unique_key: 'hostname',
  parent_ids: [],
};

const disk = { ...model, id: 2, name: 'disk', alias: '磁盘', unique_key: 'sn' };

const childRelation = {
  ctr_id: 7,
  type: { ...model, id: 2, name: 'disk', alias: '磁盘', unique_key: 'sn' },
  show_key: 'name',
  attributes: [],
  relation_type: { id: 1, name: '包含', color: '#6366f1' },
  constraint: '0',
  parent_attr_ids: [],
  child_attr_ids: [],
};

const parentRelation = {
  ctr_id: 88,
  type: { ...model, id: 3, name: 'rack', alias: '机柜', unique_key: 'name' },
  show_key: 'name',
  attributes: [],
  relation_type: { id: 2, name: '属于', color: '#f59e0b' },
  constraint: '1',
  parent_attr_ids: [],
  child_attr_ids: [],
};

const ownAttribute = {
  id: 10,
  name: 'hostname',
  alias: '主机名',
  value_type: '2',
  is_list: false,
  is_index: true,
  is_indexed: true,
  inherited: false,
  is_required: true,
  order: 0,
  default_show: true,
  storage_table: 'c_value_index_texts',
};

// AN INHERITED ATTRIBUTE IS NOT BOUND ON THIS MODEL, so it cannot be unbound
// here — the flag and its source are what the page has to show.
const inheritedAttribute = {
  ...ownAttribute,
  id: 20,
  name: 'serial',
  alias: '序列号',
  inherited: true,
  inherited_from: '资产',
  is_required: false,
};

function renderPage(path = '/cmdb/models/1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/cmdb/models/:id"
          element={
            <ToastProvider>
              <ModelDetailPage />
            </ToastProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

function baseHandlers() {
  server.use(
    http.get('/api/v1/cmdb/ci-types/1', () => HttpResponse.json(model)),
    http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [model, disk], total: 2 })),
    http.get('/api/v1/cmdb/preferences/model-groups', () =>
      HttpResponse.json({ items: [{ id: 1, name: '资产', ci_types: [model, disk] }], total: 1 }),
    ),
    http.get('/api/v1/cmdb/ci-types/1/attributes', () =>
      HttpResponse.json({
        type_id: 1,
        unique_id: 10,
        unique: 'hostname',
        attributes: [ownAttribute, inheritedAttribute],
      }),
    ),
    http.get('/api/v1/cmdb/ci-types/1/attribute-groups', () => HttpResponse.json([])),
  );
}

function relationHandlers() {
  server.use(
    http.get('/api/v1/cmdb/ci-types/1/relation-children', () =>
      HttpResponse.json({ items: [childRelation], total: 1 }),
    ),
    http.get('/api/v1/cmdb/ci-types/1/relation-parents', () =>
      HttpResponse.json({ items: [parentRelation], total: 1 }),
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  useAuth.setState({ token: null, role: 'admin' });
});

describe('the workspace bar', () => {
  it('keeps the model heading in the breadcrumb and the actions on the bar', async () => {
    baseHandlers();
    renderPage();

    const bar = await screen.findByRole('banner');
    expect(within(bar).getByText('CMDB 资源管理平台')).toBeInTheDocument();
    expect(within(bar).getByRole('heading', { level: 1, name: '主机' })).toBeInTheDocument();
    expect(within(bar).getByRole('link', { name: '模型配置' })).toHaveAttribute('href', '/cmdb/models');
    expect(within(bar).getByRole('button', { name: '模型定义' })).toBeInTheDocument();
  });
});

describe('the attribute tab', () => {
  it('shows the effective set and where an inherited attribute comes from', async () => {
    baseHandlers();
    renderPage();

    expect(await screen.findByText('主机名')).toBeInTheDocument();
    expect(screen.getByText('序列号')).toBeInTheDocument();
    expect(screen.getByText('继承自 资产')).toBeInTheDocument();
  });

  it('groups attributes into their form sections and filters them', async () => {
    const user = userEvent.setup();
    baseHandlers();
    server.use(
      http.get('/api/v1/cmdb/ci-types/1/attribute-groups', () =>
        HttpResponse.json([
          {
            id: 5,
            name: '基本信息',
            type_id: 1,
            order: 0,
            inherited: false,
            is_other: false,
            attributes: [{ ...ownAttribute }],
          },
          {
            id: 0,
            name: '',
            type_id: 1,
            order: 0,
            inherited: false,
            is_other: true,
            attributes: [{ ...inheritedAttribute }],
          },
        ]),
      ),
    );
    renderPage();

    expect(await screen.findByRole('heading', { name: '基本信息' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '其他' })).toBeInTheDocument();
    expect(screen.getByText('2 个属性')).toBeInTheDocument();

    await user.type(screen.getByLabelText('搜索属性'), 'serial');
    expect(screen.queryByText('主机名')).not.toBeInTheDocument();
    expect(screen.getByText('序列号')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '基本信息' })).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('搜索属性'));
    await user.click(screen.getByRole('checkbox', { name: '只看继承' }));
    expect(screen.queryByText('主机名')).not.toBeInTheDocument();
    expect(screen.getByText('序列号')).toBeInTheDocument();
  });

  it('shows only the types in use and exposes the rest through more types', async () => {
    const user = userEvent.setup();
    baseHandlers();
    renderPage();

    await screen.findByText('主机名');
    expect(screen.getByRole('button', { name: '短文本' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '整数' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '更多类型' }));
    await user.click(screen.getByRole('checkbox', { name: '筛选整数' }));
    expect(screen.getByRole('button', { name: '整数' })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByText('没有匹配的属性')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await user.click(screen.getAllByRole('button', { name: '清除筛选' })[0]);
    expect(within(await screen.findByRole('table')).getByText('主机名')).toBeInTheDocument();
  });

  it('switches between the table and grid views and filters required attributes', async () => {
    const user = userEvent.setup();
    baseHandlers();
    renderPage();

    expect(await screen.findByRole('table')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '网格' }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '主机名' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '列表' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: '只看必填属性' }));
    expect(screen.getByText('主机名')).toBeInTheDocument();
    expect(screen.queryByText('序列号')).not.toBeInTheDocument();
  });

  it('filters by the effective data type, alone and together with another type', async () => {
    const user = userEvent.setup();
    baseHandlers();
    server.use(
      http.get('/api/v1/cmdb/ci-types/1/attributes', () =>
        HttpResponse.json({
          type_id: 1,
          unique_id: 10,
          unique: 'hostname',
          attributes: [
            { ...ownAttribute, is_index: true },
            { ...ownAttribute, id: 30, name: 'cpu', alias: '核数', value_type: '0', is_required: false },
            {
              ...ownAttribute,
              id: 40,
              name: 'root_password',
              alias: '根密码',
              value_type: '2',
              is_index: false,
              is_password: true,
              is_required: false,
            },
          ],
        }),
      ),
    );
    renderPage();

    await screen.findByText('主机名');
    const integerFilter = screen.getByRole('button', { name: '整数' });
    expect(integerFilter).toHaveAttribute('aria-pressed', 'false');

    await user.click(integerFilter);
    expect(integerFilter).toHaveAttribute('aria-pressed', 'true');
    const table = screen.getByRole('table');
    expect(within(table).getByText('核数')).toBeInTheDocument();
    expect(within(table).queryByText('主机名')).not.toBeInTheDocument();
    expect(within(table).queryByText('根密码')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '短文本' }));
    expect(within(table).getByText('主机名')).toBeInTheDocument();
    expect(within(table).getByText('核数')).toBeInTheDocument();
    expect(within(table).queryByText('根密码')).not.toBeInTheDocument();

    await user.click(integerFilter);
    expect(within(table).getByText('主机名')).toBeInTheDocument();
    expect(within(table).queryByText('核数')).not.toBeInTheDocument();
    expect(within(table).queryByText('根密码')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '密码' }));
    expect(within(table).getByText('主机名')).toBeInTheDocument();
    expect(within(table).getByText('根密码')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(within(table).getByText('主机名')).toBeInTheDocument();
    expect(within(table).getByText('核数')).toBeInTheDocument();
    expect(within(table).getByText('根密码')).toBeInTheDocument();
  });

  it('shows the effective type icon and its flags in both list and grid views', async () => {
    const user = userEvent.setup();
    baseHandlers();
    server.use(
      http.get('/api/v1/cmdb/ci-types/1/attributes', () =>
        HttpResponse.json({
          type_id: 1,
          unique_id: 10,
          unique: 'hostname',
          attributes: [
            { ...ownAttribute, is_index: true, is_unique: true },
            {
              ...ownAttribute,
              id: 40,
              name: 'root_password',
              alias: '根密码',
              value_type: '2',
              is_index: false,
              is_password: true,
              is_required: true,
              is_unique: true,
            },
          ],
        }),
      ),
    );
    renderPage();

    const table = await screen.findByRole('table');
    expect(within(table).getByText('短文本')).toBeInTheDocument();
    expect(within(table).getByText('密码')).toBeInTheDocument();
    expect(table.querySelector('[data-attribute-type-icon="2"]')).not.toBeNull();
    expect(table.querySelector('[data-attribute-type-icon="7"]')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: '网格' }));
    const card = screen.getByRole('heading', { name: '根密码' }).closest('article');
    expect(card).not.toBeNull();
    const cardElement = card as HTMLElement;
    expect(cardElement.querySelector('[data-attribute-type-icon="7"]')).not.toBeNull();
    expect(within(cardElement).getByText('密码')).toBeInTheDocument();
    expect(within(cardElement).getByText('唯一')).toBeInTheDocument();
    expect(within(cardElement).getByText('*')).toBeInTheDocument();
  });

  it('refuses to unbind an inherited attribute', async () => {
    baseHandlers();
    renderPage();

    await screen.findByText('序列号');
    // THE ATTRIBUTE IS BOUND ON THE PARENT, so an unbind button here would be a
    // button that cannot do what it says.
    expect(screen.getByRole('button', { name: '解绑 serial' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '解绑 hostname' })).toBeEnabled();
  });

  it('asks before unbinding, and reports how many values went with it', async () => {
    const user = userEvent.setup();
    baseHandlers();
    let unbound: unknown = null;
    server.use(
      http.delete('/api/v1/cmdb/ci-types/1/attributes', async ({ request }) => {
        unbound = await request.json();
        return HttpResponse.json({ unbound: 1, deleted_values: 42, affected_types: [1] });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: '解绑 hostname' }));
    const dialog = await screen.findByRole('dialog');
    // THE CONFIRMATION SAYS WHAT UNBINDING MEANS: the values go with it, and that
    // is not obvious from the word.
    expect(within(dialog).getByText(/实例值会一起删除/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '确认' }));

    await waitFor(() => expect(unbound).toEqual({ attr_ids: [10] }));
    // AND THE RESULT NAMES THE DATA, not just the column.
    expect(await screen.findByText('已解绑，并删除了 42 个值')).toBeInTheDocument();
  });

  it('sends a binding change rather than a dictionary change', async () => {
    const user = userEvent.setup();
    baseHandlers();
    let patch: unknown = null;
    server.use(
      http.put('/api/v1/cmdb/ci-types/1/attributes', async ({ request }) => {
        patch = await request.json();
        return HttpResponse.json({ updated: 1 });
      }),
    );
    renderPage();

    const toggle = await screen.findByRole('checkbox', { name: 'hostname 必填' });
    await user.click(toggle);
    // `is_required` IS A PROPERTY OF THE BINDING, not of the attribute — the same
    // attribute can be required on one model and optional on another — so this
    // goes to the bindings endpoint, not the dictionary.
    await waitFor(() => expect(patch).toEqual({ attributes: [{ attr_id: 10, is_required: false }] }));
  });
});

describe('the other tabs', () => {
  it('loads relations for this model', async () => {
    baseHandlers();
    server.use(
      // THE CHILDREN ENDPOINT RETURNS THE OTHER END, NOT A parent/child PAIR.
      // The global /ci-type-relations list is the only API that returns both
      // ends; using its shape here made the tab crash as soon as a model had
      // one child.
      http.get('/api/v1/cmdb/ci-types/1/relation-children', () =>
        HttpResponse.json({
          items: [
            {
              ctr_id: 7,
              type: { ...model, id: 2, name: 'disk', alias: '磁盘' },
              show_key: 'name',
              attributes: [],
              relation_type: { id: 1, name: '包含', color: '#6366f1' },
              constraint: '0',
              parent_attr_ids: [],
              child_attr_ids: [],
            },
          ],
          total: 1,
        }),
      ),
      http.get('/api/v1/cmdb/ci-types/1/relation-parents', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [model], total: 1 })),
    );
    // THE URL ITSELF OPENS THE TAB. This is the deep link the reported page
    // used, not a click that happens to select the same panel.
    renderPage('/cmdb/models/1?tab=relations');

    expect(await screen.findByRole('link', { name: '磁盘' })).toBeInTheDocument();
    expect(screen.getByText('子模型')).toBeInTheDocument();
    expect(screen.getByText('一对多')).toBeInTheDocument();
    // The relation list shares the resource table's card and density.
    const table = screen.getByRole('table');
    expect(table).toHaveClass('cmdb-instance-table');
    expect(table.parentElement).toHaveClass('cmdb-instance-table-scroll');
  });

  it('shows the empty state from the relations deep link', async () => {
    baseHandlers();
    server.use(
      http.get('/api/v1/cmdb/ci-types/1/relation-children', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/ci-types/1/relation-parents', () => HttpResponse.json({ items: [], total: 0 })),
    );
    renderPage('/cmdb/models/1?tab=relations');

    expect(await screen.findByText('这个模型还没有关系')).toBeInTheDocument();
  });

  it('shows parent relations and deletes them by the edge id', async () => {
    const user = userEvent.setup();
    baseHandlers();
    let deleted = '';
    server.use(
      http.get('/api/v1/cmdb/ci-types/1/relation-children', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/ci-types/1/relation-parents', () =>
        HttpResponse.json({
          items: [
            {
              ctr_id: 88,
              type: { ...model, id: 3, name: 'rack', alias: '机柜' },
              show_key: 'name',
              attributes: [],
              relation_type: { id: 2, name: '属于', color: '#f59e0b' },
              constraint: '1',
              parent_attr_ids: [],
              child_attr_ids: [],
            },
          ],
          total: 1,
        }),
      ),
      http.delete('/api/v1/cmdb/ci-type-relations/:id', ({ params }) => {
        deleted = String(params.id);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('tab', { name: '模型关系' }));
    expect(await screen.findByRole('link', { name: '机柜' })).toBeInTheDocument();
    expect(screen.getByText('父模型')).toBeInTheDocument();
    expect(screen.getByText('一对一')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '删除与 rack 的关系' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '确认' }));
    await waitFor(() => expect(deleted).toBe('88'));
  });

  it('creates a relation with the wire cardinality code', async () => {
    const user = userEvent.setup();
    baseHandlers();
    let posted: unknown;
    let postedPath = '';
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [model, disk], total: 2 })),
      http.get('/api/v1/cmdb/ci-types/1/relation-children', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/ci-types/1/relation-parents', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/relation-types', () =>
        HttpResponse.json({ items: [{ id: 5, name: '包含', color: '#6366f1' }], total: 1 }),
      ),
      http.post('/api/v1/cmdb/ci-types/:parent/relation-children/:child', async ({ request, params }) => {
        posted = await request.json();
        postedPath = `/api/v1/cmdb/ci-types/${params.parent}/relation-children/${params.child}`;
        return HttpResponse.json({});
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('tab', { name: '模型关系' }));
    await user.click(await screen.findByRole('button', { name: '加子模型' }));
    await selectOption(screen.getByLabelText('对端模型'), '磁盘');
    await selectOption(screen.getByLabelText('关系约束'), '一对一');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(posted).toEqual({ relation_type_id: 5, constraint: '1' }));
    expect(postedPath).toBe('/api/v1/cmdb/ci-types/1/relation-children/2');
  });

  it('sends the relation attribute mapping when one is configured', async () => {
    const user = userEvent.setup();
    baseHandlers();
    let posted: unknown;
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [model, disk], total: 2 })),
      http.get('/api/v1/cmdb/ci-types/1/relation-children', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/ci-types/1/relation-parents', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/ci-types/2/attributes', () =>
        HttpResponse.json({
          type_id: 2,
          unique_id: 30,
          unique: 'sn',
          attributes: [
            {
              ...ownAttribute,
              id: 30,
              name: 'sn',
              alias: '序列号',
              is_required: true,
            },
          ],
        }),
      ),
      http.get('/api/v1/cmdb/relation-types', () =>
        HttpResponse.json({ items: [{ id: 5, name: '包含', color: '#6366f1' }], total: 1 }),
      ),
      http.post('/api/v1/cmdb/ci-types/:parent/relation-children/:child', async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({});
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('tab', { name: '模型关系' }));
    await user.click(await screen.findByRole('button', { name: '加子模型' }));
    await selectOption(screen.getByLabelText('对端模型'), '磁盘');
    await waitFor(() => expect(screen.getByRole('combobox', { name: '源属性 1' })).toBeEnabled());
    await selectOption(screen.getByRole('combobox', { name: '源属性 1' }), '主机名（hostname）');
    await selectOption(screen.getByRole('combobox', { name: '目标属性 1' }), '序列号（sn）');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(posted).toEqual({
        relation_type_id: 5,
        constraint: '0',
        parent_attr_ids: [10],
        child_attr_ids: [30],
      }),
    );
  });

  it('marks a uniqueness rule that names a deleted attribute', async () => {
    const user = userEvent.setup();
    baseHandlers();
    server.use(
      http.get('/api/v1/cmdb/ci-types/1/unique-constraints', () =>
        HttpResponse.json({
          items: [{ id: 3, type_id: 1, attr_ids: [10, 99], attributes: [ownAttribute] }],
          total: 1,
        }),
      ),
    );
    renderPage();

    await user.click(await screen.findByRole('tab', { name: '唯一约束' }));
    // THE RESOLVED SET IS SHORTER THAN THE STORED IDS, which is the backend's
    // signal that the rule references something gone. cantor dropped those
    // silently; here the gap is visible.
    expect(await screen.findByText('1 个属性已不存在')).toBeInTheDocument();
  });
});

describe('the relation views', () => {
  it('switches between list, grid and topology', async () => {
    const user = userEvent.setup();
    baseHandlers();
    relationHandlers();
    renderPage('/cmdb/models/1?tab=relations');

    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '列表' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: '网格' }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /子模型/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /父模型/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '磁盘' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '机柜' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '拓扑' }));
    expect(screen.getByTestId('model-topology')).toBeInTheDocument();
    expect(screen.getByTestId('topology-center')).toHaveTextContent('主机');
    expect(screen.getByTestId('topology-parents')).toHaveTextContent('机柜');
    expect(screen.getByTestId('topology-children')).toHaveTextContent('磁盘');
    expect(screen.getByTestId('topology-groups')).toHaveTextContent('1');
  });

  it('shows the empty state in every view', async () => {
    const user = userEvent.setup();
    baseHandlers();
    server.use(
      http.get('/api/v1/cmdb/ci-types/1/relation-children', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/ci-types/1/relation-parents', () => HttpResponse.json({ items: [], total: 0 })),
    );
    renderPage('/cmdb/models/1?tab=relations');

    expect(await screen.findByText('这个模型还没有关系')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '网格' }));
    expect(screen.getByText('这个模型还没有关系')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '拓扑' }));
    expect(screen.getByText('这个模型还没有关系')).toBeInTheDocument();
    expect(screen.queryByTestId('model-topology')).not.toBeInTheDocument();
  });

  it('still renders the topology when the group lookup fails', async () => {
    const user = userEvent.setup();
    baseHandlers();
    relationHandlers();
    server.use(
      http.get('/api/v1/cmdb/preferences/model-groups', () => new HttpResponse(null, { status: 500 })),
    );
    renderPage('/cmdb/models/1?tab=relations');

    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: '拓扑' }));

    expect(screen.getByTestId('model-topology')).toBeInTheDocument();
    expect(screen.getByTestId('topology-groups')).toHaveTextContent('0');
  });
});

describe('the model definition', () => {
  it('opens the read-only JSON snapshot from the header', async () => {
    const user = userEvent.setup();
    baseHandlers();
    server.use(
      http.get('/api/v1/cmdb/ci-types/1/relation-children', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/ci-types/1/relation-parents', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/ci-types/1/unique-constraints', () =>
        HttpResponse.json({
          items: [{ id: 3, type_id: 1, attr_ids: [10], attributes: [ownAttribute] }],
          total: 1,
        }),
      ),
      http.get('/api/v1/cmdb/ci-types/1/triggers', () => HttpResponse.json({ items: [], total: 0 })),
    );
    renderPage();

    await screen.findByText('主机名');
    await user.click(screen.getByRole('button', { name: '模型定义' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    const json = await screen.findByLabelText('模型定义 JSON');
    expect(json).toHaveTextContent('"format": "ongrid.cmdb.model"');
    expect(json).toHaveTextContent('"hostname"');
    expect(json).toHaveTextContent('"unique_constraints"');
  });

  it('offers the definition to a non-administrator without calling admin-only reads', async () => {
    const user = userEvent.setup();
    useAuth.setState({ token: null, role: 'user' });
    baseHandlers();
    // No handlers for unique-constraints or triggers: an attempt to read them
    // would fail the test through MSW, and the UI must not depend on them.
    server.use(
      http.get('/api/v1/cmdb/ci-types/1/relation-children', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/ci-types/1/relation-parents', () => HttpResponse.json({ items: [], total: 0 })),
    );
    renderPage();

    await screen.findByText('主机名');
    const button = screen.getByRole('button', { name: '模型定义' });
    expect(button).toBeEnabled();
    await user.click(button);

    const json = await screen.findByLabelText('模型定义 JSON');
    expect(json).toHaveTextContent('"unique_constraints": null');
    expect(json).toHaveTextContent('"triggers": null');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('the auto-discovery tab', () => {
  it('opens the model-level auto-discovery editor', async () => {
    baseHandlers();
    server.use(
      http.get('/api/v1/cmdb/discovery/rules', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/discovery/ci-types/1/targets', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/discovery/ci-types/1/discoverable-attributes', () => HttpResponse.json([])),
      http.get('/api/v1/cmdb/discovery/ci-types/1/target-relations', () =>
        HttpResponse.json({ items: [], total: 0 }),
      ),
      http.get('/api/v1/cmdb/ci-types/1/relation-children', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/ci-types/1/relation-parents', () => HttpResponse.json({ items: [], total: 0 })),
    );
    renderPage();

    await userEvent.click(await screen.findByRole('tab', { name: '自动发现' }));
    expect(await screen.findByRole('tab', { name: '属性自动发现' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '关系自动发现' })).toBeInTheDocument();
    expect(await screen.findByText('还没有可用的发现规则')).toBeInTheDocument();
  });
});

type TriggerWriteBody = {
  attr_id?: number | null;
  option: {
    name?: string;
    description?: string;
    enable?: boolean;
    action?: string;
    attr_ids?: number[];
    filter?: string;
    webhooks?: Record<string, unknown>;
    notifies?: Record<string, unknown>;
  };
};

function triggerHandlers() {
  server.use(
    // A date attribute for the date-trigger case; the base fixture only has
    // text attributes.
    http.get('/api/v1/cmdb/ci-types/1/attributes', () =>
      HttpResponse.json({
        type_id: 1,
        unique_id: 10,
        unique: 'hostname',
        attributes: [
          ownAttribute,
          { ...inheritedAttribute, id: 21, name: 'expires_at', alias: '到期时间', value_type: '3', inherited: false },
        ],
      }),
    ),
    http.get('/api/v1/users', () =>
      HttpResponse.json({
        items: [
          {
            id: 7,
            email: 'ops@example.test',
            display_name: 'Ops',
            phone: '',
            role: 'admin',
            status: 'active',
            created_at: '',
            updated_at: '',
          },
        ],
        total: 1,
      }),
    ),
    http.get('/api/v1/cmdb/ci-types/1/triggers', () =>
      HttpResponse.json({
        items: [
          {
            id: 51,
            type_id: 1,
            option: {
              name: 'notify ops',
              description: 'Webhook on updates',
              enable: true,
              action: '2',
              attr_ids: [10],
              webhooks: { url: 'https://example.test/hook' },
            },
            has_webhook_authorization: true,
          },
          {
            id: 52,
            type_id: 1,
            attr_id: 21,
            option: {
              name: 'warranty reminder',
              description: '',
              enable: false,
              notifies: {
                before_days: 7,
                notify_at: '08:00',
                method: ['email'],
                tos: ['ops@example.test'],
                subject: 'Warranty',
              },
            },
            has_webhook_authorization: false,
          },
        ],
        total: 2,
      }),
    ),
  );
}

describe('the triggers tab', () => {
  it('renders the cantor-shaped list on the shared table surface', async () => {
    const user = userEvent.setup();
    baseHandlers();
    triggerHandlers();
    renderPage();

    await user.click(await screen.findByRole('tab', { name: '触发器' }));
    expect(await screen.findByText('notify ops')).toBeInTheDocument();
    expect(screen.getByText('Webhook on updates')).toBeInTheDocument();
    expect(screen.getByText('warranty reminder')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '启用 notify ops' })).toBeChecked();
    expect(screen.getByRole('switch', { name: '启用 warranty reminder' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: '编辑触发器 notify ops' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除触发器 notify ops' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '测试触发器 notify ops' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '测试触发器 warranty reminder' })).toBeDisabled();

    const table = screen.getByRole('table');
    expect(table).toHaveClass('cmdb-instance-table');
    expect(table.parentElement).toHaveClass('cmdb-instance-table-scroll');
    // Cantor stores the event as "2"; the table must read "修改", not the code.
    expect(within(table).getByText('修改')).toBeInTheDocument();
    expect(within(table).getByText('日期提醒')).toBeInTheDocument();
  });

  it('toggles a trigger from the row while carrying the rest of its option', async () => {
    const user = userEvent.setup();
    baseHandlers();
    triggerHandlers();
    let patched: TriggerWriteBody | null = null;
    server.use(
      http.put('/api/v1/cmdb/ci-types/1/triggers/51', async ({ request }) => {
        patched = (await request.json()) as TriggerWriteBody;
        return HttpResponse.json({
          id: 51,
          type_id: 1,
          option: patched.option,
          has_webhook_authorization: true,
        });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('tab', { name: '触发器' }));
    await user.click(await screen.findByRole('switch', { name: '启用 notify ops' }));

    await waitFor(() => expect(patched).not.toBeNull());
    expect(patched!.option.enable).toBe(false);
    expect(patched!.option.action).toBe('2');
    expect(patched!.option.attr_ids).toEqual([10]);
    expect(patched!.option.webhooks).toEqual({ url: 'https://example.test/hook' });
  });

  it('fires a trigger from the row and reports the delivery', async () => {
    const user = userEvent.setup();
    baseHandlers();
    triggerHandlers();
    let tested = false;
    server.use(
      http.post('/api/v1/cmdb/ci-types/1/triggers/51/test', () => {
        tested = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('tab', { name: '触发器' }));
    await user.click(await screen.findByRole('button', { name: '测试触发器 notify ops' }));

    await waitFor(() => expect(tested).toBe(true));
    expect(await screen.findByText('测试请求已发送')).toBeInTheDocument();
  });

  it('shows a trigger without an explicit enable flag as disabled', async () => {
    const user = userEvent.setup();
    baseHandlers();
    server.use(
      http.get('/api/v1/cmdb/ci-types/1/triggers', () =>
        HttpResponse.json({
          items: [
            {
              id: 53,
              type_id: 1,
              option: {
                name: 'legacy trigger',
                action: '0',
                webhooks: { url: 'https://example.test/legacy' },
              },
              has_webhook_authorization: false,
            },
          ],
          total: 1,
        }),
      ),
    );
    renderPage();

    await user.click(await screen.findByRole('tab', { name: '触发器' }));
    expect(await screen.findByRole('switch', { name: '启用 legacy trigger' })).not.toBeChecked();
  });

  it('creates a trigger with cantor event codes and update-only attribute scope', async () => {
    const user = userEvent.setup();
    baseHandlers();
    triggerHandlers();
    let posted: TriggerWriteBody | null = null;
    server.use(
      http.post('/api/v1/cmdb/ci-types/1/triggers', async ({ request }) => {
        posted = (await request.json()) as TriggerWriteBody;
        return HttpResponse.json({
          id: 99,
          type_id: 1,
          option: posted.option,
          has_webhook_authorization: false,
        });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('tab', { name: '触发器' }));
    await user.click(await screen.findByRole('button', { name: '新建触发器' }));

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('名称'), 'new hook');
    await user.click(within(dialog).getByRole('radio', { name: '实例变更' }));
    await user.click(within(dialog).getByRole('checkbox', { name: '主机名' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Webhook' }));
    await user.type(within(dialog).getByLabelText('Webhook 地址'), 'https://example.test/new');
    await user.click(within(dialog).getByRole('button', { name: '确定' }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.attr_id).toBeNull();
    expect(posted!.option).toMatchObject({
      name: 'new hook',
      description: '',
      enable: true,
      filter: '',
      action: '2',
      attr_ids: [10],
      webhooks: {
        method: 'GET',
        url: 'https://example.test/new',
        parameters: {},
        headers: {},
        body: '',
        auth_type: 'none',
        authorization: {},
      },
    });
  });

  it('preserves a data trigger event when only metadata changes', async () => {
    const user = userEvent.setup();
    baseHandlers();
    triggerHandlers();
    let patched: TriggerWriteBody | null = null;
    server.use(
      http.put('/api/v1/cmdb/ci-types/1/triggers/51', async ({ request }) => {
        patched = (await request.json()) as TriggerWriteBody;
        return HttpResponse.json({
          id: 51,
          type_id: 1,
          option: patched.option,
          has_webhook_authorization: true,
        });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('tab', { name: '触发器' }));
    await user.click(await screen.findByRole('button', { name: '编辑触发器 notify ops' }));

    const dialog = await screen.findByRole('dialog');
    const nameInput = within(dialog).getByLabelText('名称');
    await user.clear(nameInput);
    await user.type(nameInput, 'renamed ops');
    await user.click(within(dialog).getByRole('button', { name: '确定' }));

    await waitFor(() => expect(patched).not.toBeNull());
    expect(patched!.option.action).toBe('2');
    expect(patched!.option.attr_ids).toEqual([10]);
    expect(patched!.option.webhooks).toMatchObject({ url: 'https://example.test/hook' });
  });

  it('preserves an imported cantor date/notify trigger when only metadata changes', async () => {
    const user = userEvent.setup();
    baseHandlers();
    triggerHandlers();
    let patched: TriggerWriteBody | null = null;
    server.use(
      http.put('/api/v1/cmdb/ci-types/1/triggers/52', async ({ request }) => {
        patched = (await request.json()) as TriggerWriteBody;
        return HttpResponse.json({
          id: 52,
          type_id: 1,
          attr_id: 21,
          option: patched.option,
          has_webhook_authorization: false,
        });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('tab', { name: '触发器' }));
    await user.click(await screen.findByRole('button', { name: '编辑触发器 warranty reminder' }));

    const dialog = await screen.findByRole('dialog');
    const nameInput = within(dialog).getByLabelText('名称');
    await user.clear(nameInput);
    await user.type(nameInput, 'renamed reminder');
    await user.click(within(dialog).getByRole('button', { name: '确定' }));

    await waitFor(() => expect(patched).not.toBeNull());
    expect(patched!.attr_id).toBe(21);
    expect(patched!.option.name).toBe('renamed reminder');
    expect(patched!.option.notifies).toEqual({
      before_days: 7,
      notify_at: '08:00',
      method: ['email'],
      tos: ['ops@example.test'],
      subject: 'Warranty',
      body: '',
      body_html: '',
    });
    expect(patched!.option).not.toHaveProperty('webhooks');
    expect(patched!.option).not.toHaveProperty('action');
  });

  it('creates a notification trigger with recipients and content', async () => {
    const user = userEvent.setup();
    baseHandlers();
    triggerHandlers();
    let posted: TriggerWriteBody | null = null;
    server.use(
      http.post('/api/v1/cmdb/ci-types/1/triggers', async ({ request }) => {
        posted = (await request.json()) as TriggerWriteBody;
        return HttpResponse.json({
          id: 100,
          type_id: 1,
          option: posted.option,
          has_webhook_authorization: false,
        });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('tab', { name: '触发器' }));
    await user.click(await screen.findByRole('button', { name: '新建触发器' }));

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('名称'), 'notify ops');
    await user.click(within(dialog).getByRole('button', { name: '选择收件人' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Ops' }));
    await user.keyboard('{Escape}');
    expect(await within(dialog).findByText('ops@example.test')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('通知标题'), 'Instance changed');
    await user.type(within(dialog).getByLabelText('通知内容'), 'changed by trigger');
    await user.click(within(dialog).getByRole('button', { name: '确定' }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.option).toMatchObject({
      name: 'notify ops',
      enable: true,
      action: '0',
      notifies: {
        tos: ['ops@example.test'],
        subject: 'Instance changed',
        body: 'changed by trigger',
        body_html: 'changed by trigger',
        method: ['email'],
      },
    });
    expect(posted!.option).not.toHaveProperty('webhooks');
  });
});
