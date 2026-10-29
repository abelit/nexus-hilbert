import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { server } from '@/test/msw-server';
import { useAuth } from '@/store/auth';
import TreeViewsPage from './TreeViews';
import { ToastProvider } from '../components/Toast';

const attribute = (id: number, name: string, alias: string) => ({
  id,
  name,
  alias,
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
});

const idc = attribute(10, 'idc', '机房');
const rack = attribute(11, 'rack', '机柜');
const hostname = attribute(12, 'hostname', '主机名');

const hostModel = {
  id: 1,
  name: 'host',
  alias: '主机',
  enabled: true,
  is_attached: true,
  icon: '',
  order: 0,
  unique_key: 'hostname',
  show_name: 'hostname',
  parent_ids: [],
};

const switchModel = {
  ...hostModel,
  id: 2,
  name: 'switch',
  alias: '交换机',
  unique_key: 'name',
  show_name: 'name',
};

function baseHandlers() {
  server.use(
    // CMDBIcon loads the sprite once per module; an empty response keeps the
    // fallback glyph and satisfies MSW's error-on-unhandled policy.
    http.get('/cmdb/cmdb-icons.json', () => HttpResponse.json({})),
    http.get('/api/v1/cmdb/ci-types', () =>
      HttpResponse.json({ items: [hostModel], total: 1 }),
    ),
    http.get('/api/v1/cmdb/ci-types/host/attributes', () =>
      HttpResponse.json({
        type_id: 1,
        unique_id: 12,
        unique: 'hostname',
        attributes: [idc, rack, hostname],
      }),
    ),
    http.get('/api/v1/cmdb/ci-types/host/attribute-groups', () => HttpResponse.json([])),
    http.get('/api/v1/cmdb/preferences/ci-types/host/fields', () =>
      HttpResponse.json({
        type_id: 1,
        is_subscribed: true,
        fields: [
          { attr_id: 10, is_fixed: true },
          { attr_id: 11, is_fixed: false },
          { attr_id: 12, is_fixed: false },
        ],
      }),
    ),
  );
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <TreeViewsPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  useAuth.setState({ token: null, role: 'admin' });
});

describe('the tree views page', () => {
  it('lazy-loads facets and shows the instances at the selected path', async () => {
    baseHandlers();
    server.use(
      http.get('/api/v1/cmdb/preferences/tree-levels', () =>
        HttpResponse.json([
          { id: 7, type_id: 1, name: 'host', alias: '主机', levels: [idc, rack] },
        ]),
      ),
      http.post('/api/v1/cmdb/ci/s', async ({ request }) => {
        const body = (await request.json()) as { q: string; facet: string[] };
        if (body.facet?.[0] === 'idc') {
          return HttpResponse.json({
            numfound: 2,
            total: 0,
            page: 1,
            facet: { idc: [['A', 2, 'idc']] },
            result: [],
          });
        }
        if (body.facet?.[0] === 'rack') {
          return HttpResponse.json({
            numfound: 2,
            total: 0,
            page: 1,
            facet: { rack: [['R1', 2, 'rack']] },
            result: [],
          });
        }
        if (!body.q.includes('idc:A') || !body.q.includes('rack:R1')) {
          return HttpResponse.json({ numfound: 0, total: 0, page: 1, result: [] });
        }
        expect(body.q).toContain('idc:A');
        expect(body.q).toContain('rack:R1');
        return HttpResponse.json({
          numfound: 1,
          total: 1,
          page: 1,
          result: [
            {
              _id: 11,
              _type: 1,
              ci_id: 11,
              ci_type: 'host',
              ci_type_alias: '主机',
              unique: 'web-01',
              unique_alias: 'hostname',
              hostname: 'web-01',
              idc: 'A',
              rack: 'R1',
            },
          ],
        });
      }),
    );

    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /A/ }));
    await userEvent.click(await screen.findByRole('button', { name: /R1/ }));

    await waitFor(() => expect(screen.getByText('web-01')).toBeInTheDocument());
  });

  it('lists the subscribed views with drag handles and expands only the active one', async () => {
    baseHandlers();
    server.use(
      http.get('/api/v1/cmdb/ci-types', () =>
        HttpResponse.json({ items: [hostModel, switchModel], total: 2 }),
      ),
      http.get('/api/v1/cmdb/preferences/tree-levels', () =>
        HttpResponse.json([
          { id: 7, type_id: 1, name: 'host', alias: '主机', levels: [idc, rack] },
          { id: 8, type_id: 2, name: 'switch', alias: '交换机', levels: [idc] },
        ]),
      ),
      http.post('/api/v1/cmdb/ci/s', () =>
        HttpResponse.json({
          numfound: 2,
          total: 0,
          page: 1,
          facet: { idc: [['A', 2, 'idc']] },
          result: [],
        }),
      ),
    );
    renderPage();

    expect(await screen.findByRole('button', { name: '拖动层级 主机' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拖动层级 交换机' })).toBeInTheDocument();
    // The active view, and only it, expands a facet tree in the rail.
    expect(await screen.findAllByRole('button', { name: /^A/ })).toHaveLength(1);
  });

  it('combines the selected path and the search term in one server query', async () => {
    baseHandlers();
    const bodies: Array<{ q: string; facet?: string[] }> = [];
    server.use(
      http.get('/api/v1/cmdb/preferences/tree-levels', () =>
        HttpResponse.json([
          { id: 7, type_id: 1, name: 'host', alias: '主机', levels: [idc, rack] },
        ]),
      ),
      http.post('/api/v1/cmdb/ci/s', async ({ request }) => {
        const body = (await request.json()) as { q: string; facet?: string[] };
        bodies.push(body);
        if (body.facet?.[0] === 'idc') {
          return HttpResponse.json({
            numfound: 2,
            total: 0,
            page: 1,
            facet: { idc: [['A', 2, 'idc']] },
            result: [],
          });
        }
        if (body.facet?.[0] === 'rack') {
          return HttpResponse.json({
            numfound: 2,
            total: 0,
            page: 1,
            facet: { rack: [['R1', 2, 'rack']] },
            result: [],
          });
        }
        return HttpResponse.json({ numfound: 0, total: 0, page: 1, result: [] });
      }),
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /A/ }));
    await userEvent.click(await screen.findByRole('button', { name: /R1/ }));
    await userEvent.type(
      screen.getByRole('searchbox', { name: '在当前层级下搜索' }),
      'web{Enter}',
    );

    await waitFor(() =>
      expect(
        bodies.some(
          (body) =>
            body.facet?.length === 0 &&
            body.q.includes('idc:A') &&
            body.q.includes('rack:R1') &&
            body.q.includes('*web*'),
        ),
      ).toBe(true),
    );
  });

  it('shows choice labels and referenced instance names instead of stored codes', async () => {
    const sla = {
      ...attribute(20, 'sla', 'SLA'),
      value_type: '0',
      is_reference: true,
      reference_type_id: 97,
    };
    const level = {
      ...attribute(21, 'level', '等级'),
      is_choice: true,
      choice_value: [{ value: 'critical', option: { label: '关键' } }],
    };
    const slaModel = {
      ...hostModel,
      id: 97,
      name: 'sla',
      alias: 'SLA',
      show_name: 'alias',
      unique_key: 'uuid',
    };
    baseHandlers();
    server.use(
      http.get('/api/v1/cmdb/ci-types', () =>
        HttpResponse.json({ items: [hostModel, slaModel], total: 2 }),
      ),
      http.get('/api/v1/cmdb/ci-types/host/attributes', () =>
        HttpResponse.json({
          type_id: 1,
          unique_id: 20,
          unique: 'sla',
          attributes: [sla, level],
        }),
      ),
      http.get('/api/v1/cmdb/preferences/ci-types/host/fields', () =>
        HttpResponse.json({
          type_id: 1,
          is_subscribed: true,
          fields: [{ attr_id: 20, is_fixed: false }],
        }),
      ),
      http.get('/api/v1/cmdb/preferences/tree-levels', () =>
        HttpResponse.json([
          { id: 7, type_id: 1, name: 'host', alias: '主机', levels: [sla, level] },
        ]),
      ),
      http.post('/api/v1/cmdb/ci/s', async ({ request }) => {
        const body = (await request.json()) as { q: string; facet?: string[] };
        if (body.facet?.[0] === 'sla') {
          return HttpResponse.json({
            numfound: 31,
            total: 0,
            page: 1,
            facet: { sla: [[2352, 31, 'sla']] },
            result: [],
          });
        }
        if (body.facet?.[0] === 'level') {
          return HttpResponse.json({
            numfound: 5,
            total: 0,
            page: 1,
            facet: { level: [['critical', 5, 'level']] },
            result: [],
          });
        }
        if (body.q.startsWith('_id:')) {
          return HttpResponse.json({
            numfound: 1,
            total: 1,
            page: 1,
            result: [
              {
                _id: 2352,
                _type: 97,
                ci_id: 2352,
                ci_type: 'sla',
                ci_type_alias: 'SLA',
                unique: 'uuid',
                unique_alias: 'ID',
                name: 'gold',
                alias: '黄金',
                uuid: 'sla-uuid',
              },
            ],
          });
        }
        return HttpResponse.json({ numfound: 0, total: 0, page: 1, result: [] });
      }),
    );
    renderPage();

    // The stored reference id is replaced by the target model's display field,
    // and the raw value stays available in the tooltip.
    const gold = await screen.findByRole('button', { name: /黄金/ }, { timeout: 3000 });    expect(screen.queryByText('2352')).not.toBeInTheDocument();
    await userEvent.click(gold);

    // The breadcrumb uses the same resolved word, not the id.
    expect(await screen.findByRole('button', { name: /SLA:\s*黄金/ })).toBeInTheDocument();
    // A choice level maps its stored code to the configured label.
    expect(await screen.findByRole('button', { name: /关键/ })).toBeInTheDocument();
    expect(screen.queryByText('critical')).not.toBeInTheDocument();
  });

  it('cancels a hierarchy subscription after confirmation', async () => {
    baseHandlers();
    let put: unknown = null;
    server.use(
      http.get('/api/v1/cmdb/preferences/tree-levels', () =>
        HttpResponse.json([
          { id: 7, type_id: 1, name: 'host', alias: '主机', levels: [idc, rack] },
        ]),
      ),
      http.put('/api/v1/cmdb/preferences/ci-types/1/tree-levels', async ({ request }) => {
        put = await request.json();
        return HttpResponse.json({ id: 7, type_id: 1, name: 'host', alias: '主机', levels: [] });
      }),
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: '取消 主机 的层级订阅' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: '确认' }));

    await waitFor(() => expect(put).toEqual({ levels: [] }));
  });

  it('links to preferences when no tree view exists', async () => {
    baseHandlers();
    server.use(
      http.get('/api/v1/cmdb/preferences/tree-levels', () => HttpResponse.json([])),
    );
    renderPage();

    expect(await screen.findByText('还没有可用的层级视图')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '去我的订阅' })).toHaveAttribute('href', '/cmdb/preferences');
  });
});
