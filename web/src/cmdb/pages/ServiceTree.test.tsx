import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/test/msw-server';
import { useAuth } from '@/store/auth';
import ServiceTreePage from './ServiceTree';
import { ToastProvider } from '../components/Toast';

// React Flow is a canvas; this file tests the page's data flow, the definition
// rail and the selection that becomes the saved pairs.
vi.mock('../components/service-tree/RelationGraph', () => ({
  RelationGraph: ({
    graph,
    editMode,
    selectedNodes,
    highlightedNodes,
    onToggleNode,
    onOpenNode,
  }: {
    graph: { nodes: Array<{ id: number; label: string }> };
    editMode: boolean;
    selectedNodes: Set<number>;
    highlightedNodes: Set<number>;
    onToggleNode(id: number): void;
    onOpenNode(id: number): void;
  }) => (
    <div data-testid="relation-graph" data-edit={editMode ? '1' : '0'}>
      <span data-testid="highlighted">{[...highlightedNodes].join(',')}</span>
      {graph.nodes.map((node) => (
        <button
          key={node.id}
          type="button"
          aria-pressed={selectedNodes.has(node.id)}
          onClick={() => (editMode ? onToggleNode(node.id) : onOpenNode(node.id))}
        >
          {node.label}
        </button>
      ))}
    </div>
  ),
}));

const model = (id: number, name: string, alias: string) => ({
  id,
  name,
  alias,
  enabled: true,
  is_attached: true,
  icon: '',
  order: 0,
  unique_key: 'name',
  parent_ids: [],
});

const models = [model(1, 'idc', '机房'), model(2, 'rack', '机柜'), model(3, 'host', '主机')];

const attribute = (id: number, name: string, alias: string, value_type: string) => ({
  id,
  name,
  alias,
  value_type,
  is_choice: false,
  is_list: false,
  is_unique: false,
  is_index: value_type === '2',
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
  is_required: false,
  order: id,
  default_show: true,
  inherited: false,
  is_indexed: value_type === '2',
  storage_table: value_type === '2' ? 'c_value_index_texts' : 'c_value_integers',
});

const hostAttributes = [
  attribute(10, 'hostname', '主机名', '2'),
  attribute(11, 'cpu', 'CPU', '0'),
];

const relation = (parent: number, child: number) => {
  const related = (row: ReturnType<typeof model>) => ({
    ctr_id: 1,
    type: row,
    attributes: [],
    relation_type: { id: 1, name: '包含', color: '' },
    constraint: '1-N',
    parent_attr_ids: [],
    child_attr_ids: [],
  });
  return { id: parent * 10 + child, parent: related(models[parent - 1]), child: related(models[child - 1]) };
};

const relations = [relation(1, 2), relation(2, 3)];

const tree = {
  id: 5,
  name: '机房树',
  is_public: true,
  cr_ids: [
    { parent_id: 1, child_id: 2 },
    { parent_id: 2, child_id: 3 },
  ],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/cmdb/service-tree']}>
      <ToastProvider>
        <ServiceTreePage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

function baseHandlers() {
  server.use(
    http.get('/cmdb/cmdb-icons.json', () => HttpResponse.json({})),
    http.get('/api/v1/cmdb/preferences/service-trees', () =>
      HttpResponse.json({ items: [tree], total: 1 }),
    ),
    http.get('/api/v1/cmdb/ci-types', () =>
      HttpResponse.json({ items: models, total: models.length }),
    ),
    http.get('/api/v1/cmdb/ci-type-relations', () =>
      HttpResponse.json({ items: relations, total: relations.length }),
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  useAuth.setState({ token: null, role: 'admin' });
});

describe('the model relation canvas', () => {
  it('draws the related models and highlights the saved definition', async () => {
    baseHandlers();
    renderPage();

    const graph = await screen.findByTestId('relation-graph');
    expect(within(graph).getByRole('button', { name: '机房' })).toBeInTheDocument();
    expect(within(graph).getByRole('button', { name: '机柜' })).toBeInTheDocument();
    expect(within(graph).getByRole('button', { name: '主机' })).toBeInTheDocument();
    expect((await screen.findAllByText('机房树')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '查看定义 机房树' })).toBeInTheDocument();
    expect(screen.getByTestId('highlighted')).toHaveTextContent('1,2,3');
  });

  it('previews a model node and jumps to resources or model configuration', async () => {
    const user = userEvent.setup();
    baseHandlers();
    server.use(
      http.get('/api/v1/cmdb/ci-types/host/attributes', () =>
        HttpResponse.json({ type_id: 3, unique_id: 10, unique: 'hostname', attributes: hostAttributes }),
      ),
    );

    const renderWithRoutes = () =>
      render(
        <MemoryRouter initialEntries={['/cmdb/service-tree']}>
          <ToastProvider>
            <Routes>
              <Route path="/cmdb/service-tree" element={<ServiceTreePage />} />
              <Route path="/cmdb/instances" element={<div data-testid="resources-route" />} />
              <Route path="/cmdb/models/:id" element={<div data-testid="model-route" />} />
            </Routes>
          </ToastProvider>
        </MemoryRouter>,
      );

    const first = renderWithRoutes();
    let graph = await screen.findByTestId('relation-graph');
    await user.click(within(graph).getByRole('button', { name: '主机' }));
    let card = await screen.findByRole('complementary', { name: '模型详情' });
    expect(within(card).getByText('主机')).toBeInTheDocument();
    expect(await within(card).findByText('主机名')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: /资源数据/ }));
    expect(await screen.findByTestId('resources-route')).toBeInTheDocument();
    first.unmount();

    const second = renderWithRoutes();
    graph = await screen.findByTestId('relation-graph');
    await user.click(within(graph).getByRole('button', { name: '主机' }));
    card = await screen.findByRole('complementary', { name: '模型详情' });
    await user.click(within(card).getByRole('button', { name: /模型配置/ }));
    expect(await screen.findByTestId('model-route')).toBeInTheDocument();
    second.unmount();
  });

  it('clears the definition highlight to show every model', async () => {
    const user = userEvent.setup();
    baseHandlers();
    renderPage();

    await screen.findByTestId('relation-graph');
    expect(screen.getByTestId('highlighted')).toHaveTextContent('1,2,3');
    await user.click(screen.getByRole('button', { name: '显示全部模型' }));
    expect(screen.getByTestId('highlighted')).toHaveTextContent('');
  });

  it('switches layouts without losing the definition', async () => {
    const user = userEvent.setup();
    baseHandlers();
    renderPage();

    await screen.findByTestId('relation-graph');
    const radial = screen.getByRole('button', { name: '径向' });
    await user.click(radial);
    expect(radial).toHaveAttribute('aria-pressed', 'true');
    const mindmap = screen.getByRole('button', { name: '思维导图' });
    await user.click(mindmap);
    expect(mindmap).toHaveAttribute('aria-pressed', 'true');
    expect(radial).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '重置布局' })).toBeInTheDocument();
    expect(screen.getAllByText('机房树').length).toBeGreaterThan(0);
  });

  it('filters the definition rail', async () => {
    const user = userEvent.setup();
    baseHandlers();
    renderPage();

    await screen.findByRole('button', { name: '查看定义 机房树' });
    await user.type(screen.getByRole('searchbox', { name: '搜索服务树定义' }), '不存在');
    expect(screen.queryByRole('button', { name: '查看定义 机房树' })).not.toBeInTheDocument();
    expect(screen.getByText('没有匹配的定义')).toBeInTheDocument();
  });

  it('explains that model relations come first when the graph is empty', async () => {
    server.use(
      http.get('/api/v1/cmdb/preferences/service-trees', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: models, total: models.length })),
      http.get('/api/v1/cmdb/ci-type-relations', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/cmdb/cmdb-icons.json', () => HttpResponse.json({})),
    );
    renderPage();

    expect(await screen.findByText('还没有模型关系')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去模型关系' })).toBeInTheDocument();
  });
});

describe('editing a definition on the canvas', () => {
  it('creates a definition from selected models', async () => {
    const user = userEvent.setup();
    baseHandlers();
    let posted: unknown = null;
    server.use(
      http.post('/api/v1/cmdb/preferences/service-trees', async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ id: 8, name: '新树', is_public: false, cr_ids: [] }, { status: 201 });
      }),
    );
    renderPage();

    const graph = await screen.findByTestId('relation-graph');
    await user.click(screen.getAllByRole('button', { name: '新建定义' })[0]);
    expect(graph).toHaveAttribute('data-edit', '1');

    await user.click(within(graph).getByRole('button', { name: '机房' }));
    await user.click(within(graph).getByRole('button', { name: '机柜' }));
    await user.click(within(graph).getByRole('button', { name: '主机' }));
    await user.click(screen.getByRole('button', { name: '保存' }));

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('名称'), '新树');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(posted).toEqual({
        name: '新树',
        cr_ids: [
          { parent_id: 1, child_id: 2 },
          { parent_id: 2, child_id: 3 },
        ],
        is_public: false,
      }),
    );
  });

  it('preselects the existing chain and saves an edit', async () => {
    const user = userEvent.setup();
    baseHandlers();
    let put: unknown = null;
    server.use(
      http.put('/api/v1/cmdb/preferences/service-trees/5', async ({ request }) => {
        put = await request.json();
        return HttpResponse.json({ ...tree, name: '机房树 v2' });
      }),
    );
    renderPage();

    const graph = await screen.findByTestId('relation-graph');
    await user.click(await screen.findByRole('button', { name: '编辑定义 机房树' }));
    expect(graph).toHaveAttribute('data-edit', '1');
    for (const label of ['机房', '机柜', '主机']) {
      expect(within(graph).getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
    }

    await user.click(screen.getByRole('button', { name: '保存' }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('名称');
    await user.clear(name);
    await user.type(name, '机房树 v2');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(put).toEqual({
        name: '机房树 v2',
        cr_ids: [
          { parent_id: 1, child_id: 2 },
          { parent_id: 2, child_id: 3 },
        ],
        is_public: true,
      }),
    );
  });

  it('repairs a stale definition in the exact-pair editor', async () => {
    const user = userEvent.setup();
    baseHandlers();
    let put: unknown = null;
    server.use(
      http.get('/api/v1/cmdb/preferences/service-trees', () =>
        HttpResponse.json({
          items: [
            {
              id: 9,
              name: '旧定义',
              is_public: false,
              cr_ids: [{ parent_id: 8, child_id: 9 }],
            },
          ],
          total: 1,
        }),
      ),
      http.put('/api/v1/cmdb/preferences/service-trees/9', async ({ request }) => {
        put = await request.json();
        return HttpResponse.json({ id: 9, name: '旧定义', is_public: false, cr_ids: [{ parent_id: 1, child_id: 2 }] });
      }),
    );
    renderPage();

    expect(await screen.findByText('包含已失效的模型关系')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '编辑定义 旧定义' }));
    // A stale pair cannot be derived from the canvas, so the page opens the
    // exact editor instead of silently dropping it.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/1 对模型关系已失效/)).toBeInTheDocument();
    expect(screen.getByTestId('relation-graph')).toHaveAttribute('data-edit', '0');

    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('至少保留一对有效的模型关系');
    expect(put).toBeNull();

    // Keeping only live pairs repairs the definition in place.
    await user.click(within(dialog).getByText('机房 → 机柜'));
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(put).toEqual({
        name: '旧定义',
        is_public: false,
        cr_ids: [{ parent_id: 1, child_id: 2 }],
      }),
    );
  });

  it('edits individual pairs from a definition card', async () => {
    const user = userEvent.setup();
    baseHandlers();
    let put: unknown = null;
    server.use(
      http.put('/api/v1/cmdb/preferences/service-trees/5', async ({ request }) => {
        put = await request.json();
        return HttpResponse.json({ ...tree, cr_ids: [{ parent_id: 1, child_id: 2 }] });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: '精确编辑定义 机房树' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('机房 → 机柜')).toBeInTheDocument();
    await user.click(within(dialog).getByText('机柜 → 主机'));
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(put).toEqual({
        name: '机房树',
        is_public: true,
        cr_ids: [{ parent_id: 1, child_id: 2 }],
      }),
    );
  });

  it('can create a definition from the exact-pair editor', async () => {
    const user = userEvent.setup();
    baseHandlers();
    let posted: unknown = null;
    server.use(
      http.post('/api/v1/cmdb/preferences/service-trees', async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ id: 8, name: '精确树', is_public: false, cr_ids: [] }, { status: 201 });
      }),
    );
    renderPage();

    const graph = await screen.findByTestId('relation-graph');
    await user.click(screen.getAllByRole('button', { name: '新建定义' })[0]);
    expect(graph).toHaveAttribute('data-edit', '1');
    await user.click(screen.getByRole('button', { name: '精确模型对' }));

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('名称'), '精确树');
    await user.click(within(dialog).getByText('机房 → 机柜'));
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(posted).toEqual({
        name: '精确树',
        is_public: false,
        cr_ids: [{ parent_id: 1, child_id: 2 }],
      }),
    );
  });

  it('deletes a definition after confirmation', async () => {
    const user = userEvent.setup();
    baseHandlers();
    let deleted = false;
    server.use(
      http.delete('/api/v1/cmdb/preferences/service-trees/5', () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: '删除定义 机房树' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '确认' }));
    await waitFor(() => expect(deleted).toBe(true));
  });
});

describe('permissions', () => {
  it('does not offer writes to a non-administrator', async () => {
    useAuth.setState({ token: null, role: 'user' });
    baseHandlers();
    renderPage();

    await screen.findByTestId('relation-graph');
    expect(screen.getByRole('button', { name: '新建定义' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '编辑定义 机房树' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '精确编辑定义 机房树' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除定义 机房树' })).not.toBeInTheDocument();
  });
});
