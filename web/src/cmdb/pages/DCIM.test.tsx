import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { server } from '@/test/msw-server';
import { selectOption } from '@/test/select-option';
import { useAuth } from '@/store/auth';
import DCIMPage from './DCIM';
import { ToastProvider } from '../components/Toast';

const tree = {
  result: [
    {
      _id: 1,
      _type: 101,
      ci_type: 'dcim_region',
      ci_type_alias: '区域',
      name: '华北',
      children: [
        {
          _id: 2,
          _type: 102,
          ci_type: 'dcim_idc',
          ci_type_alias: '数据中心',
          name: '亦庄',
          children: [
            {
              _id: 3,
              _type: 103,
              ci_type: 'dcim_server_room',
              ci_type_alias: '机房',
              name: 'A 机房',
              rack_count: 2,
              children: [],
            },
          ],
        },
      ],
    },
  ],
  type2name: { '101': 'name', '102': 'name', '103': 'name' },
};

const racks = {
  numfound: 2,
  total: 2,
  page: 1,
  counter: { rack_count: 2, u_count: 84, u_used_count: 20, device_count: 3 },
  result: [
    {
      _id: 31,
      _type: 48,
      ci_id: 31,
      ci_type: 'dcim_rack',
      name: 'R-A01',
      u_count: 42,
      free_u_count: 30,
      u_slot_abnormal: false,
      rack_type: '普通柜',
      rack_code: 'A-01',
    },
    {
      _id: 32,
      _type: 48,
      ci_id: 32,
      ci_type: 'dcim_rack',
      name: 'R-A02',
      u_count: 42,
      free_u_count: -8,
      u_slot_abnormal: true,
      rack_type: '网络柜',
      rack_code: 'A-02',
    },
  ],
};

type AttributeFixture = {
  id: number;
  name: string;
  alias: string;
  value_type?: string;
  is_choice?: boolean;
  choice_value?: Array<{ value: string; option?: { label?: string } }>;
  is_required?: boolean;
  default_show?: boolean;
  is_bool?: boolean;
  is_dynamic?: boolean;
};

function attribute(input: AttributeFixture) {
  return {
    value_type: '2',
    is_choice: false,
    is_list: false,
    is_unique: false,
    is_index: true,
    is_link: false,
    is_password: false,
    is_sortable: true,
    is_dynamic: false,
    is_bool: false,
    is_file: false,
    is_reference: false,
    is_computed: false,
    has_compute_script: false,
    has_choice_web_hook: false,
    has_choice_other: false,
    is_indexed: true,
    storage_table: 'c_text',
    is_required: false,
    order: 0,
    default_show: true,
    inherited: false,
    ...input,
  };
}

const rackAttributes = [
  attribute({ id: 124, name: 'name', alias: '名称', is_required: true }),
  attribute({ id: 147, name: 'u_count', alias: 'U数', value_type: '0', is_required: true }),
  attribute({ id: 143, name: 'free_u_count', alias: '可用U数', value_type: '0', is_required: true }),
  attribute({
    id: 137,
    name: 'rack_type',
    alias: '机柜类型',
    is_choice: true,
    choice_value: [
      { value: '普通柜', option: { label: '普通柜' } },
      { value: '网络柜', option: { label: '网络柜' } },
    ],
  }),
  attribute({ id: 135, name: 'rack_code', alias: '机柜编号' }),
  attribute({ id: 136, name: 'u_slot_abnormal', alias: 'U位异常', value_type: '7', is_bool: true, is_dynamic: true }),
];

const roomAttributes = [attribute({ id: 124, name: 'name', alias: '名称', is_required: true })];
const regionAttributes = [attribute({ id: 124, name: 'name', alias: '名称', is_required: true })];
const serverAttributes = [attribute({ id: 5, name: 'name', alias: '名称', is_required: true })];

const models = [
  { id: 45, name: 'dcim_region', alias: '区域', unique_key: 'name', show_name: 'name' },
  { id: 46, name: 'dcim_server_room', alias: '机房', unique_key: 'name', show_name: 'name' },
  { id: 47, name: 'dcim_idc', alias: '数据中心', unique_key: 'name', show_name: 'name' },
  { id: 48, name: 'dcim_rack', alias: '机柜', unique_key: 'name', show_name: 'name' },
  { id: 5, name: 'server', alias: '服务器', unique_key: 'name', show_name: 'name' },
].map((model) => ({
  ...model,
  enabled: true,
  is_attached: true,
  icon: '',
  order: 0,
  parent_ids: [],
}));

function citType(id: number, name: string, alias: string) {
  return models.find((model) => model.id === id) ?? { ...models[0], id, name, alias };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/cmdb/dcim']}>
      <ToastProvider>
        <DCIMPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

const devices = {
  numfound: 1,
  total: 1,
  page: 1,
  result: [
    {
      _id: 55,
      _type: 5,
      ci_id: 55,
      ci_type: 'server',
      ci_type_alias: '服务器',
      name: 'srv-01',
      u_start: 2,
      u_count: 2,
      owner: '平台组',
    },
  ],
};

function handlers(overrides: { devices?: unknown } = {}) {
  server.use(
    http.get('/api/v1/cmdb/dcim/tree-view', () => HttpResponse.json(tree)),
    http.get('/api/v1/cmdb/dcim/server-rooms/3/racks', () => HttpResponse.json(racks)),
    http.get('/api/v1/cmdb/dcim/history/operations', () =>
      HttpResponse.json({
        numfound: 1,
        result: [{ _id: 9, rack_id: 31, ci_id: 55, uid: 7, operate_type: '0', created_at: '2026-10-17 10:00:00' }],
        id2ci: { '55': { _type: 5, ci_type: 'server', ci_type_alias: '服务器', name: 'srv-01' } },
        type2show_key: { '5': 'name' },
      }),
    ),
    http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: models, total: models.length })),
    http.get('/api/v1/cmdb/ci-types/dcim_rack', () => HttpResponse.json(citType(48, 'dcim_rack', '机柜'))),
    http.get('/api/v1/cmdb/ci-types/dcim_region', () => HttpResponse.json(citType(45, 'dcim_region', '区域'))),
    http.get('/api/v1/cmdb/ci-types/dcim_idc', () => HttpResponse.json(citType(47, 'dcim_idc', '数据中心'))),
    http.get('/api/v1/cmdb/ci-types/dcim_server_room', () => HttpResponse.json(citType(46, 'dcim_server_room', '机房'))),
    http.get('/api/v1/cmdb/ci-types/48/attributes', () =>
      HttpResponse.json({ type_id: 48, unique_id: 124, unique: 'name', attributes: rackAttributes }),
    ),
    http.get('/api/v1/cmdb/ci-types/46/attributes', () =>
      HttpResponse.json({ type_id: 46, unique_id: 124, unique: 'name', attributes: roomAttributes }),
    ),
    http.get('/api/v1/cmdb/ci-types/45/attributes', () =>
      HttpResponse.json({ type_id: 45, unique_id: 124, unique: 'name', attributes: regionAttributes }),
    ),
    http.get('/api/v1/cmdb/ci-types/5/attributes', () =>
      HttpResponse.json({ type_id: 5, unique_id: 5, unique: 'name', attributes: serverAttributes }),
    ),
    http.get('/api/v1/cmdb/ci-types/48/attribute-groups', () => HttpResponse.json([])),
    http.get('/api/v1/cmdb/ci-types/46/attribute-groups', () => HttpResponse.json([])),
    http.get('/api/v1/cmdb/ci-types/45/attribute-groups', () => HttpResponse.json([])),
    http.get('/api/v1/cmdb/ci-types/5/attribute-groups', () => HttpResponse.json([])),
    http.get('/api/v1/cmdb/preferences/ci-types/48/fields', () =>
      HttpResponse.json({
        type_id: 48,
        is_subscribed: true,
        fields: [
          { attr_id: 147, is_fixed: false },
          { attr_id: 143, is_fixed: false },
          { attr_id: 137, is_fixed: false },
        ],
      }),
    ),
    http.get('/api/v1/cmdb/preferences/ci-types/5/fields', () =>
      HttpResponse.json({ type_id: 5, is_subscribed: true, fields: [{ attr_id: 5, is_fixed: true }] }),
    ),
    http.get('/api/v1/cmdb/ci-types/48/relation-children', () =>
      HttpResponse.json({
        items: [
          {
            ctr_id: 1,
            type: citType(5, 'server', '服务器'),
            show_key: 'name',
            attributes: serverAttributes,
            relation_type: { id: 1, name: '包含', color: '' },
            constraint: '0',
            parent_attr_ids: [],
            child_attr_ids: [],
          },
        ],
        total: 1,
      }),
    ),
    http.get('/api/v1/cmdb/ci-relations/search', () =>
      HttpResponse.json(overrides.devices ?? devices),
    ),
    http.get('/api/v1/cmdb/instances/31', () =>
      HttpResponse.json({
        ci_id: 31,
        type_id: 48,
        values: {
          name: 'R-A01',
          u_count: 42,
          free_u_count: 30,
          rack_type: '普通柜',
          rack_code: 'A-01',
        },
      }),
    ),
    http.get('/api/v1/cmdb/instances/3', () =>
      HttpResponse.json({ ci_id: 3, type_id: 46, values: { name: 'A 机房' } }),
    ),
    http.post('/api/v1/cmdb/ci/s', () =>
      HttpResponse.json({ numfound: 1, total: 1, page: 1, result: devices.result }),
    ),
    http.get('/api/v1/users', () =>
      HttpResponse.json({ items: [{ id: 7, display_name: '张三', email: 'zhang@example.test' }], total: 1 }),
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  useAuth.setState({ token: null, role: 'admin' });
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1440 });
});

describe('the data-centre tree', () => {
  it('shows the containment and the room’s rack count', async () => {
    handlers();
    renderPage();

    expect(await screen.findByText('华北')).toBeInTheDocument();
    expect(screen.getByText('亦庄')).toBeInTheDocument();
    expect(screen.getByText('A 机房')).toBeInTheDocument();
    expect(screen.getAllByTitle('2 个机柜').length).toBeGreaterThan(0);
    expect(screen.getByText('选择一个机房')).toBeInTheDocument();
  });

  it('selects only a room, not its containers', async () => {
    const user = userEvent.setup();
    handlers();
    renderPage();

    await user.click(await screen.findByText('华北'));
    expect(screen.getByText('选择一个机房')).toBeInTheDocument();

    await user.click(screen.getByText('A 机房'));
    expect(await screen.findByText('R-A01')).toBeInTheDocument();
    expect(screen.queryByText('选择一个机房')).not.toBeInTheDocument();
  });
});

describe('a room’s racks', () => {
  it('shows the room totals and both layouts', async () => {
    const user = userEvent.setup();
    handlers();
    renderPage();

    await user.click(await screen.findByText('A 机房'));
    expect(await screen.findByText('R-A01')).toBeInTheDocument();
    expect(screen.getByText('R-A02')).toBeInTheDocument();
    expect(screen.getByText('24%')).toBeInTheDocument();
    expect(screen.getAllByTitle('空闲 30U').length).toBeGreaterThan(0);
    expect(screen.getByText('50/42')).toBeInTheDocument();
    expect(screen.getByText('U 位异常')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '表格布局' }));
    expect(await screen.findByRole('columnheader', { name: '使用率' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '机柜类型' })).toBeInTheDocument();
    // Height and free units are in the rack cell and the usage cell, so they are
    // not repeated as subscribed columns.
    expect(screen.queryByRole('columnheader', { name: 'U数' })).not.toBeInTheDocument();
  });

  it('filters by name and rack type', async () => {
    const user = userEvent.setup();
    handlers();
    renderPage();

    await user.click(await screen.findByText('A 机房'));
    await screen.findByText('R-A01');
    const search = screen.getByRole('searchbox', { name: '筛选机柜' });
    await user.type(search, 'R-A01');
    await waitFor(() => expect(screen.queryByText('R-A02')).not.toBeInTheDocument());

    await user.clear(search);
    await selectOption(screen.getByLabelText('机柜类型'), '网络柜');
    await waitFor(() => expect(screen.queryByText('R-A01')).not.toBeInTheDocument());
    expect(screen.getByText('R-A02')).toBeInTheDocument();

    // A filter with no matches is not an empty room: it offers a way back.
    await user.type(search, 'no-such-rack');
    expect(await screen.findByText('没有匹配的机柜')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '清除全部筛选' }));
    expect(await screen.findByText('R-A01')).toBeInTheDocument();
  });
});

describe('the rack drawer', () => {
  it('draws devices on the U grid and explains the operation kinds', async () => {
    const user = userEvent.setup();
    handlers();
    renderPage();

    await user.click(await screen.findByText('A 机房'));
    await user.click(await screen.findByRole('button', { name: '打开机柜 R-A01' }));
    const drawer = await screen.findByRole('dialog');
    expect((await within(drawer).findAllByLabelText(/设备 srv-01/)).length).toBeGreaterThan(0);
    expect(within(drawer).getByText('前视图')).toBeInTheDocument();
    expect(within(drawer).getByText('后视图')).toBeInTheDocument();

    await user.click(within(drawer).getByRole('tab', { name: '操作日志' }));
    expect(await within(drawer).findByText('上架')).toBeInTheDocument();
    expect(within(drawer).getByText('张三')).toBeInTheDocument();
    expect(within(drawer).getAllByText('srv-01').length).toBeGreaterThan(0);
  });

  it('shows grouped rack attributes', async () => {
    const user = userEvent.setup();
    handlers();
    renderPage();

    await user.click(await screen.findByText('A 机房'));
    await user.click(await screen.findByRole('button', { name: '打开机柜 R-A01' }));
    const drawer = await screen.findByRole('dialog');
    await user.click(within(drawer).getByRole('tab', { name: '属性' }));
    expect(await within(drawer).findByText('A-01')).toBeInTheDocument();
    expect(within(drawer).getByText('机柜编号')).toBeInTheDocument();
  });

  it('lists devices by model with their position', async () => {
    const user = userEvent.setup();
    handlers();
    renderPage();

    await user.click(await screen.findByText('A 机房'));
    await user.click(await screen.findByRole('button', { name: '打开机柜 R-A01' }));
    const drawer = await screen.findByRole('dialog');
    await user.click(within(drawer).getByRole('tab', { name: '设备列表' }));
    expect(await within(drawer).findByRole('columnheader', { name: '起始 U' })).toBeInTheDocument();
    expect(within(drawer).getByText('服务器')).toBeInTheDocument();
    expect(within(drawer).getByText('2U')).toBeInTheDocument();
  });

  it('mounts a device from an empty unit and omits a blank height', async () => {
    const user = userEvent.setup();
    handlers();
    const mounted: unknown[] = [];
    server.use(
      http.post('/api/v1/cmdb/dcim/server-rooms/3/racks/31/devices/55', async ({ request }) => {
        mounted.push(await request.json());
        return HttpResponse.json({ rack_id: 31, ci_id: 55, u_count: 2, free_u_count: 24 });
      }),
    );
    renderPage();

    await user.click(await screen.findByText('A 机房'));
    await user.click(await screen.findByRole('button', { name: '打开机柜 R-A01' }));
    const drawer = await screen.findByRole('dialog');
    const gaps = await within(drawer).findAllByRole('button', { name: /上架设备/ });
    await user.click(gaps[0]);

    const dialogs = await screen.findAllByRole('dialog');
    const modal = dialogs[dialogs.length - 1];
    await user.click(within(modal).getByRole('button', { name: '选择设备' }));
    await user.click(await screen.findByRole('radio', { name: 'srv-01' }));
    const start = within(modal).getByLabelText('起始 U 位');
    await user.clear(start);
    await user.type(start, '5');
    // Picking a device fills its own height, as cantor did. Clearing the box is
    // "do not mention it", which the server reads as "use the device's height".
    const units = within(modal).getByLabelText(/高度/);
    expect(units).toHaveValue(2);
    await user.clear(units);
    await user.click(within(modal).getByRole('button', { name: '上架' }));

    await waitFor(() => expect(mounted).toHaveLength(1));
    expect(mounted[0]).toEqual({ u_start: 5 });
    expect(await screen.findByText(/机柜剩余 24U/)).toBeInTheDocument();
  });

  it('moves a device within the rack and can migrate it to another one', async () => {
    const user = userEvent.setup();
    handlers();
    const moved: unknown[] = [];
    server.use(
      http.put('/api/v1/cmdb/dcim/server-rooms/3/racks/31/devices/55', async ({ request }) => {
        moved.push(await request.json());
        return HttpResponse.json({ rack_id: 31, ci_id: 55, u_count: 2, free_u_count: 30 });
      }),
    );
    renderPage();

    await user.click(await screen.findByText('A 机房'));
    await user.click(await screen.findByRole('button', { name: '打开机柜 R-A01' }));
    const drawer = await screen.findByRole('dialog');
    await user.click((await within(drawer).findAllByRole('button', { name: '移动 srv-01' }))[0]);

    let dialogs = await screen.findAllByRole('dialog');
    let modal = dialogs[dialogs.length - 1];
    let start = within(modal).getByLabelText('目标起始 U 位');
    await user.clear(start);
    await user.type(start, '10');
    await user.click(within(modal).getByRole('button', { name: '移动' }));
    await waitFor(() => expect(moved).toEqual([{ to_u_start: 10 }]));

    await user.click((await within(drawer).findAllByRole('button', { name: '迁移 srv-01' }))[0]);
    dialogs = await screen.findAllByRole('dialog');
    modal = dialogs[dialogs.length - 1];
    await selectOption(within(modal).getByLabelText('目标机柜'), 'R-A02');
    start = within(modal).getByLabelText('目标起始 U 位');
    await user.clear(start);
    await user.type(start, '3');
    await user.click(within(modal).getByRole('button', { name: '迁移' }));
    await waitFor(() => expect(moved[1]).toEqual({ to_rack_id: 32, to_u_start: 3 }));
  });

  it('opens the abnormal dialog for overlapping devices', async () => {
    const user = userEvent.setup();
    handlers({
      devices: {
        numfound: 2,
        total: 2,
        page: 1,
        result: [
          { _id: 55, _type: 5, ci_id: 55, ci_type: 'server', ci_type_alias: '服务器', name: 'srv-01', u_start: 2, u_count: 2 },
          { _id: 56, _type: 5, ci_id: 56, ci_type: 'server', ci_type_alias: '服务器', name: 'srv-02', u_start: 3, u_count: 2 },
        ],
      },
    });
    renderPage();

    await user.click(await screen.findByText('A 机房'));
    await user.click(await screen.findByRole('button', { name: '打开机柜 R-A01' }));
    const drawer = await screen.findByRole('dialog');
    await user.click((await within(drawer).findAllByRole('button', { name: /U 位异常/ }))[0]);
    expect(await screen.findByText('这些设备占用了同一个 U 位。选择一台调整位置，服务端会重新校验。')).toBeInTheDocument();
    expect(screen.getByText(/srv-01、srv-02/)).toBeInTheDocument();
  });
});

describe('writing the tree', () => {
  it('creates a region through the model’s own attributes', async () => {
    const user = userEvent.setup();
    handlers();
    const created: unknown[] = [];
    server.use(
      http.post('/api/v1/cmdb/dcim/region', async ({ request }) => {
        created.push(await request.json());
        return HttpResponse.json({ ci_id: 90 }, { status: 201 });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: '新建' }));
    await user.click(await screen.findByRole('menuitem', { name: '新建区域' }));
    const modal = await screen.findByRole('dialog');
    await user.type(within(modal).getByLabelText(/名称/), '华南');
    await user.click(within(modal).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual({ name: '华南' });
  });

  it('edits a room and deletes it through the node endpoints', async () => {
    const user = userEvent.setup();
    handlers();
    const updated: unknown[] = [];
    let deleted = false;
    server.use(
      http.put('/api/v1/cmdb/dcim/server_room/3', async ({ request }) => {
        updated.push(await request.json());
        return HttpResponse.json({ ci_id: 3 });
      }),
      http.delete('/api/v1/cmdb/dcim/server_room/3', () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage();

    await user.click(await screen.findByText('A 机房'));
    await user.click(screen.getByRole('button', { name: '操作 A 机房' }));
    await user.click(await screen.findByRole('menuitem', { name: '编辑' }));
    const modal = await screen.findByRole('dialog');
    const name = within(modal).getByLabelText(/名称/);
    await user.clear(name);
    await user.type(name, 'B 机房');
    await user.click(within(modal).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(updated[0]).toMatchObject({ name: 'B 机房' }));

    await user.click(screen.getByRole('button', { name: '操作 A 机房' }));
    await user.click(await screen.findByRole('menuitem', { name: '删除' }));
    const confirm = await screen.findByRole('dialog');
    await user.click(within(confirm).getByRole('button', { name: '确认' }));
    await waitFor(() => expect(deleted).toBe(true));
  });

  it('hides writes from a viewer', async () => {
    const user = userEvent.setup();
    useAuth.setState({ token: null, role: 'viewer' });
    handlers();
    renderPage();

    await user.click(await screen.findByText('A 机房'));
    expect(await screen.findByText('R-A01')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新建机柜' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '操作 A 机房' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '打开机柜 R-A01' }));
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findAllByLabelText(/设备 srv-01/)).not.toHaveLength(0);
    expect(within(drawer).queryByRole('button', { name: '上架设备' })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: '编辑机柜' })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: /移动 srv-01/ })).not.toBeInTheDocument();
  });
});
