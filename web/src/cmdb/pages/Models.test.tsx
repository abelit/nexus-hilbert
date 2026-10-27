import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { server } from '@/test/msw-server';
import { selectOption } from '@/test/select-option';
import { useAuth } from '@/store/auth';
import ModelsPage from './Models';
import { ToastProvider } from '../components/Toast';

const models = [
  {
    id: 1,
    name: 'host',
    alias: '主机',
    enabled: true,
    is_attached: true,
    icon: '',
    order: 0,
    unique_key: 'hostname',
    parent_ids: [],
  },
  {
    id: 2,
    name: 'switch',
    alias: '交换机',
    enabled: false,
    is_attached: false,
    icon: '',
    order: 1,
    unique_key: 'hostname',
    parent_ids: [1],
  },
];

const attributes = [
  { id: 10, name: 'hostname', alias: '主机名', value_type: '2', is_list: false, is_index: true },
  { id: 11, name: 'cpu', alias: '核数', value_type: '0', is_list: false, is_index: true },
];

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ModelsPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  useAuth.setState({ token: null, role: 'admin' });
});

describe('the list', () => {
  it('draws the models and their navigation links', async () => {
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: models, total: models.length })),
      http.get('/api/v1/cmdb/attributes', () => HttpResponse.json({ items: attributes, total: attributes.length })),
    );
    renderPage();

    expect(await screen.findByRole('link', { name: '主机' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '交换机' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '主机' })).toHaveAttribute('href', '/cmdb/models/1');
    expect(screen.getByRole('link', { name: '交换机' })).toHaveAttribute('href', '/cmdb/models/2');
  });

  it('filters by name or alias without a request per keystroke', async () => {
    const user = userEvent.setup();
    let requests = 0;
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => {
        requests += 1;
        return HttpResponse.json({ items: models, total: models.length });
      }),
    );
    renderPage();

    await screen.findByRole('link', { name: '主机' });
    const before = requests;
    await user.type(screen.getByLabelText('搜索模型列表'), '交换');
    // THE LIST IS THE SCHEMA: a deployment has tens of models, so the filter runs
    // over the page's own rows rather than issuing a request per character.
    expect(requests).toBe(before);
    expect(screen.queryByRole('link', { name: '主机' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '交换机' })).toBeInTheDocument();
  });

  it('disables the writes for a non-administrator', async () => {
    useAuth.setState({ token: null, role: 'user' });
    server.use(http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: models, total: models.length })));
    renderPage();

    expect(await screen.findByRole('button', { name: /新建模型/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: '编辑 host' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '启用 switch' })).toBeDisabled();
  });

  it('offers the built-in bootstrap and reports what it did', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [], total: 0 })),
      http.post('/api/v1/cmdb/ci-types/builtin-models', () => HttpResponse.json({ created: ['dcim_rack'], existing: [] })),
    );
    renderPage();

    await screen.findByText('还没有模型。可以先创建内建模型，或新建一个。');
    await user.click(screen.getByRole('button', { name: /内建模型/ }));
    expect(await screen.findByText('已创建 1 个内建模型')).toBeInTheDocument();
  });
});

describe('creating a model', () => {
  it('requires an identifying attribute that already exists', async () => {
    const user = userEvent.setup();
    const posted: unknown[] = [];
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: models, total: models.length })),
      http.get('/api/v1/cmdb/attributes', () => HttpResponse.json({ items: attributes, total: attributes.length })),
      http.post('/api/v1/cmdb/ci-types', async ({ request }) => {
        posted.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ id: 3, ...(posted.at(-1) as object) }, { status: 201 });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: /新建模型/ }));
    await user.type(screen.getByLabelText('名称（唯一标识）'), 'database');
    await user.type(screen.getByLabelText('别名（显示名）'), '数据库');
    await user.click(screen.getByRole('button', { name: '保存' }));

    // THE BACKEND REFUSES A MODEL WHOSE `unique_key` NAMES NO ATTRIBUTE, so the
    // form refuses it first and says why.
    expect(await screen.findByRole('alert')).toHaveTextContent('标识属性');
    expect(posted).toHaveLength(0);
  });

  it('carries the display attribute, default sort and inherited parents on create', async () => {
    const user = userEvent.setup();
    const posted: Record<string, unknown>[] = [];
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [models[0]], total: 1 })),
      http.get('/api/v1/cmdb/attributes', () =>
        HttpResponse.json({
          items: [
            { id: 10, name: 'hostname', alias: '主机名', value_type: '2', is_list: false, is_index: true },
            { id: 11, name: 'cpu', alias: '核数', value_type: '0', is_list: false, is_index: true },
          ],
          total: 2,
        }),
      ),
      http.post('/api/v1/cmdb/ci-types', async ({ request }) => {
        posted.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ id: 3 }, { status: 201 });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: /新建模型/ }));
    await user.type(screen.getByLabelText('名称（唯一标识）'), 'database');
    await user.type(screen.getByLabelText('别名（显示名）'), '数据库');
    await selectOption(screen.getByLabelText('标识属性'), 'hostname（主机名）');
    await selectOption(screen.getByLabelText('展示属性'), '主机名（hostname）');
    await selectOption(screen.getByLabelText('默认排序列'), '主机名（hostname）');
    await selectOption(screen.getByLabelText('排序方向'), '降序');
    await user.click(screen.getByRole('checkbox', { name: '主机' }));
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      name: 'database',
      unique_key: 'hostname',
      show_key: 'hostname',
      default_order_attr: '-hostname',
      parent_ids: [1],
    });
  });

  it('creates the identifying attribute inline, then the model', async () => {
    const user = userEvent.setup();
    const createdAttributes: unknown[] = [];
    const createdModels: unknown[] = [];
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/attributes', () => HttpResponse.json({ items: [], total: 0 })),
      http.post('/api/v1/cmdb/attributes', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        createdAttributes.push(body);
        return HttpResponse.json({ id: 12, ...body }, { status: 201 });
      }),
      http.post('/api/v1/cmdb/ci-types', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        createdModels.push(body);
        return HttpResponse.json({ id: 3, ...body }, { status: 201 });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: /新建模型/ }));
    await user.type(screen.getByLabelText('名称（唯一标识）'), 'database');
    await user.type(screen.getByLabelText('别名（显示名）'), '数据库');

    // A FRESH DEPLOYMENT HAS NO ATTRIBUTES AT ALL, so without this the page would
    // be unusable the first time it is opened: no model means no place to add an
    // attribute, and no attribute means no model.
    await user.click(screen.getByRole('button', { name: '新建属性' }));
    await user.type(screen.getByLabelText('属性名'), 'db_name');
    await user.click(screen.getByRole('button', { name: '创建并选用' }));

    await waitFor(() => expect(createdAttributes).toHaveLength(1));
    expect(createdAttributes[0]).toMatchObject({ name: 'db_name', value_type: '2' });

    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(createdModels).toHaveLength(1));
    // THE INLINE ATTRIBUTE BECAME THE UNIQUE KEY, which is the only reason the
    // inline form exists.
    expect(createdModels[0]).toMatchObject({ name: 'database', alias: '数据库', unique_key: 'db_name' });
  });
});

describe('deleting', () => {
  it('asks first and says what the cascade removes', async () => {
    const user = userEvent.setup();
    let deleted = 0;
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: models, total: models.length })),
      http.delete('/api/v1/cmdb/ci-types/:id', () => {
        deleted += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: '删除 host' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/已存的值都会一起删除/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(deleted).toBe(0);

    await user.click(screen.getByRole('button', { name: '删除 host' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '确认' }));
    await waitFor(() => expect(deleted).toBe(1));
  });
});
