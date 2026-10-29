import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { server } from '@/test/msw-server';
import { useAuth } from '@/store/auth';
import SubscriptionsPage, { buildSubscriptionSections, subscriptionDragPlan } from './Subscriptions';
import { ToastProvider } from '../components/Toast';

const host = {
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

const switchModel = { ...host, id: 2, name: 'switch', alias: '交换机', unique_key: 'name' };
const idcModel = { ...host, id: 3, name: 'idc', alias: '机房', unique_key: 'name' };
const routerModel = { ...host, id: 4, name: 'router', alias: '路由器', unique_key: 'name' };

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
  storage_table: 'c_value_index_texts',
  is_unique: id === 10,
  ...extra,
});

const attributes = [attribute(10, 'hostname'), attribute(11, 'cpu')];

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <SubscriptionsPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

function baseHandlers() {
  server.use(
    // CMDBIcon loads the sprite once per module; an empty response keeps the
    // fallback glyph and satisfies MSW's error-on-unhandled policy.
    http.get('/cmdb/cmdb-icons.json', () => HttpResponse.json({})),
    http.get('/api/v1/cmdb/preferences/ci-types', () =>
      HttpResponse.json({
        groups: [{ id: 1, name: '硬件', ci_types: [host], is_other: false }],
        type_ids: [1],
        subscribed_at: { '1': '2026-10-01T00:00:00Z' },
      }),
    ),
    // An absent rule is `{}`, not a disabled one: the console then opens the
    // editor with its own defaults.
    http.get('/api/v1/cmdb/preferences/auto-subscription', () => HttpResponse.json({})),
    http.get('/api/v1/cmdb/preferences/model-groups', () =>
      HttpResponse.json({ items: [{ id: 1, name: '硬件', ci_types: [host], is_other: false }], total: 1 }),
    ),
    http.get('/api/v1/cmdb/preferences/tree-levels', () => HttpResponse.json([])),
    http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [host, switchModel, idcModel], total: 3 })),
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  useAuth.setState({ token: null, role: 'user' });
});

describe('the subscription page', () => {
  it('shows the operator’s subscriptions beside the grouped catalogue', async () => {
    baseHandlers();
    renderPage();

    expect(await screen.findByRole('heading', { name: '我的订阅' })).toBeInTheDocument();
    expect(screen.getByText('资源数据订阅')).toBeInTheDocument();
    expect(screen.getByText('资源层级订阅')).toBeInTheDocument();
    expect(screen.getAllByText('主机').length).toBeGreaterThan(0);
    expect(screen.getByText('交换机')).toBeInTheDocument();
    // The unsubscribed model offers the one-click action; the subscribed one
    // offers editing instead.
    expect(screen.getByRole('button', { name: '数据订阅 switch' })).toBeInTheDocument();
    // Both panes offer the editor for a subscribed model.
    expect(screen.getAllByRole('button', { name: '编辑 host 的列' }).length).toBeGreaterThan(0);
  });

  it('subscribes to the default-show attributes, pinning the identifier', async () => {
    const user = userEvent.setup();
    baseHandlers();
    let put: unknown = null;
    server.use(
      http.get('/api/v1/cmdb/ci-types/2/attributes', () =>
        HttpResponse.json({
          type_id: 2,
          unique_id: 20,
          unique: 'name',
          attributes: [
            attribute(20, 'name', { is_unique: true }),
            attribute(21, 'ip'),
            attribute(22, 'secret', { default_show: false }),
          ],
        }),
      ),
      http.put('/api/v1/cmdb/preferences/ci-types/2/fields', async ({ request }) => {
        put = await request.json();
        return HttpResponse.json({ type_id: 2, is_subscribed: true, fields: [] });
      }),
    );

    renderPage();
    await user.click(await screen.findByRole('button', { name: '数据订阅 switch' }));

    await waitFor(() => expect(put).not.toBeNull());
    expect(put).toEqual({
      fields: [
        { ref: '20', is_fixed: true },
        { ref: '21', is_fixed: false },
      ],
    });
  });

  it('edits a model’s columns through the two-column transfer', async () => {
    const user = userEvent.setup();
    baseHandlers();
    let put: unknown = null;
    server.use(
      http.get('/api/v1/cmdb/ci-types/1/attributes', () =>
        HttpResponse.json({ type_id: 1, unique_id: 10, unique: 'hostname', attributes }),
      ),
      http.get('/api/v1/cmdb/preferences/ci-types/1/fields', () =>
        HttpResponse.json({ type_id: 1, is_subscribed: true, fields: [{ attr_id: 10, is_fixed: true }] }),
      ),
      http.put('/api/v1/cmdb/preferences/ci-types/1/fields', async ({ request }) => {
        put = await request.json();
        return HttpResponse.json({ type_id: 1, is_subscribed: true, fields: [] });
      }),
    );

    renderPage();
    const editButtons = await screen.findAllByRole('button', { name: '编辑 host 的列' });
    await user.click(editButtons[0]);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/订阅设置/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('checkbox', { name: 'cpu' }));
    await user.click(within(dialog).getByRole('button', { name: '移入已选' }));
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(put).not.toBeNull());
    expect(put).toEqual({
      fields: [
        { ref: '10', is_fixed: true },
        { ref: '11', is_fixed: false },
      ],
    });
  });

  it('removes a column subscription through DELETE, after confirmation', async () => {
    const user = userEvent.setup();
    baseHandlers();
    let deleted = false;
    server.use(
      http.delete('/api/v1/cmdb/preferences/ci-types/1/fields', () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderPage();
    const buttons = await screen.findAllByRole('button', { name: '取消 host 的数据订阅' });
    await user.click(buttons[0]);

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '确认' }));

    await waitFor(() => expect(deleted).toBe(true));
  });

  it('shows subscriptions under their group with drag handles', async () => {
    baseHandlers();
    renderPage();

    expect((await screen.findAllByText('硬件')).length).toBeGreaterThan(0);
    expect(await screen.findByRole('button', { name: '拖动分组 硬件' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拖动模型 host' })).toBeInTheDocument();
  });

  it('offers drag handles for hierarchy subscriptions, like the column list', async () => {
    baseHandlers();
    const level = (typeID: number, name: string, alias: string) => ({
      id: typeID + 100,
      type_id: typeID,
      name,
      alias,
      levels: [attributes[0]],
    });
    server.use(
      http.get('/api/v1/cmdb/preferences/ci-types', () =>
        HttpResponse.json({ groups: [], type_ids: [] }),
      ),
      http.get('/api/v1/cmdb/preferences/tree-levels', () =>
        HttpResponse.json([level(1, 'host', '主机'), level(3, 'idc', '机房')]),
      ),
    );

    renderPage();
    expect(await screen.findByRole('button', { name: '拖动层级 host' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拖动层级 idc' })).toBeInTheDocument();
    // The old up/down controls are gone; the grip and its keyboard sensor
    // replace them in both subscription lists.
    expect(screen.queryByRole('button', { name: '下移 主机' })).not.toBeInTheDocument();
  });

  it('switches the model catalogue between list and grid modes', async () => {
    const user = userEvent.setup();
    baseHandlers();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '网格视图' }));
    // The same model now renders as a card heading rather than a list row,
    // and keeps the same subscription action.
    expect(await screen.findByRole('heading', { name: '主机' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑 host 的订阅' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '网格视图' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: '列表视图' }));
    expect(screen.queryByRole('heading', { name: '主机' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '列表视图' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('defaults a new auto-subscription rule to every model, including future ones', async () => {
    const user = userEvent.setup();
    baseHandlers();
    let put: unknown = null;
    server.use(
      http.put('/api/v1/cmdb/preferences/auto-subscription', async ({ request }) => {
        put = await request.json();
        return HttpResponse.json({ enabled: true, base_strategy: 'all', group_ids: [], type_ids: [], description: '' });
      }),
    );

    renderPage();
    await user.click(await screen.findByRole('button', { name: /自动订阅/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('订阅所有模型，排除所选')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(put).not.toBeNull());
    expect(put).toEqual({
      enabled: true,
      base_strategy: 'all',
      group_ids: [],
      type_ids: [],
      description: '',
    });
  });

  it('keeps an existing selective rule selective and hides manual removal', async () => {
    const user = userEvent.setup();
    baseHandlers();
    server.use(
      http.get('/api/v1/cmdb/preferences/auto-subscription', () =>
        HttpResponse.json({
          base_strategy: 'none',
          group_ids: [1],
          type_ids: [2],
          enabled: true,
          description: '只订阅硬件',
        }),
      ),
    );
    let put: unknown = null;
    server.use(
      http.put('/api/v1/cmdb/preferences/auto-subscription', async ({ request }) => {
        put = await request.json();
        return HttpResponse.json({ enabled: true, base_strategy: 'none', group_ids: [1], type_ids: [2] });
      }),
    );

    renderPage();
    // A rule is authoritative, so the manual unsubscribe is not offered.
    expect(await screen.findByText('由自动订阅管理')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取消 host 的数据订阅' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /自动订阅/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('只订阅所选分组和模型')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(put).not.toBeNull());
    expect(put).toEqual({
      enabled: true,
      base_strategy: 'none',
      group_ids: [1],
      type_ids: [2],
      description: '只订阅硬件',
    });
  });

  it('is not admin-gated, because a subscription is per user', async () => {
    baseHandlers();
    useAuth.setState({ token: null, role: 'user' });
    renderPage();

    const editButtons = await screen.findAllByRole('button', { name: '编辑 host 的列' });
    expect(editButtons[0]).toBeEnabled();
  });
});

describe('subscription grouping and drag persistence', () => {
  const ipam = { ...host, id: 9, name: 'ipam_subnet', alias: '子网', unique_key: 'cidr' };

  it('orders groups by the earliest model in the operator order and filters IPAM', () => {
    const sections = buildSubscriptionSections(
      [
        { id: 1, name: '硬件', ci_types: [host, switchModel] },
        { id: 2, name: '网络', ci_types: [idcModel, switchModel] },
        { id: undefined, name: '', ci_types: [routerModel, ipam], is_other: true },
      ],
      [3, 2, 1, 4, 9],
    );

    expect(sections.map((section) => section.key)).toEqual(['g:2', 'g:1', 'other']);
    expect(sections[0].items.map((model) => model.id)).toEqual([3]);
    // A model that appears in two groups stays in the first one only.
    expect(sections[1].items.map((model) => model.id)).toEqual([2, 1]);
    expect(sections[2].items.map((model) => model.id)).toEqual([4]);
  });

  const sections = [
    { key: 'g:1', name: '硬件', groupID: 1, isOther: false, items: [host, switchModel] },
    { key: 'g:2', name: '网络', groupID: 2, isOther: false, items: [idcModel] },
    { key: 'other', name: '', groupID: null, isOther: true, items: [routerModel] },
  ];

  it('writes only the per-user order for a group drag or an in-group drag', () => {
    expect(subscriptionDragPlan({ type: 'group', groupKey: 'g:1' }, sections)).toEqual({
      order: [1, 2, 3, 4],
    });
    const reordered = [{ ...sections[0], items: [switchModel, host] }, sections[1], sections[2]];
    expect(subscriptionDragPlan({ type: 'item', groupKey: 'g:1', itemID: 1 }, reordered)).toEqual({
      order: [2, 1, 3, 4],
    });
  });

  it('writes the target group’s ordered membership for a cross-group move', () => {
    const moved = [
      { ...sections[0], items: [host] },
      { ...sections[1], items: [idcModel, switchModel] },
      sections[2],
    ];
    expect(subscriptionDragPlan({ type: 'item', groupKey: 'g:1', itemID: 2 }, moved)).toEqual({
      order: [1, 3, 2, 4],
      setMembers: { groupID: 2, typeIDs: [3, 2] },
    });
  });

  it('detaches from the source group when a model is dropped into 其他', () => {
    const moved = [
      { ...sections[0], items: [host] },
      sections[1],
      { ...sections[2], items: [routerModel, switchModel] },
    ];
    expect(subscriptionDragPlan({ type: 'item', groupKey: 'g:1', itemID: 2 }, moved)).toEqual({
      order: [1, 3, 4, 2],
      detachFrom: 1,
    });
  });

  it('adds a model from 其他 to the target group without a detach write', () => {
    const moved = [
      sections[0],
      { ...sections[1], items: [idcModel, routerModel] },
      { ...sections[2], items: [] },
    ];
    expect(subscriptionDragPlan({ type: 'item', groupKey: 'other', itemID: 4 }, moved)).toEqual({
      order: [1, 2, 3, 4],
      setMembers: { groupID: 2, typeIDs: [3, 4] },
    });
  });
});
