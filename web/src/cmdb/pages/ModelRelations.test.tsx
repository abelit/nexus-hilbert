import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { server } from '@/test/msw-server';
import { selectOption } from '@/test/select-option';
import { useAuth } from '@/store/auth';
import ModelRelationsPage from './ModelRelations';
import { ToastProvider } from '../components/Toast';

const host = { id: 1, name: 'host', alias: '主机', enabled: true, is_attached: true, icon: '', order: 0, unique_key: 'hostname', parent_ids: [] };
const disk = { id: 2, name: 'disk', alias: '磁盘', enabled: true, is_attached: true, icon: '', order: 1, unique_key: 'sn', parent_ids: [] };
const rack = { id: 3, name: 'rack', alias: '机柜', enabled: true, is_attached: true, icon: '', order: 2, unique_key: 'name', parent_ids: [] };

const related = (type: typeof host, constraint: string) => ({
  ctr_id: 1,
  type,
  attributes: [],
  relation_type: { id: 1, name: '包含', color: '#6366f1' },
  constraint,
  parent_attr_ids: [],
  child_attr_ids: [],
});

const relations = [
  { id: 11, parent: related(host, '0'), child: related(disk, '0') },
  { id: 12, parent: related(rack, '0'), child: related(host, '0') },
];

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ModelRelationsPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  useAuth.setState({ token: null, role: 'admin' });
});

describe('the flat relation list', () => {
  it('draws every parent → child pair as one row', async () => {
    server.use(http.get('/api/v1/cmdb/ci-type-relations', () => HttpResponse.json({ items: relations, total: relations.length })));
    renderPage();

    // `主机` APPEARS TWICE — once as a parent and once as a child — which is
    // exactly what a flat pair list is for.
    expect(await screen.findAllByRole('link', { name: '主机' })).toHaveLength(2);
    expect(screen.getByRole('link', { name: '磁盘' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '机柜' })).toBeInTheDocument();
    // TWO EDGES, so the parent and the child are columns rather than a tree: a
    // tree would hide that `host` is a child of one model and a parent of
    // another.
    expect(screen.getAllByText('包含')).toHaveLength(2);
    // The API stores cantor's codes; the console labels them.
    expect(screen.getAllByText('一对多')).toHaveLength(2);
  });

  it('shows the attribute association in the row', async () => {
    const attr = (id: number, name: string, alias: string) => ({
      id, name, alias, value_type: '2', is_choice: false, is_list: false, is_unique: false,
      is_index: true, is_indexed: true, is_password: false, is_sortable: false, is_dynamic: false,
      is_bool: false, is_file: false, is_reference: false, is_computed: false,
      has_compute_script: false, has_choice_web_hook: false, has_choice_other: false,
      storage_table: 'c_value_index_texts', is_required: false, order: id,
      default_show: true, inherited: false,
    });
    const mapped = {
      id: 13,
      parent: {
        ...related(host, '0'),
        attributes: [attr(10, 'hostname', '主机名')],
        parent_attr_ids: [10],
        child_attr_ids: [20],
      },
      child: {
        ...related(disk, '0'),
        attributes: [attr(20, 'sn', '序列号')],
        parent_attr_ids: [10],
        child_attr_ids: [20],
      },
    };
    server.use(http.get('/api/v1/cmdb/ci-type-relations', () => HttpResponse.json({ items: [mapped], total: 1 })));
    renderPage();

    expect(await screen.findByRole('columnheader', { name: '属性关联' })).toBeInTheDocument();
    expect(screen.getByText('主机名 → 序列号')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('filters by either side of the pair', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/v1/cmdb/ci-type-relations', () => HttpResponse.json({ items: relations, total: relations.length })));
    renderPage();

    await screen.findAllByRole('link', { name: '主机' });
    await user.type(screen.getByLabelText('搜索模型关系'), '机柜');
    // `机柜` IS ONLY EVER A PARENT, so filtering on it keeps the edge where it is
    // the parent — a filter that only looked at children would return nothing.
    expect(screen.getByRole('link', { name: '机柜' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '磁盘' })).not.toBeInTheDocument();
  });

  it('disables relation writes for a non-administrator', async () => {
    useAuth.setState({ token: null, role: 'user' });
    server.use(http.get('/api/v1/cmdb/ci-type-relations', () => HttpResponse.json({ items: relations, total: relations.length })));
    renderPage();

    expect(await screen.findByRole('button', { name: '新增关系' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除 host → disk' })).toBeDisabled();
  });

  it('creates a parent → child relation', async () => {
    let posted: unknown;
    let postedPath = '';
    server.use(
      http.get('/api/v1/cmdb/ci-type-relations', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/relation-types', () =>
        HttpResponse.json({ items: [{ id: 5, name: '连接', color: '#6366f1' }], total: 1 }),
      ),
      http.get('/api/v1/cmdb/ci-types', () =>
        HttpResponse.json({ items: [host, disk], total: 2 }),
      ),
      http.get('/api/v1/cmdb/ci-types/:ref/attributes', ({ params }) =>
        HttpResponse.json({ type_id: Number(params.ref), unique_id: 1, unique: 'name', attributes: [] }),
      ),
      http.post(
        '/api/v1/cmdb/ci-types/:parent/relation-children/:child',
        async ({ request, params }) => {
          postedPath = `/api/v1/cmdb/ci-types/${params.parent}/relation-children/${params.child}`;
          posted = await request.json();
          return HttpResponse.json(relations[0]);
        },
      ),
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: '新增关系' }));
    await selectOption(screen.getByLabelText('源 CI 类型'), '主机');
    await selectOption(screen.getByLabelText('目标 CI 类型'), '磁盘');
    await selectOption(screen.getByLabelText('关联类型'), '连接');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(posted).toEqual({ relation_type_id: 5, constraint: '0' }));
    expect(postedPath).toBe('/api/v1/cmdb/ci-types/1/relation-children/2');
  });

  it('clears the source side of an attribute mapping when the source type changes', async () => {
    let releaseRack = () => {};
    const rackPending = new Promise<void>((resolve) => {
      releaseRack = resolve;
    });
    const attr = (id: number, name: string, alias: string) => ({
      id, name, alias, value_type: '2', is_choice: false, is_list: false, is_unique: false,
      is_index: true, is_link: false, is_password: false, is_sortable: false, is_dynamic: false,
      is_bool: false, is_file: false, is_reference: false, is_computed: false,
      has_compute_script: false, has_choice_web_hook: false, has_choice_other: false,
      is_indexed: true, storage_table: 'c_value_index_texts', is_required: false, order: 0,
      default_show: false, inherited: false,
    });
    server.use(
      http.get('/api/v1/cmdb/ci-type-relations', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/relation-types', () =>
        HttpResponse.json({ items: [{ id: 5, name: '连接', color: '#6366f1' }], total: 1 }),
      ),
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [host, disk, rack], total: 3 })),
      http.get('/api/v1/cmdb/ci-types/:ref/attributes', async ({ params }) => {
        if (String(params.ref) === '3') await rackPending;
        const attributes =
          String(params.ref) === '1'
            ? [attr(10, 'hostname', '主机名')]
            : [attr(20, 'sn', '序列号')];
        return HttpResponse.json({ type_id: Number(params.ref), unique_id: attributes[0].id, unique: attributes[0].name, attributes });
      }),
    );
    renderPage();

    try {
      await userEvent.click(await screen.findByRole('button', { name: '新增关系' }));
      await selectOption(screen.getByLabelText('源 CI 类型'), '主机');
      await selectOption(screen.getByLabelText('目标 CI 类型'), '磁盘');
      // ONE ROW EXISTS WITHOUT PRESSING ANYTHING: the mapping is part of the
      // form, not a section you first have to add.
      await waitFor(() => expect(screen.getByLabelText('源属性 1')).toBeEnabled());
      await selectOption(screen.getByRole('combobox', { name: '源属性 1' }), '主机名（hostname）');
      await selectOption(screen.getByRole('combobox', { name: '目标属性 1' }), '序列号（sn）');

      // Rack's attributes are still loading, but the mapping belongs to the
      // previous parent and must not survive the change.
      await selectOption(screen.getAllByLabelText('源 CI 类型')[0], '机柜');
      await waitFor(() => expect(screen.getByLabelText('源属性 1')).toHaveTextContent('选择源属性'));
    } finally {
      releaseRack();
    }
  });

  it('offers only comparable attributes and clears the mapping when the constraint changes', async () => {
    const user = userEvent.setup();
    const attr = (id: number, name: string, alias: string, valueType: string, extra: Record<string, unknown> = {}) => ({
      id, name, alias, value_type: valueType, is_choice: false, is_list: false, is_unique: false,
      is_index: true, is_link: false, is_password: false, is_sortable: false, is_dynamic: false,
      is_bool: false, is_file: false, is_reference: false, is_computed: false,
      has_compute_script: false, has_choice_web_hook: false, has_choice_other: false,
      is_indexed: true, storage_table: 'c_value_index_texts', is_required: false, order: id,
      default_show: false, inherited: false, ...extra,
    });
    server.use(
      http.get('/api/v1/cmdb/ci-type-relations', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/relation-types', () =>
        HttpResponse.json({ items: [{ id: 5, name: '连接', color: '#6366f1' }], total: 1 }),
      ),
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [host, disk], total: 2 })),
      http.get('/api/v1/cmdb/ci-types/:ref/attributes', ({ params }) => {
        const attributes =
          String(params.ref) === '1'
            ? [attr(10, 'hostname', '主机名', '2'), attr(11, 'secret', '密钥', '2', { is_password: true })]
            : [attr(20, 'sn', '序列号', '2'), attr(21, 'port', '端口', '0')];
        return HttpResponse.json({ type_id: Number(params.ref), unique_id: attributes[0].id, unique: attributes[0].name, attributes });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: '新增关系' }));
    await selectOption(screen.getByLabelText('源 CI 类型'), '主机');
    await selectOption(screen.getByLabelText('目标 CI 类型'), '磁盘');
    await waitFor(() => expect(screen.getByLabelText('源属性 1')).toBeEnabled());

    // A secret is not a comparable value, so it is never offered.
    await user.click(screen.getByLabelText('源属性 1'));
    expect(screen.queryByRole('option', { name: '密钥（secret）' })).not.toBeInTheDocument();
    await selectOption(screen.getByRole('combobox', { name: '源属性 1' }), '主机名（hostname）');

    // The text source narrows the target to text attributes; the integer is out.
    await user.click(screen.getByLabelText('目标属性 1'));
    expect(await screen.findByRole('option', { name: '序列号（sn）' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '端口（port）' })).not.toBeInTheDocument();
    await selectOption(screen.getByRole('combobox', { name: '目标属性 1' }), '序列号（sn）');

    // The constraint's list rules depend on both mappings, so changing it
    // clears them instead of leaving an unchecked pair.
    await selectOption(screen.getByLabelText('关系约束'), '一对一');
    expect(screen.getByLabelText('源属性 1')).toHaveTextContent('选择源属性');
    expect(screen.getByLabelText('目标属性 1')).toHaveTextContent('选择目标属性');
  });

  it('asks before deleting and does nothing on cancel', async () => {
    const user = userEvent.setup();
    let deleted = 0;
    server.use(
      http.get('/api/v1/cmdb/ci-type-relations', () => HttpResponse.json({ items: relations, total: relations.length })),
      http.delete('/api/v1/cmdb/ci-type-relations/:id', () => {
        deleted += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: '删除 host → disk' }));
    const dialog = await screen.findByRole('dialog');
    // THE CONFIRMATION DISTINGUISHES THE SCHEMA FROM THE DATA: deleting the model
    // relation does not delete the instance relations that already exist.
    expect(within(dialog).getByText(/实例关系不会被删除/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(deleted).toBe(0);

    await user.click(screen.getByRole('button', { name: '删除 host → disk' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '确认' }));
    await waitFor(() => expect(deleted).toBe(1));
  });
});
