import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/test/msw-server';
import { useAuth } from '@/store/auth';
import InstancesPage from './Instances';
import { ToastProvider } from '../components/Toast';

// THE TOPOLOGY CANVAS IS NOT THIS TEST'S SUBJECT. The drawer tests the tabs and
// the reads that feed them; the graph and its expansion have Playwright coverage.
vi.mock('../components/instance-detail/InstanceTopology', () => ({
  InstanceTopology: ({ instanceLabel }: { instanceLabel: string }) => (
    <div data-testid="instance-topology">{instanceLabel}</div>
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

const attribute = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  alias: name,
  value_type: '2',
  is_list: false,
  is_index: true,
  is_indexed: true,
  is_required: false,
  order: id,
  default_show: true,
  inherited: false,
  is_password: false,
  is_reference: false,
  is_computed: false,
  storage_table: 'c_value_index_texts',
  ...extra,
});

const attributes = [
  attribute(10, 'hostname'),
  attribute(11, 'note'),
  attribute(12, 'root_password', { is_password: true }),
];

const switchModel = { ...model, id: 2, name: 'switch', alias: '交换机' };
const databaseModel = { ...model, id: 3, name: 'database', alias: '数据库', order: 2 };

function renderPage(path = '/cmdb/instances?type=host') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <InstancesPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

function handlers(instances: unknown[] = []) {
  server.use(
    http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [model], total: 1 })),
    http.get('/api/v1/cmdb/ci-types/host/attributes', () =>
      HttpResponse.json({ type_id: 1, unique_id: 10, unique: 'hostname', attributes }),
    ),
    http.get('/api/v1/cmdb/ci-types/host/attribute-groups', () => HttpResponse.json([])),
    // The rail loads groups beside the models; an empty set keeps older tests
    // on the flat list.
    http.get('/api/v1/cmdb/preferences/model-groups', () => HttpResponse.json({ items: [], total: 0 })),
    // The rail reads the operator's own order (c_pcto). The default is empty,
    // which keeps the older tests on the catalogue order.
    http.get('/api/v1/cmdb/preferences/ci-types', () =>
      HttpResponse.json({ groups: [], type_ids: [] }),
    ),
    http.get('/api/v1/cmdb/preferences/ci-types/host/fields', () =>
      HttpResponse.json({
        type_id: 1,
        is_subscribed: true,
        // THE SUBSCRIPTION DECIDES THE COLUMNS: `note` is subscribed, and the
        // password is not.
        fields: [
          { attr_id: 10, is_fixed: true },
          { attr_id: 11, is_fixed: false },
        ],
      }),
    ),
    http.get('/api/v1/cmdb/ci-types/host/instances', () =>
      HttpResponse.json({ type_id: 1, items: instances, total: instances.length, numfound: instances.length, page: 1 }),
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  useAuth.setState({ token: null, role: 'admin' });
});

describe('the list', () => {
  it('offers an export of the current query and the current page', async () => {
    handlers([{ ci_id: 5, type_id: 1, values: { hostname: 'web-01', note: 'hello' } }]);
    renderPage();

    await screen.findByText('web-01');
    expect(await screen.findByRole('button', { name: '导出' })).toBeInTheDocument();
  });

  it('selects rows with the row and page checkboxes, and offers that selection to export', async () => {
    const user = userEvent.setup();
    handlers([
      { ci_id: 5, type_id: 1, values: { hostname: 'web-01', note: 'hello' } },
      { ci_id: 6, type_id: 1, values: { hostname: 'web-02', note: 'world' } },
    ]);
    renderPage();

    await screen.findByText('web-01');
    const rowBoxes = screen.getAllByRole('checkbox', { name: '选择这一行' });
    await user.click(rowBoxes[0]);
    expect(await screen.findByText('已选 1 项')).toBeInTheDocument();

    // The header checkbox extends the selection to the rows on this page.
    await user.click(screen.getByRole('checkbox', { name: '选择本页全部' }));
    expect(await screen.findByText('已选 2 项')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '清除选择' }));
    expect(screen.queryByText(/已选 \d+ 项/)).not.toBeInTheDocument();

    await user.click(screen.getAllByRole('checkbox', { name: '选择这一行' })[0]);
    await user.click(screen.getByRole('button', { name: '导出' }));
    expect(await screen.findByRole('button', { name: '已选 (1)' })).toBeInTheDocument();
  });

  it('shows the subscribed columns, and only those', async () => {
    handlers([{ ci_id: 5, type_id: 1, values: { hostname: 'web-01', note: 'hello', root_password: 'x' } }]);
    renderPage();

    expect(await screen.findByText('web-01')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'note' })).toBeInTheDocument();
    // THE SUBSCRIPTION IS THE COLUMN SET: an attribute nobody subscribed to is
    // not a column, even though the row carries it.
    expect(screen.queryByRole('columnheader', { name: 'root_password' })).not.toBeInTheDocument();
  });

  it('searches the whole model through /ci/s on Enter and clears back to the list', async () => {
    const user = userEvent.setup();
    handlers([{ ci_id: 5, type_id: 1, values: { hostname: 'web-01', note: 'hello' } }]);
    const searches: unknown[] = [];
    server.use(
      http.post('/api/v1/cmdb/ci/s', async ({ request }) => {
        searches.push(await request.json());
        return HttpResponse.json({
          numfound: 1,
          total: 1,
          page: 1,
          result: [
            {
              _id: 7,
              _type: 1,
              ci_id: 7,
              ci_type: 'host',
              unique: 'hostname',
              unique_alias: '主机名',
              _updated_at: '2026-10-27 09:00:00',
              _updated_by: 'admin',
              hostname: 'web-99',
              note: 'found',
            },
          ],
        });
      }),
    );
    renderPage();

    expect(await screen.findByText('web-01')).toBeInTheDocument();
    const box = screen.getByRole('searchbox', { name: '搜索全部实例' });
    await user.type(box, 'web-99{Enter}');

    // A SERVER SEARCH, NOT A PAGE FILTER: the term goes to the DSL endpoint.
    await waitFor(() => expect(searches).toHaveLength(1));
    expect(searches[0]).toMatchObject({ q: '_type:1,*web-99*', count: 20, page: 1 });
    expect(await screen.findByText('web-99')).toBeInTheDocument();
    expect(screen.getByText('found')).toBeInTheDocument();
    expect(screen.queryByText('web-01')).not.toBeInTheDocument();
    expect(screen.getByText('匹配实例')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '清除搜索' }));
    // The empty term returns to the ordinary list endpoint.
    expect(await screen.findByText('web-01')).toBeInTheDocument();
    expect(screen.getByText('实例总数')).toBeInTheDocument();
  });

  it('filters by environment and switches to the card grid', async () => {
    const user = userEvent.setup();
    handlers([
      { ci_id: 5, type_id: 1, values: { hostname: 'web-01', environment: 'prod', level: 'critical' } },
      { ci_id: 6, type_id: 1, values: { hostname: 'web-02', environment: 'test', level: 'normal' } },
    ]);
    server.use(
      http.get('/api/v1/cmdb/instances/5', () =>
        HttpResponse.json({
          ci_id: 5,
          type_id: 1,
          values: { hostname: 'web-01', environment: 'prod', level: 'critical', data_status: 'active' },
        }),
      ),
      http.get('/api/v1/cmdb/preferences/ci-types/host/fields', () =>
        HttpResponse.json({
          type_id: 1,
          is_subscribed: true,
          fields: [
            { attr_id: 10, is_fixed: true },
            { attr_id: 13, is_fixed: false },
            { attr_id: 14, is_fixed: false },
          ],
        }),
      ),
      http.get('/api/v1/cmdb/ci-types/host/attributes', () =>
        HttpResponse.json({
          type_id: 1,
          unique_id: 10,
          unique: 'hostname',
          attributes: [
            ...attributes,
            attribute(13, 'environment', {
              is_choice: true,
              choice_value: [
                { value: 'prod', option: { label: '生产' } },
                { value: 'test', option: { label: '测试' } },
              ],
            }),
            attribute(14, 'level', {
              is_choice: true,
              choice_value: [
                { value: 'critical', option: { label: '关键' } },
                { value: 'normal', option: { label: '一般' } },
              ],
            }),
            attribute(15, 'data_status', {
              is_choice: true,
              choice_value: [{ value: 'active', option: { label: '使用中' } }],
            }),
          ],
        }),
      ),
    );
    renderPage();

    expect(await screen.findByText('web-01')).toBeInTheDocument();
    expect(screen.getByText('web-02')).toBeInTheDocument();
    // THE CODE IS NOT THE LABEL: the API stores `prod`, the operator reads 生产.
    expect(screen.getAllByText('生产').length).toBeGreaterThan(1);
    expect(screen.getAllByText('关键').length).toBeGreaterThan(1);

    await user.click(screen.getByRole('button', { name: '生产' }));
    expect(screen.queryByText('web-02')).not.toBeInTheDocument();
    expect(screen.getByText('web-01')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '网格' }));
    expect(await screen.findByRole('heading', { name: 'web-01' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看实例 5' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑实例 5' })).toBeInTheDocument();
    expect(screen.getAllByText('生产').length).toBeGreaterThan(0);
    // The grid shares the table's selection state and gives the card its own
    // checkbox instead of making the whole card a checkbox.
    await user.click(screen.getByRole('checkbox', { name: '选择实例 5' }));
    expect(await screen.findByText('已选 1 项')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '查看实例 5' }));
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findAllByText('生产')).not.toHaveLength(0);
    // The status pill is a choice too: `active` must read as 使用中.
    expect(within(drawer).getAllByText('使用中').length).toBeGreaterThan(0);
  });

  it('says when a model cannot hold instances', async () => {
    // NO ROWS, so the empty state is what draws — and it has to explain the
    // model rather than say "no data".
    handlers([]);
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [{ ...model, is_attached: false }], total: 1 })),
      http.get('/api/v1/cmdb/ci-types/host/attributes', () =>
        HttpResponse.json({ type_id: 1, unique_id: 10, unique: 'hostname', attributes: [] }),
      ),
    );
    renderPage();

    expect(await screen.findByText(/存不了实例/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /新建实例/ })).toBeDisabled();
  });

  it('shows a referenced instance by its name instead of the stored id', async () => {
    const user = userEvent.setup();
    const members = { ...model, id: 54, name: 'members', alias: '人员', unique_key: 'userid', show_name: 'name' };
    const owner = attribute(13, 'ops_owner', { alias: '运维负责人', value_type: '0', is_reference: true, reference_type_id: 54 });
    handlers([{ ci_id: 5, type_id: 1, values: { hostname: 'web-01', ops_owner: 374 } }]);
    server.use(
      http.get('/api/v1/cmdb/instances/5', () =>
        HttpResponse.json({ ci_id: 5, type_id: 1, values: { hostname: 'web-01', ops_owner: 374 } }),
      ),
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [model, members], total: 2 })),
      http.get('/api/v1/cmdb/ci-types/host/attributes', () =>
        HttpResponse.json({ type_id: 1, unique_id: 10, unique: 'hostname', attributes: [...attributes, owner] }),
      ),
      http.get('/api/v1/cmdb/preferences/ci-types/host/fields', () =>
        HttpResponse.json({
          type_id: 1,
          is_subscribed: true,
          fields: [{ attr_id: 10, is_fixed: true }, { attr_id: 13, is_fixed: false }],
        }),
      ),
      http.post('/api/v1/cmdb/ci/s', () =>
        HttpResponse.json({
          numfound: 1,
          total: 1,
          page: 1,
          result: [{ _id: 374, _type: 54, ci_id: 374, ci_type: 'members', name: '何忠贵', userid: 'A01492' }],
        }),
      ),
    );
    renderPage();

    expect(await screen.findByText('何忠贵')).toBeInTheDocument();
    expect(screen.queryByText('374')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '查看实例 5' }));
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('何忠贵')).toBeInTheDocument();
  });

  it('deletes after a confirmation that names the row', async () => {
    const user = userEvent.setup();
    handlers([{ ci_id: 5, type_id: 1, values: { hostname: 'web-01', note: '' } }]);
    let deleted = 0;
    server.use(
      http.delete('/api/v1/cmdb/instances/:id', () => {
        deleted += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: '删除实例 5' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/web-01/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(deleted).toBe(0);
  });
});

describe('the workspace layout', () => {
  it('keeps the compact header and model rail outside the content scroller', async () => {
    handlers([{ ci_id: 5, type_id: 1, values: { hostname: 'web-01', note: 'hello' } }]);
    const { container } = renderPage();

    expect(await screen.findByText('web-01')).toBeInTheDocument();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('资源数据');
    const header = heading.closest('header');
    expect(header).not.toBeNull();
    if (!header) return;
    // THE MODEL ALIAS LIVES IN THE METADATA LINE, not the page title.
    expect(within(header).getByText('主机')).toBeInTheDocument();
    // THE HEADER IS ITS OWN SURFACE: it must not scroll with the table.
    expect(header.closest('.cmdb-liquid-content')).toBeNull();
    expect(container.querySelectorAll('.cmdb-liquid-content')).toHaveLength(1);

    const rail = screen.getByRole('navigation', { name: '模型对象' });
    expect(rail.closest('.cmdb-liquid-content')).toBeNull();
    expect(within(rail).getByRole('button', { name: '主机' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(header).getByText('实例总数')).toBeInTheDocument();
    expect(within(header).getByText('本页')).toBeInTheDocument();
    expect(within(header).getByRole('link', { name: /批量导入/ })).toHaveAttribute('href', '/cmdb/batch');
    expect(within(header).getByRole('button', { name: /刷新/ })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: /新建实例/ })).toBeEnabled();
  });

  it('switches models from the rail and clears the previous model rows', async () => {
    const user = userEvent.setup();
    handlers([{ ci_id: 5, type_id: 1, values: { hostname: 'web-01', note: 'hello' } }]);
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [model, switchModel], total: 2 })),
      http.get('/api/v1/cmdb/ci-types/switch/attributes', () =>
        HttpResponse.json({ type_id: 2, unique_id: 10, unique: 'hostname', attributes }),
      ),
      http.get('/api/v1/cmdb/ci-types/switch/attribute-groups', () => HttpResponse.json([])),
      http.get('/api/v1/cmdb/preferences/ci-types/switch/fields', () =>
        HttpResponse.json({
          type_id: 2,
          is_subscribed: true,
          fields: [
            { attr_id: 10, is_fixed: true },
            { attr_id: 11, is_fixed: false },
          ],
        }),
      ),
      http.get('/api/v1/cmdb/ci-types/switch/instances', () =>
        HttpResponse.json({
          type_id: 2,
          items: [{ ci_id: 6, type_id: 2, values: { hostname: 'sw-01', note: 'core' } }],
          total: 1,
          numfound: 1,
          page: 1,
        }),
      ),
    );
    renderPage();

    expect(await screen.findByText('web-01')).toBeInTheDocument();
    const rail = screen.getByRole('navigation', { name: '模型对象' });
    const switchButton = within(rail).getByRole('button', { name: '交换机' });
    expect(switchButton).toHaveAttribute('aria-pressed', 'false');

    await user.click(switchButton);

    expect(await screen.findByText('sw-01')).toBeInTheDocument();
    expect(screen.queryByText('web-01')).not.toBeInTheDocument();
    expect(within(rail).getByRole('button', { name: '交换机' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(rail).getByRole('button', { name: '主机' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('orders the model rail like 我的订阅, including groups and models inside them', async () => {
    handlers([]);
    server.use(
      http.get('/api/v1/cmdb/ci-types', () =>
        HttpResponse.json({ items: [model, switchModel, databaseModel], total: 3 }),
      ),
      http.get('/api/v1/cmdb/preferences/model-groups', () =>
        HttpResponse.json({
          items: [
            { id: 10, name: '服务器', ci_types: [model, databaseModel], is_other: false },
            { id: 11, name: '网络', ci_types: [switchModel], is_other: false },
          ],
          total: 2,
        }),
      ),
      http.get('/api/v1/cmdb/preferences/ci-types', () =>
        // 数据库 is first in 我的订阅 even though the group's API order starts
        // with 主机; the rail must follow the subscription, not the catalogue.
        HttpResponse.json({ groups: [], type_ids: [databaseModel.id, model.id] }),
      ),
    );
    renderPage('/cmdb/instances?type=host');

    const nav = await screen.findByRole('navigation', { name: '模型对象' });
    expect(within(nav).getAllByRole('button', { name: /^(数据库|主机|交换机)$/ }).map((button) =>
      button.getAttribute('aria-label'),
    )).toEqual(['数据库', '主机', '交换机']);

    const headings = within(nav).getAllByRole('button', { name: /服务器|网络/ });
    expect(headings[0]).toHaveTextContent('服务器');
    expect(headings[1]).toHaveTextContent('网络');
  });

  it('groups the model rail by the configured model groups', async () => {
    const user = userEvent.setup();
    const members = { ...model, id: 54, name: 'members', alias: '人员', unique_key: 'userid' };
    handlers([{ ci_id: 5, type_id: 1, values: { hostname: 'web-01', note: 'hello' } }]);
    server.use(
      http.get('/api/v1/cmdb/ci-types', () =>
        HttpResponse.json({ items: [model, switchModel, members], total: 3 }),
      ),
      http.get('/api/v1/cmdb/preferences/model-groups', () =>
        HttpResponse.json({
          items: [
            { id: 1, name: '服务器', ci_types: [model] },
            { id: 2, name: '网络', ci_types: [switchModel] },
          ],
          total: 2,
        }),
      ),
    );
    renderPage();

    const rail = await screen.findByRole('navigation', { name: '模型对象' });
    expect(await within(rail).findByRole('heading', { name: /服务器/ })).toBeInTheDocument();
    expect(within(rail).getByRole('heading', { name: /网络/ })).toBeInTheDocument();
    // A model no group claims stays reachable in the trailing 其他 section.
    expect(within(rail).getByRole('heading', { name: /其他/ })).toBeInTheDocument();
    expect(within(rail).getByRole('button', { name: '主机' })).toBeInTheDocument();
    expect(within(rail).getByRole('button', { name: '交换机' })).toBeInTheDocument();
    expect(within(rail).getByRole('button', { name: '人员' })).toBeInTheDocument();

    // A group collapses its models while keeping the heading and count.
    const serverGroup = within(rail).getByRole('button', { name: /服务器/ });
    expect(serverGroup).toHaveAttribute('aria-expanded', 'true');
    await user.click(serverGroup);
    expect(serverGroup).toHaveAttribute('aria-expanded', 'false');
    expect(within(rail).queryByRole('button', { name: '主机' })).not.toBeInTheDocument();
    expect(within(rail).getByRole('heading', { name: /服务器/ })).toBeInTheDocument();
    await user.click(serverGroup);
    expect(within(rail).getByRole('button', { name: '主机' })).toBeInTheDocument();
  });

  it('keeps the rail flat and explains when model groups cannot be read', async () => {
    handlers([{ ci_id: 5, type_id: 1, values: { hostname: 'web-01', note: 'hello' } }]);
    server.use(
      http.get('/api/v1/cmdb/preferences/model-groups', () => new HttpResponse(null, { status: 500 })),
    );
    renderPage();

    const rail = await screen.findByRole('navigation', { name: '模型对象' });
    expect(await within(rail).findByText(/模型分组加载失败/)).toBeInTheDocument();
    expect(within(rail).queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
    expect(within(rail).getByRole('button', { name: '主机' })).toBeInTheDocument();
  });

  it('lists every model attribute and saves the chosen columns', async () => {
    const user = userEvent.setup();
    const environment = attribute(13, 'environment', { alias: '环境' });
    handlers([{ ci_id: 5, type_id: 1, values: { hostname: 'web-01', note: 'hello', environment: 'prod' } }]);
    const saved: unknown[] = [];
    server.use(
      http.get('/api/v1/cmdb/ci-types/host/attributes', () =>
        HttpResponse.json({
          type_id: 1,
          unique_id: 10,
          unique: 'hostname',
          attributes: [...attributes, environment],
        }),
      ),
      http.get('/api/v1/cmdb/preferences/ci-types/host/fields', () =>
        HttpResponse.json({
          type_id: 1,
          is_subscribed: true,
          fields: [
            { attr_id: 10, is_fixed: true },
            { attr_id: 11, is_fixed: false },
          ],
        }),
      ),
      http.put('/api/v1/cmdb/preferences/ci-types/1/fields', async ({ request }) => {
        saved.push(await request.json());
        return HttpResponse.json({ type_id: 1, is_subscribed: true, fields: [] });
      }),
    );
    renderPage();

    // Wait for the subscribed columns before opening: the dialog starts from
    // them, and opening early would save a different set.
    expect(await screen.findByRole('columnheader', { name: 'note' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '查看并选择模型字段' }));

    const dialog = await screen.findByRole('dialog', { name: /属性说明/ });
    // The complete attribute set is on screen, not only the visible columns.
    expect(within(dialog).getByRole('checkbox', { name: '环境' })).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'hostname' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(dialog).getByRole('img', { name: '标识列，固定显示' })).toBeInTheDocument();
    // The table shows the definition, not just a name: alias, type and flags.
    const row = within(dialog).getByRole('row', { name: /environment/ });
    expect(within(row).getByText('环境')).toBeInTheDocument();
    expect(within(row).getByText('文本')).toBeInTheDocument();
    expect(within(row).getAllByRole('img', { name: '是' }).length).toBeGreaterThan(0);

    // Searching narrows the table to the matching attributes.
    await user.type(within(dialog).getByRole('searchbox', { name: '搜索属性' }), '环境');
    expect(within(dialog).queryByText('hostname')).not.toBeInTheDocument();
    await user.clear(within(dialog).getByRole('searchbox', { name: '搜索属性' }));

    await user.click(within(dialog).getByRole('checkbox', { name: '环境' }));
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({
      fields: [
        { ref: '10', is_fixed: true },
        { ref: '11', is_fixed: false },
        { ref: '13', is_fixed: false },
      ],
    });
    expect(await screen.findByRole('columnheader', { name: '环境' })).toBeInTheDocument();
  });

  it('keeps the instances usable when the model list fails, then retries from the rail', async () => {
    const user = userEvent.setup();
    let failed = true;
    handlers([{ ci_id: 5, type_id: 1, values: { hostname: 'web-01', note: 'hello' } }]);
    server.use(
      http.get('/api/v1/cmdb/ci-types', () =>
        failed
          ? new HttpResponse(null, { status: 500 })
          : HttpResponse.json({ items: [model], total: 1 }),
      ),
    );
    renderPage();

    expect(await screen.findByText('web-01')).toBeInTheDocument();
    const rail = screen.getByRole('navigation', { name: '模型对象' });
    expect(within(rail).getByRole('alert')).toHaveTextContent(/无法读取模型/);
    expect(screen.queryByRole('button', { name: '主机' })).not.toBeInTheDocument();

    failed = false;
    await user.click(within(rail).getByRole('button', { name: '重试' }));

    expect(await within(rail).findByRole('button', { name: '主机' })).toBeInTheDocument();
    expect(within(rail).queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('the detail drawer', () => {
  it('uses icon-only actions and opens directly on the topology tab', async () => {
    const user = userEvent.setup();
    handlers([{ ci_id: 5, type_id: 1, values: { hostname: 'web-01', note: 'hello' } }]);
    server.use(
      http.get('/api/v1/cmdb/instances/5', () =>
        HttpResponse.json({ ci_id: 5, type_id: 1, values: { hostname: 'web-01', note: 'hello' } }),
      ),
    );
    renderPage();

    const details = await screen.findByRole('button', { name: '查看实例 5' });
    expect(details).toHaveTextContent('');
    await user.click(screen.getByRole('button', { name: '实例 5 拓扑' }));

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByTestId('instance-topology')).toHaveTextContent('web-01');
    expect(within(drawer).getByRole('tab', { name: '拓扑' })).toBeInTheDocument();
  });

  it('opens from a row and shows overview, topology, history and trigger records', async () => {
    const user = userEvent.setup();
    handlers([{ ci_id: 5, type_id: 1, values: { hostname: 'web-01', note: 'hello' } }]);
    server.use(
      http.get('/api/v1/cmdb/instances/5', () =>
        HttpResponse.json({
          ci_id: 5,
          type_id: 1,
          created_at: '2026-10-20 09:00:00',
          updated_at: '2026-10-27 10:00:00',
          values: { hostname: 'web-01', note: 'hello' },
        }),
      ),
      http.get('/api/v1/users', () =>
        HttpResponse.json({
          items: [{ id: 7, email: 'ops@example.test', display_name: '运维', role: 'admin', status: 'active' }],
          total: 1,
        }),
      ),
      http.get('/api/v1/cmdb/history/ci/5', () =>
        HttpResponse.json({
          items: [
            {
              id: 9, record_id: 1, uid: 7, operate_type: '2', ci_id: 5, ci_name: 'web-01',
              attr_id: 10, attr_name: 'hostname', attr_alias: '主机名',
              old: 'web-00', new: 'web-01', created_at: '2026-10-27 10:00:00',
            },
          ],
          total: 1, page: 1, page_size: 20,
        }),
      ),
      http.get('/api/v1/cmdb/history/ci/5/triggers', () =>
        HttpResponse.json({
          items: [
            {
              id: 11, ci_id: 5, ci_name: 'web-01', trigger_id: 3, trigger_name: '主机变更通知',
              operate_type: '2', is_ok: true, notify: 'dingtalk', created_at: '2026-10-27 10:01:00',
            },
          ],
          total: 1, page: 1, page_size: 20,
        }),
      ),
      http.get('/api/v1/cmdb/ci-relations/search', ({ request }) => {
        const reverse = new URL(request.url).searchParams.get('reverse') === 'true';
        return HttpResponse.json({
          numfound: 1,
          total: 1,
          page: 1,
          result: reverse
            ? [{ _id: 20, _type: 3, ci_id: 20, ci_type: 'rack', unique: 'name', name: 'rack-01' }]
            : [{ _id: 21, _type: 2, ci_id: 21, ci_type: 'disk', unique: 'name', name: 'sda' }],
        });
      }),
      http.get('/api/v1/cmdb/ci-types/host/relation-parents', () =>
        HttpResponse.json({
          items: [{
            ctr_id: 1,
            type: { ...model, id: 3, name: 'rack', alias: '机柜', icon: '', unique_key: 'name' },
            attributes: [attribute(30, 'name', { alias: '名称' })],
            relation_type: { id: 1, name: '属于', color: '' },
            constraint: '0', parent_attr_ids: [], child_attr_ids: [],
          }],
          total: 1,
        }),
      ),
      http.get('/api/v1/cmdb/ci-types/host/relation-children', () =>
        HttpResponse.json({
          items: [{
            ctr_id: 2,
            type: { ...model, id: 2, name: 'disk', alias: '磁盘', icon: '', unique_key: 'name' },
            attributes: [attribute(31, 'name', { alias: '名称' })],
            relation_type: { id: 2, name: '包含', color: '' },
            constraint: '0', parent_attr_ids: [], child_attr_ids: [],
          }],
          total: 1,
        }),
      ),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: '查看实例 5' }));
    const drawer = await screen.findByRole('dialog');
    for (const name of ['详情', '拓扑', '变更历史', '触发记录']) {
      const tab = within(drawer).getByRole('tab', { name });
      expect(tab).toBeInTheDocument();
      // THE ICON IS DECORATION, so the accessible name stays the label; it
      // still needs to be present on every tab.
      expect(tab.querySelector('svg')).toBeInTheDocument();
    }
    expect(await within(drawer).findByText('hello')).toBeInTheDocument();
    expect(await within(drawer).findByText('关联关系')).toBeInTheDocument();
    expect(within(drawer).getAllByText('机柜').length).toBeGreaterThan(0);
    expect(within(drawer).getAllByText('磁盘').length).toBeGreaterThan(0);

    await user.click(within(drawer).getByRole('tab', { name: '拓扑' }));
    expect(await within(drawer).findByTestId('instance-topology')).toHaveTextContent('web-01');

    await user.click(within(drawer).getByRole('tab', { name: '变更历史' }));
    expect(await within(drawer).findByText('web-00')).toBeInTheDocument();
    expect(within(drawer).getByText('运维')).toBeInTheDocument();

    await user.click(within(drawer).getByRole('tab', { name: '触发记录' }));
    expect(await within(drawer).findByText('主机变更通知')).toBeInTheDocument();
    expect(within(drawer).getByText('成功')).toBeInTheDocument();
  });

  it('labels a uuid unique key as UUID even when the attribute has a custom alias', async () => {
    const user = userEvent.setup();
    handlers([{ ci_id: 5, type_id: 1, values: { uuid: 'e0eddc0a-cc2a-4fee-9f19-aac7a1f7e664', name: 'web-01' } }]);
    server.use(
      http.get('/api/v1/cmdb/instances/5', () =>
        HttpResponse.json({
          ci_id: 5,
          type_id: 1,
          values: { uuid: 'e0eddc0a-cc2a-4fee-9f19-aac7a1f7e664', name: 'web-01' },
        }),
      ),
      http.get('/api/v1/cmdb/ci-types', () =>
        HttpResponse.json({ items: [{ ...model, unique_key: 'uuid' }], total: 1 }),
      ),
      http.get('/api/v1/cmdb/ci-types/host/attributes', () =>
        HttpResponse.json({
          type_id: 1,
          unique_id: 15,
          unique: 'uuid',
          attributes: [attribute(15, 'uuid', { alias: 'ID' }), attribute(10, 'name', { alias: '名称' })],
        }),
      ),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: '查看实例 5' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('UUID: e0eddc0a-cc2a-4fee-9f19-aac7a1f7e664')).toBeInTheDocument();
    expect(within(drawer).queryByText(/^ID: e0eddc0a/)).not.toBeInTheDocument();
  });
});

describe('the detail drawer deep link', () => {
  it('opens an instance directly from a ci query parameter', async () => {
    handlers([{ ci_id: 5, type_id: 1, values: { hostname: 'web-01' } }]);
    server.use(
      http.get('/api/v1/cmdb/instances/5', () =>
        HttpResponse.json({ ci_id: 5, type_id: 1, values: { hostname: 'web-01' } }),
      ),
      http.get('/api/v1/cmdb/ci-types/host/relation-parents', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/ci-types/host/relation-children', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/ci-relations/search', () =>
        HttpResponse.json({ numfound: 0, total: 0, page: 1, result: [] }),
      ),
    );
    renderPage('/cmdb/instances?type=host&ci=5');

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findAllByText('web-01')).not.toHaveLength(0);
  });
});

describe('the form in the drawer', () => {
  it('creates with the typed values', async () => {
    const user = userEvent.setup();
    handlers([]);
    const posted: unknown[] = [];
    server.use(
      http.post('/api/v1/cmdb/instances', async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ ci_id: 6, created: true }, { status: 201 });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: /新建实例/ }));
    const drawer = await screen.findByRole('dialog');
    await user.type(within(drawer).getByLabelText('hostname'), 'web-02');
    await user.type(within(drawer).getByLabelText('note'), 'rack A');
    await user.click(within(drawer).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      ci_type: 1,
      exist_policy: 'reject',
      values: { hostname: 'web-02', note: 'rack A' },
    });
  });

  it('selects a reference by searching the referenced model and saves its id', async () => {
    const user = userEvent.setup();
    const members = { ...model, id: 54, name: 'members', alias: '人员', unique_key: 'userid', show_name: 'name' };
    const owner = attribute(13, 'ops_owner', { alias: '运维负责人', value_type: '0', is_reference: true, reference_type_id: 54 });
    handlers([]);
    const posted: unknown[] = [];
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [model, members], total: 2 })),
      http.get('/api/v1/cmdb/ci-types/host/attributes', () =>
        HttpResponse.json({ type_id: 1, unique_id: 10, unique: 'hostname', attributes: [...attributes, owner] }),
      ),
      http.post('/api/v1/cmdb/ci/s', () =>
        HttpResponse.json({
          numfound: 1,
          total: 1,
          page: 1,
          result: [{ _id: 374, _type: 54, ci_id: 374, ci_type: 'members', name: '何忠贵', userid: 'A01492' }],
        }),
      ),
      http.post('/api/v1/cmdb/instances', async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ ci_id: 6, created: true }, { status: 201 });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: /新建实例/ }));
    const drawer = await screen.findByRole('dialog');
    await user.type(within(drawer).getByLabelText('hostname'), 'web-02');
    const trigger = within(drawer).getByRole('combobox', { name: '运维负责人' });
    await user.click(trigger);
    const search = await screen.findByRole('combobox', { name: '搜索运维负责人' });
    await user.type(search, '何');
    await user.click(await screen.findByRole('option', { name: '何忠贵' }));
    await user.click(within(drawer).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0] as { values: Record<string, unknown> }).values.ops_owner).toBe(374);
  });

  it('does not clear a stored secret on a save that did not touch it', async () => {
    const user = userEvent.setup();
    handlers([{ ci_id: 5, type_id: 1, values: { hostname: 'web-01', note: 'hello' } }]);
    server.use(
      http.get('/api/v1/cmdb/instances/5', () =>
        HttpResponse.json({ ci_id: 5, type_id: 1, values: { hostname: 'web-01', note: 'hello' } }),
      ),
    );
    const put: unknown[] = [];
    server.use(
      http.put('/api/v1/cmdb/instances/5', async ({ request }) => {
        put.push(await request.json());
        return HttpResponse.json({ ci_id: 5, created: false });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: '编辑实例 5' }));
    const drawer = await screen.findByRole('dialog');
    await user.clear(within(drawer).getByLabelText('note'));
    await user.type(within(drawer).getByLabelText('note'), 'changed');
    await user.click(within(drawer).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(put).toHaveLength(1));
    const values = (put[0] as { values: Record<string, unknown> }).values;
    expect(values.note).toBe('changed');
    // THE PASSWORD BOX IS EMPTY ON EVERY EDIT — a read never returns a secret —
    // so sending that empty value would wipe a credential the operator did not
    // touch. It is OMITTED, not sent as null.
    expect('root_password' in values).toBe(false);
  });

  it('omits a computed attribute and says why it cannot be typed', async () => {
    const user = userEvent.setup();
    handlers([{ ci_id: 5, type_id: 1, values: { hostname: 'web-01', note: '' } }]);
    server.use(
      http.get('/api/v1/cmdb/ci-types/host/attributes', () =>
        HttpResponse.json({
          type_id: 1,
          unique_id: 10,
          unique: 'hostname',
          attributes: [...attributes, attribute(13, 'asset_no', { is_computed: true })],
        }),
      ),
      http.get('/api/v1/cmdb/instances/5', () =>
        HttpResponse.json({ ci_id: 5, type_id: 1, values: { hostname: 'web-01' } }),
      ),
    );
    const put: unknown[] = [];
    server.use(
      http.put('/api/v1/cmdb/instances/5', async ({ request }) => {
        put.push(await request.json());
        return HttpResponse.json({ ci_id: 5, created: false });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: '编辑实例 5' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText(/由模型计算/)).toBeInTheDocument();
    expect(within(drawer).getByLabelText('asset_no')).toBeDisabled();

    await user.click(within(drawer).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(put).toHaveLength(1));
    // THE MODEL DERIVES IT; sending a value would be ignored, and sending null
    // would be a write about a field the form cannot edit.
    expect('asset_no' in (put[0] as { values: Record<string, unknown> }).values).toBe(false);
  });
});
