import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/test/msw-server';

import type { CIType, TypeAttribute } from '../../api/citype';
import { ToastProvider } from '../Toast';
import { InstanceDetailDrawer } from './InstanceDetailDrawer';

// THE GRAPH ITSELF IS COVERED BY InstanceTopology.test.tsx. Here the canvas is
// a set of switches, so the test is about what the drawer does with a reported
// target: switch the subject, keep the topology tab, and follow that subject's
// own model metadata.
vi.mock('./InstanceTopology', () => ({
  InstanceTopology: ({
    instanceLabel,
    onNavigate,
  }: {
    instanceLabel: string;
    onNavigate?: (target: { ciID: number; typeID: number }) => void;
  }) => (
    <div data-testid="instance-topology">
      <span>{instanceLabel}</span>
      <button type="button" onClick={() => onNavigate?.({ ciID: 6, typeID: 1 })}>
        打开同模型资源
      </button>
      <button type="button" onClick={() => onNavigate?.({ ciID: 7, typeID: 2 })}>
        打开其他模型资源
      </button>
      <button type="button" onClick={() => onNavigate?.({ ciID: 5, typeID: 1 })}>
        打开当前资源
      </button>
    </div>
  ),
}));

const attribute = (id: number, name: string, alias: string, extra: Partial<TypeAttribute> = {}): TypeAttribute =>
  ({
    id,
    name,
    alias,
    value_type: '2',
    is_choice: false,
    is_list: false,
    is_password: false,
    is_reference: false,
    is_computed: false,
    is_required: false,
    order: id,
    default_show: true,
    inherited: false,
    ...extra,
  }) as TypeAttribute;

const host: CIType = {
  id: 1,
  name: 'host',
  alias: '主机',
  enabled: true,
  is_attached: true,
  order: 0,
  unique_key: 'hostname',
  parent_ids: [],
};

const switchModel: CIType = { ...host, id: 2, name: 'switch', alias: '交换机' };

const hostAttributes = [
  attribute(10, 'hostname', '主机标识'),
  attribute(11, 'note', '备注'),
  attribute(12, 'environment', '环境', {
    is_choice: true,
    choice_value: [
      { value: 'prod', option: { label: '生产' } },
      { value: 'test', option: { label: '测试' } },
    ],
  }),
  attribute(13, 'secret', '密钥', { is_password: true }),
  attribute(14, 'serial', '序列号', { is_computed: true }),
  attribute(15, 'metadata', '元数据', { value_type: '6' }),
  attribute(16, 'data_status', '状态', {
    is_choice: true,
    choice_value: [{ value: 'active', option: { label: '使用中' } }],
  }),
];
const switchAttributes = [attribute(20, 'hostname', '设备名'), attribute(21, 'role', '角色')];

let instanceReads: number[] = [];
let writes: Array<{ id: number; body: unknown }> = [];
let failWrite: string | null = null;
let instanceValues: Record<number, Record<string, unknown>> = {};
let instanceMeta: Record<number, { updated_at?: string; updated_by?: string }> = {};

const INSTANCE_TYPES: Record<number, number> = { 5: 1, 6: 1, 7: 2 };

function mocks() {
  instanceReads = [];
  writes = [];
  failWrite = null;
  instanceValues = {
    5: {
      hostname: 'web-01',
      note: 'rack A',
      environment: 'test',
      serial: 'SN-5',
      metadata: { region: 'cn' },
      data_status: 'active',
    },
    6: { hostname: 'web-02', note: '' },
    7: { hostname: 'sw-01', role: 'core' },
  };
  instanceMeta = {
    5: { updated_at: '2026-06-01T11:01:04Z', updated_by: 'admin' },
  };
  server.use(
    http.get('/api/v1/cmdb/instances/:id', ({ params }) => {
      const id = Number(params.id);
      instanceReads.push(id);
      return HttpResponse.json({
        ci_id: id,
        type_id: INSTANCE_TYPES[id] ?? 1,
        ...instanceMeta[id],
        values: instanceValues[id] ?? {},
      });
    }),
    http.put('/api/v1/cmdb/instances/:id', async ({ request, params }) => {
      const id = Number(params.id);
      // The write body is flat: attribute names sit at the top level.
      const body = (await request.json()) as Record<string, unknown>;
      writes.push({ id, body });
      if (failWrite) {
        return HttpResponse.json({ message: failWrite }, { status: 400 });
      }
      instanceValues[id] = { ...(instanceValues[id] ?? {}), ...body };
      return HttpResponse.json({ ci_id: id, created: false });
    }),
    http.get('/api/v1/cmdb/ci-types/switch/attributes', () =>
      HttpResponse.json({ type_id: 2, unique_id: 20, unique: 'hostname', attributes: switchAttributes }),
    ),
    http.get('/api/v1/cmdb/ci-types/switch/attribute-groups', () => HttpResponse.json([])),
    http.get('/api/v1/cmdb/ci-types/:model/relation-parents', () => HttpResponse.json({ items: [], total: 0 })),
    http.get('/api/v1/cmdb/ci-types/:model/relation-children', () => HttpResponse.json({ items: [], total: 0 })),
    http.get('/api/v1/cmdb/ci-relations/search', () =>
      HttpResponse.json({ numfound: 0, total: 0, page: 1, result: [] }),
    ),
  );
}

function renderDrawer(
  onEdit = vi.fn(),
  initialTab: 'overview' | 'topology' = 'topology',
  onInstanceSaved = vi.fn(),
) {
  render(
    <ToastProvider>
      <InstanceDetailDrawer
        model={host}
        models={[host, switchModel]}
        attributes={hostAttributes}
        groups={[]}
        instanceID={5}
        initialTab={initialTab}
        onClose={() => undefined}
        onEdit={onEdit}
        onInstanceSaved={onInstanceSaved}
      />
    </ToastProvider>,
  );
  return { onEdit, onInstanceSaved };
}

beforeEach(() => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
});

describe('switching resources from the topology', () => {
  it('re-roots the drawer on a same-model node and keeps editing that model', async () => {
    const user = userEvent.setup();
    mocks();
    const { onEdit } = renderDrawer();

    const drawer = await screen.findByRole('dialog');
    const topology = await within(drawer).findByTestId('instance-topology');
    await waitFor(() => expect(topology).toHaveTextContent('web-01'));

    await user.click(within(drawer).getByRole('button', { name: '打开同模型资源' }));

    await waitFor(() => expect(within(drawer).getAllByText('web-02').length).toBeGreaterThan(0));
    expect(within(drawer).getByText('ID: 6')).toBeInTheDocument();
    // The topology tab stays active, the way cantor kept its topology tab.
    expect(within(drawer).getByRole('tab', { name: '拓扑' })).toHaveAttribute('aria-selected', 'true');

    await user.click(within(drawer).getByRole('button', { name: '编辑' }));
    expect(onEdit).toHaveBeenCalledWith(6);
    // Same model: the metadata already on screen is reused, not refetched.
    expect(instanceReads).toEqual([5, 6]);
  });

  it('resolves a cross-model node with its own model metadata', async () => {
    const user = userEvent.setup();
    mocks();
    const { onEdit } = renderDrawer();

    const drawer = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(within(drawer).getByTestId('instance-topology')).toHaveTextContent('web-01'),
    );

    await user.click(within(drawer).getByRole('button', { name: '打开其他模型资源' }));

    await waitFor(() => expect(within(drawer).getAllByText('sw-01').length).toBeGreaterThan(0));
    expect(within(drawer).getByText('ID: 7')).toBeInTheDocument();
    // The page's edit form belongs to the page's model, so a cross-model jump
    // is read-only rather than opening the wrong form.
    expect(within(drawer).queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    expect(onEdit).not.toHaveBeenCalled();

    await user.click(within(drawer).getByRole('tab', { name: '详情' }));
    expect(await within(drawer).findByText('设备名')).toBeInTheDocument();
    expect(within(drawer).getByText('core')).toBeInTheDocument();
    // The previous model's labels must not leak into the new subject.
    expect(within(drawer).queryByText('主机标识')).not.toBeInTheDocument();
  });

  it('ignores a double-click on the resource already shown', async () => {
    const user = userEvent.setup();
    mocks();
    renderDrawer();

    const drawer = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(within(drawer).getByTestId('instance-topology')).toHaveTextContent('web-01'),
    );

    await user.click(within(drawer).getByRole('button', { name: '打开当前资源' }));

    expect(within(drawer).getByTestId('instance-topology')).toHaveTextContent('web-01');
    expect(instanceReads).toEqual([5]);
  });
});

describe('the detail header', () => {
  it('shows the model, status and audit metadata around the name', async () => {
    mocks();
    renderDrawer(vi.fn(), 'overview');

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('ID: 5')).toBeInTheDocument();
    // The model is a tag next to the name, not the page title.
    expect(within(drawer).getByText('主机')).toBeInTheDocument();
    // The status the user asked to add to this layout.
    expect(within(drawer).getAllByText('使用中').length).toBeGreaterThan(0);
    expect(within(drawer).getByText(/更新时间:/)).toBeInTheDocument();
    expect(within(drawer).getByText('更新人: admin')).toBeInTheDocument();
  });

  it('frames the attributes with the same header as related resources', async () => {
    const user = userEvent.setup();
    mocks();
    renderDrawer(vi.fn(), 'overview');

    const drawer = await screen.findByRole('dialog');
    const heading = await within(drawer).findByRole('heading', { name: '属性' });
    const header = heading.closest('header');
    expect(header).not.toBeNull();
    if (!header) return;
    // Count and refresh live in the header, mirroring 关联关系.
    expect(within(header).getByText(String(hostAttributes.length))).toBeInTheDocument();
    const before = instanceReads.length;
    await user.click(within(header).getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(instanceReads.length).toBeGreaterThan(before));
  });
});

describe('editing a value in the detail view', () => {
  it('writes only the changed attribute and updates the drawer header', async () => {
    const user = userEvent.setup();
    mocks();
    const { onInstanceSaved } = renderDrawer(vi.fn(), 'overview');

    const drawer = await screen.findByRole('dialog');
    await user.click(await within(drawer).findByRole('button', { name: '编辑 主机标识' }));
    const input = within(drawer).getByRole('textbox', { name: '主机标识' });
    await user.clear(input);
    await user.type(input, 'web-09');
    // No Save button: Enter (or leaving the field) writes the value.
    await user.keyboard('{Enter}');

    await waitFor(() => expect(writes).toHaveLength(1));
    // A SINGLE-ATTRIBUTE WRITE: the other fields are not resent, so a stale
    // detail view cannot overwrite a change made elsewhere.
    expect(writes[0]).toEqual({ id: 5, body: { hostname: 'web-09' } });
    expect(await screen.findByText('已保存')).toBeInTheDocument();
    // The list behind the drawer refreshes through this callback.
    expect(onInstanceSaved).toHaveBeenCalledWith(5);
    // The header reads the same instance state, so the display name follows.
    expect(await within(drawer).findByRole('heading', { name: 'web-09' })).toBeInTheDocument();
  });

  it('edits a choice by its configured label', async () => {
    const user = userEvent.setup();
    mocks();
    renderDrawer(vi.fn(), 'overview');

    const drawer = await screen.findByRole('dialog');
    await user.click(await within(drawer).findByRole('button', { name: '编辑 环境' }));
    await user.click(within(drawer).getByRole('combobox', { name: '环境' }));
    await user.click(await screen.findByRole('option', { name: '生产' }));

    // A choice writes on selection, not on a second confirmation.
    await waitFor(() => expect(writes).toHaveLength(1));
    // THE CODE IS THE WIRE VALUE; the label was only what the operator read.
    expect(writes[0]).toEqual({ id: 5, body: { environment: 'prod' } });
  });

  it('refuses malformed JSON before it reaches the API and sends valid JSON as an object', async () => {
    const user = userEvent.setup();
    mocks();
    renderDrawer(vi.fn(), 'overview');

    const drawer = await screen.findByRole('dialog');
    await user.click(await within(drawer).findByRole('button', { name: '编辑 元数据' }));
    const area = within(drawer).getByRole('textbox', { name: '元数据' });
    fireEvent.change(area, { target: { value: 'not json' } });
    await user.tab();

    expect(within(drawer).getByRole('alert')).toHaveTextContent('JSON 格式无效');
    expect(writes).toHaveLength(0);

    await user.click(area);
    fireEvent.change(area, { target: { value: '{"b":2}' } });
    await user.tab();

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({ id: 5, body: { metadata: { b: 2 } } });
  });

  it('keeps the editor open with the backend message when a save is refused', async () => {
    const user = userEvent.setup();
    mocks();
    failWrite = '备注 不合法';
    renderDrawer(vi.fn(), 'overview');

    const drawer = await screen.findByRole('dialog');
    await user.click(await within(drawer).findByRole('button', { name: '编辑 备注' }));
    const input = within(drawer).getByRole('textbox', { name: '备注' });
    await user.clear(input);
    await user.type(input, 'bad');
    await user.keyboard('{Enter}');

    expect(await within(drawer).findByRole('alert')).toHaveTextContent('备注 不合法');
    // The draft survives: a refused save must not make the operator retype it.
    expect(within(drawer).getByRole('textbox', { name: '备注' })).toHaveValue('bad');
  });

  it('discards the draft on Escape and does not write', async () => {
    const user = userEvent.setup();
    mocks();
    renderDrawer(vi.fn(), 'overview');

    const drawer = await screen.findByRole('dialog');
    await user.click(await within(drawer).findByRole('button', { name: '编辑 备注' }));
    const input = within(drawer).getByRole('textbox', { name: '备注' });
    await user.clear(input);
    await user.type(input, 'discard me');
    await user.keyboard('{Escape}');

    expect(within(drawer).queryByRole('textbox', { name: '备注' })).not.toBeInTheDocument();
    expect(writes).toHaveLength(0);
    // Escape cancels the row, not the whole drawer.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(drawer).getByText('rack A')).toBeInTheDocument();
  });

  it('closes an untouched field without writing when focus leaves', async () => {
    const user = userEvent.setup();
    mocks();
    renderDrawer(vi.fn(), 'overview');

    const drawer = await screen.findByRole('dialog');
    await user.click(await within(drawer).findByRole('button', { name: '编辑 备注' }));
    await user.tab();

    expect(writes).toHaveLength(0);
    expect(within(drawer).queryByRole('textbox', { name: '备注' })).not.toBeInTheDocument();
  });

  it('does not offer inline editing for secrets or computed attributes', async () => {
    mocks();
    renderDrawer(vi.fn(), 'overview');

    const drawer = await screen.findByRole('dialog');
    await within(drawer).findByText('密钥');
    expect(within(drawer).queryByRole('button', { name: '编辑 密钥' })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: '编辑 序列号' })).not.toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: '编辑 主机标识' })).toBeInTheDocument();
  });
});
