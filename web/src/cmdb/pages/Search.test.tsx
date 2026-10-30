import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { server } from '@/test/msw-server';
import { useAuth } from '@/store/auth';
import SearchPage from './Search';
import { ToastProvider } from '../components/Toast';

const host = { id: 1, name: 'host', alias: '主机', enabled: true, is_attached: true, icon: '', order: 0, unique_key: 'hostname', parent_ids: [] };
const networkSwitch = { id: 2, name: 'switch', alias: '交换机', enabled: true, is_attached: true, icon: '', order: 1, unique_key: 'name', parent_ids: [] };

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

function renderPage(entry = '/cmdb/search?type=host') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ToastProvider>
        <SearchPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

function handlers(searchBody: object = { numfound: 2, total: 2, page: 1, counter: {}, result: [] }) {
  server.use(
    http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [host, networkSwitch], total: 2 })),
    http.get('/api/v1/cmdb/ci-types/host/attributes', () =>
      HttpResponse.json({
        type_id: 1,
        unique_id: 10,
        unique: 'hostname',
        attributes: [attribute(10, 'hostname'), attribute(11, 'cpu', { value_type: '0' }), attribute(12, 'root_password', { is_password: true })],
      }),
    ),
    http.get('/api/v1/cmdb/ci-types/switch/attributes', () =>
      HttpResponse.json({
        type_id: 2,
        unique_id: 20,
        unique: 'name',
        attributes: [attribute(20, 'name'), attribute(21, 'role')],
      }),
    ),
    http.get('/api/v1/cmdb/attributes', () =>
      HttpResponse.json({ items: [attribute(10, 'hostname')], total: 1, page: 1, page_size: 20 }),
    ),
    http.get('/api/v1/cmdb/preferences/saved-searches', () =>
      HttpResponse.json({ items: [], total: 0 }),
    ),
    http.post('/api/v1/cmdb/preferences/saved-searches', () =>
      HttpResponse.json({ id: 99, name: '__recent__', option: {} }),
    ),
    http.post('/api/v1/cmdb/ci/s', () => HttpResponse.json(searchBody)),
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  useAuth.setState({ token: null, role: 'admin' });
});

describe('the expression', () => {
  it('composes the model restriction with the operator filter and shows what is sent', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    handlers();
    server.use(
      http.post('/api/v1/cmdb/ci/s', async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json({ numfound: 0, total: 0, page: 1, counter: {}, result: [] });
      }),
    );
    renderPage();

    // THE FIRST RUN IS THE MODEL RESTRICTION ALONE.
    await waitFor(() => expect(sent).toHaveLength(1));
    expect((sent[0] as { q: string }).q).toBe('_type:host');

    await user.type(screen.getByLabelText('筛选表达式'), 'cpu:>4');
    await user.click(screen.getByRole('button', { name: '搜索' }));

    await waitFor(() => expect(sent).toHaveLength(2));
    expect((sent[1] as { q: string }).q).toBe('_type:host,cpu:>4');
    // WHAT IS SENT IS ON SCREEN, because "I picked a model" and "my filter" are
    // two different things and both have to be visible.
    expect(screen.getByText('_type:host,cpu:>4')).toBeInTheDocument();
  });

  it('needs no model restriction when every model is selected', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    handlers();
    server.use(
      http.post('/api/v1/cmdb/ci/s', async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json({ numfound: 0, total: 0, page: 1, counter: {}, result: [] });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: '选择模型' }));
    await user.click(screen.getByRole('checkbox', { name: '全部模型' }));
    await user.click(screen.getByRole('button', { name: '完成' }));
    await user.type(screen.getByLabelText('筛选表达式'), 'hostname:web*');
    await user.click(screen.getByRole('button', { name: '搜索' }));

    await waitFor(() => expect(sent.length).toBeGreaterThan(1));
    expect((sent.at(-1) as { q: string }).q).toBe('hostname:web*');
  });

  it('combines a keyword with the model scope', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    handlers();
    server.use(
      http.post('/api/v1/cmdb/ci/s', async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json({ numfound: 0, total: 0, page: 1, counter: {}, result: [] });
      }),
    );
    renderPage();
    await waitFor(() => expect(sent).toHaveLength(1));

    await user.type(screen.getByLabelText('搜索关键词'), 'web');
    await user.click(screen.getByRole('button', { name: '搜索' }));

    await waitFor(() => expect(sent.length).toBeGreaterThan(1));
    const body = sent.at(-1) as { q: string; facet?: string[] };
    expect(body.q).toBe('_type:host,*web*');
    // `_type` is not a facetable attribute; asking for it would fail the whole
    // search. The page must not send it.
    expect(body.facet ?? []).toEqual([]);
  });

  it('selects several models with the grouped picker', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    handlers();
    server.use(
      http.post('/api/v1/cmdb/ci/s', async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json({ numfound: 0, total: 0, page: 1, counter: {}, result: [] });
      }),
    );
    renderPage();
    await waitFor(() => expect(sent).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: '选择模型' }));
    await user.click(screen.getByRole('checkbox', { name: '交换机' }));
    await user.click(screen.getByRole('button', { name: '完成' }));
    await user.click(screen.getByRole('button', { name: '搜索' }));

    await waitFor(() => expect(sent.length).toBeGreaterThan(1));
    expect((sent.at(-1) as { q: string }).q).toMatch(/^_type:\((?:host;switch|switch;host)\)$/);
  });

  it('does not offer a password attribute for matching', async () => {
    handlers();
    renderPage();

    await screen.findByLabelText('属性');
    // A FILTER ON A PASSWORD ATTRIBUTE WOULD BE A CREDENTIAL ORACLE: a caller who
    // cannot read secrets could still confirm one guess at a time. The backend
    // refuses it, so the builder does not offer it.
    expect(screen.queryByRole('option', { name: 'root_password' })).not.toBeInTheDocument();
  });
});

describe('the results', () => {
  it('derives its columns from the rows, because a search spans models', async () => {
    handlers({
      numfound: 2,
      total: 2,
      page: 1,
      counter: { host: 2 },
      result: [
        { _id: 1, _type: 1, ci_id: 1, ci_type: 'host', ci_type_alias: '主机', hostname: 'web-01', cpu: 8 },
        { _id: 2, _type: 1, ci_id: 2, ci_type: 'host', ci_type_alias: '主机', hostname: 'web-02', cpu: 4 },
      ],
    });
    renderPage();

    expect(await screen.findByText('web-01')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'hostname' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'cpu' })).toBeInTheDocument();
    // THE METADATA KEYS ARE NOT COLUMNS OF THEIR OWN beyond the ones the page
    // renders deliberately.
    expect(screen.queryByRole('columnheader', { name: '_type' })).not.toBeInTheDocument();
  });

  it('applies a saved search', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    handlers();
    server.use(
      http.get('/api/v1/cmdb/preferences/saved-searches', () =>
        HttpResponse.json({
          items: [{ id: 7, name: '最近主机', option: { keyword: 'web', types: ['host'] } }],
          total: 1,
        }),
      ),
      http.post('/api/v1/cmdb/ci/s', async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json({ numfound: 0, total: 0, page: 1, counter: {}, result: [] });
      }),
    );
    renderPage();
    await waitFor(() => expect(sent).toHaveLength(1));

    await user.click(await screen.findByRole('button', { name: '最近主机' }));
    await waitFor(() => expect(sent.length).toBeGreaterThan(1));
    expect((sent.at(-1) as { q: string }).q).toBe('_type:host,*web*');
  });

  it('saves the current search as a reusable preset', async () => {
    const user = userEvent.setup();
    let posted: unknown;
    handlers();
    server.use(
      http.post('/api/v1/cmdb/preferences/saved-searches', async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ id: 9, name: '我的主机', option: {} });
      }),
    );
    renderPage();
    await screen.findByRole('button', { name: '保存搜索' });

    await user.click(screen.getByRole('button', { name: '保存搜索' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('名称'), '我的主机');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(posted).toMatchObject({
        name: '我的主机',
        type_id: 1,
        option: { keyword: '', q: '', types: ['host'] },
      }),
    );
  });

  it('opens a cross-model result in the shared detail drawer', async () => {
    const user = userEvent.setup();
    handlers({
      numfound: 1,
      total: 1,
      page: 1,
      counter: { host: 1 },
      result: [
        { _id: 1, _type: 1, ci_id: 1, ci_type: 'host', ci_type_alias: '主机', unique: 'hostname', hostname: 'web-01' },
      ],
    });
    server.use(
      http.get('/api/v1/cmdb/ci-types/host/attribute-groups', () => HttpResponse.json([])),
      http.get('/api/v1/cmdb/instances/1', () =>
        HttpResponse.json({ ci_id: 1, type_id: 1, values: { hostname: 'web-01' } }),
      ),
      http.get('/api/v1/cmdb/instances/1/files', () => HttpResponse.json({ values: {} })),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: '查看资源 1' }));
    await screen.findByRole('tab', { name: '变更历史' });
    expect(screen.getAllByText('web-01').length).toBeGreaterThan(0);
  });

  it('distinguishes a filter that matched nothing from no filter at all', async () => {
    handlers({ numfound: 0, total: 0, page: 1, counter: {}, result: [] });
    const { unmount } = renderPage('/cmdb/search');
    unmount();

    renderPage('/cmdb/search?type=host&q=hostname:nope');
    expect(await screen.findByText('没有匹配的资源')).toBeInTheDocument();
  });
});
