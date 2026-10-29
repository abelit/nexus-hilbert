import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/test/msw-server';
import { selectOption } from '@/test/select-option';
import { useAuth } from '@/store/auth';
import TopologyViewsPage from './TopologyViews';
import { ToastProvider } from '../components/Toast';

// The shared graph is replaced by a label list: this file tests the page's
// data flow, not React Flow's canvas.
vi.mock('@/components/topology/Graph', () => ({
  TopologyGraph: ({
    nodes,
    onSelect,
  }: {
    nodes: Array<{ id: number; name: string; props?: Record<string, unknown> }>;
    onSelect(node: unknown): void;
  }) => (
    <div data-testid="topo-graph">
      {nodes.map((node) => (
        <button key={node.id} type="button" onClick={() => onSelect(node)}>
          {node.name}
        </button>
      ))}
    </div>
  ),
}));

const host = {
  id: 1, name: 'host', alias: '主机', enabled: true, is_attached: true,
  icon: '', order: 0, unique_key: 'hostname', parent_ids: [],
};

const view = {
  id: 7,
  name: '机房拓扑',
  group_id: 1,
  central_node_type: 1,
  central_node_instances: 'hostname:web*',
  path: { '1': [2] },
  order: 1,
};

const group = { id: 1, name: '网络', order: 1, views: [view] };

const hostnameAttribute = {
  id: 5,
  name: 'hostname',
  alias: '主机名',
  value_type: '2',
  is_list: false,
  is_index: true,
  is_indexed: true,
  is_required: false,
  order: 5,
  default_show: true,
  inherited: false,
  is_password: false,
  is_reference: false,
  storage_table: 'c_value_index_texts',
};

function baseHandlers() {
  server.use(
    http.get('/cmdb/cmdb-icons.json', () => HttpResponse.json({})),
    http.get('/api/v1/cmdb/topology-views/groups', () =>
      HttpResponse.json({ items: [group], total: 1 }),
    ),
    http.get('/api/v1/cmdb/topology-views', () =>
      HttpResponse.json({ items: [view], total: 1 }),
    ),
    http.get('/api/v1/cmdb/topology-views/7/graph', () =>
      HttpResponse.json({
        nodes: [{ id: 100, type_id: 1, name: 'web-01' }],
        links: [],
        type2meta: { '1': 'icon-host' },
      }),
    ),
    http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [host], total: 1 })),
  );
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <TopologyViewsPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  useAuth.setState({ token: null, role: 'admin' });
});

describe('the topology views page', () => {
  it('lists a saved view and draws its graph', async () => {
    baseHandlers();
    renderPage();

    expect(await screen.findByRole('heading', { name: '拓扑视图' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '查看拓扑视图 机房拓扑' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拖动分组 网络' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拖动视图 机房拓扑' })).toBeInTheDocument();
    expect(await screen.findByTestId('topo-graph')).toHaveTextContent('web-01');
    expect(screen.getByText('1 个节点，0 条边')).toBeInTheDocument();
  });

  it('filters the rail and offers a working clear action', async () => {
    const user = userEvent.setup();
    baseHandlers();
    renderPage();

    await screen.findByRole('button', { name: '查看拓扑视图 机房拓扑' });
    await user.type(screen.getByRole('searchbox', { name: '搜索拓扑视图' }), '不存在');
    expect(screen.queryByRole('button', { name: '查看拓扑视图 机房拓扑' })).not.toBeInTheDocument();
    expect(screen.getByText('没有匹配的视图')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '清除搜索' }));
    expect(await screen.findByRole('button', { name: '查看拓扑视图 机房拓扑' })).toBeInTheDocument();
  });

  it('renames a group from its header', async () => {
    const user = userEvent.setup();
    let put: unknown = null;
    baseHandlers();
    server.use(
      http.put('/api/v1/cmdb/topology-views/groups/1', async ({ request }) => {
        put = await request.json();
        return HttpResponse.json({ ...group, name: '新网络' });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: '编辑分组 网络' }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('分组名称');
    await user.clear(name);
    await user.type(name, '新网络');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(put).toEqual({ name: '新网络', view_ids: [7] }));
  });

  it('edits a view from the rail, not only from the canvas header', async () => {
    const user = userEvent.setup();
    baseHandlers();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '编辑视图 机房拓扑' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('名称')).toHaveValue('机房拓扑');
  });

  it('shows subscribed attributes when a graph node is picked', async () => {
    const user = userEvent.setup();
    baseHandlers();
    server.use(
      http.get('/api/v1/cmdb/ci-types/host/attributes', () =>
        HttpResponse.json({
          type_id: 1,
          unique_id: 5,
          unique: 'hostname',
          attributes: [hostnameAttribute],
        }),
      ),
      http.get('/api/v1/cmdb/preferences/ci-types/host/fields', () =>
        HttpResponse.json({
          type_id: 1,
          is_subscribed: true,
          fields: [{ attr_id: 5, is_fixed: false }],
        }),
      ),
      http.get('/api/v1/cmdb/instances/100', () =>
        HttpResponse.json({
          ci_id: 100,
          type_id: 1,
          values: { hostname: 'host-a', note: 'hello' },
        }),
      ),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'web-01' }));
    const card = await screen.findByRole('complementary', { name: '节点详情' });
    expect(within(card).getByText('主机名')).toBeInTheDocument();
    expect(within(card).getByText('host-a')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: '在资源数据中查看' })).toBeInTheDocument();
  });

  it('does not leave the previous graph on screen when the next view fails', async () => {
    const broken = { ...view, id: 8, name: '故障视图' };
    const groupBoth = { ...group, views: [view, broken] };
    server.use(
      http.get('/api/v1/cmdb/topology-views/groups', () =>
        HttpResponse.json({ items: [groupBoth], total: 1 }),
      ),
      http.get('/api/v1/cmdb/topology-views', () =>
        HttpResponse.json({ items: [view, broken], total: 2 }),
      ),
      http.get('/api/v1/cmdb/topology-views/7/graph', () =>
        HttpResponse.json({
          nodes: [{ id: 100, type_id: 1, name: 'web-01' }],
          links: [],
          type2meta: {},
        }),
      ),
      http.get('/api/v1/cmdb/topology-views/8/graph', () =>
        HttpResponse.json({ error: 'too large' }, { status: 400 }),
      ),
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [host], total: 1 })),
    );
    renderPage();

    expect(await screen.findByTestId('topo-graph')).toHaveTextContent('web-01');
    await userEvent.click(screen.getByRole('button', { name: '查看拓扑视图 故障视图' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByTestId('topo-graph')).not.toBeInTheDocument();
  });

  it('creates a view and sends its path', async () => {
    let posted: unknown;
    baseHandlers();
    server.use(
      http.post('/api/v1/cmdb/topology-views', async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ ...view, id: 8, name: '新拓扑' }, { status: 201 });
      }),
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: '新建视图' }));
    await userEvent.type(screen.getByLabelText('名称'), '新拓扑');
    await selectOption(screen.getByLabelText('中心模型'), '主机');
    const path = screen.getByLabelText('路径 JSON');
    await userEvent.clear(path);
    await userEvent.click(path);
    await userEvent.paste('{"1":[2]}');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(posted).toEqual(
        expect.objectContaining({
          name: '新拓扑',
          central_node_type: 1,
          path: { '1': [2] },
        }),
      ),
    );
  });

  it('previews a view without saving it', async () => {
    let posted: unknown;
    baseHandlers();
    server.use(
      http.post('/api/v1/cmdb/topology-views/preview', async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({
          nodes: [{ id: 100, type_id: 1, name: 'web-01' }],
          links: [],
          type2meta: {},
        });
      }),
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: '新建视图' }));
    await userEvent.type(screen.getByLabelText('名称'), '预览视图');
    await selectOption(screen.getByLabelText('中心模型'), '主机');
    await userEvent.click(screen.getByRole('button', { name: '预览' }));

    expect(await screen.findByText('预览：1 个节点，0 条边')).toBeInTheDocument();
    expect(posted).toEqual(expect.objectContaining({ name: '预览视图', central_node_type: 1 }));
  });

  it('disables writes for a non-admin', async () => {
    useAuth.setState({ token: null, role: 'user' });
    baseHandlers();
    renderPage();

    await screen.findByRole('button', { name: '查看拓扑视图 机房拓扑' });
    expect(screen.getByRole('button', { name: '新建视图' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '编辑拓扑视图' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除拓扑视图' })).toBeDisabled();
  });
});
