import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { server } from '@/test/msw-server';
import { selectOption } from '@/test/select-option';
import { useAuth } from '@/store/auth';
import ModelDetailPage from './ModelDetail';
import { ToastProvider } from '../components/Toast';

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

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  useAuth.setState({ token: null, role: 'admin' });
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
    expect(screen.getByText('1-N')).toBeInTheDocument();
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
    expect(screen.getByText('1-1')).toBeInTheDocument();

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
    await selectOption(screen.getByLabelText('基数'), '1-1');
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
    await user.click(screen.getByRole('button', { name: '添加映射' }));
    await selectOption(screen.getByLabelText('父属性'), '主机名（hostname）');
    await selectOption(screen.getByLabelText('子属性'), '序列号（sn）');
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
  it('links to the discovery configuration and the pool', async () => {
    baseHandlers();
    renderPage();

    await userEvent.click(await screen.findByRole('tab', { name: '自动发现' }));
    expect(await screen.findByRole('link', { name: '打开自动发现配置' })).toHaveAttribute('href', '/cmdb/discovery');
    expect(screen.getByRole('link', { name: '打开发现池' })).toHaveAttribute('href', '/cmdb/adc');
  });
});
