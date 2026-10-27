import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { server } from '@/test/msw-server';

import type { CIType, RelatedType, TypeAttribute } from '../../api/citype';
import type { SearchRow } from '../../api/instance';
import { ToastProvider } from '../Toast';
import { InstanceRelations } from './InstanceRelations';

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

const service: CIType = {
  id: 85,
  name: 'service',
  alias: '业务服务',
  enabled: true,
  is_attached: true,
  order: 0,
  unique_key: 'uuid',
  show_name: 'name',
  parent_ids: [],
};

const attribute = (id: number, name: string, extra: Partial<TypeAttribute> = {}): TypeAttribute => ({
  id,
  name,
  alias: name,
  value_type: '2',
  is_choice: false,
  is_list: false,
  is_unique: false,
  is_index: true,
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
  is_indexed: true,
  storage_table: 'c_value_index_texts',
  is_required: false,
  order: id,
  default_show: true,
  inherited: false,
  ...extra,
});

const serviceAttributes = [
  attribute(1, 'uuid', { alias: 'ID' }),
  attribute(2, 'code', { alias: '代码' }),
  attribute(3, 'name', { alias: '名称' }),
  attribute(4, 'environment', {
    alias: '环境类型',
    is_choice: true,
    choice_value: [{ value: 'prod', option: { label: '生产' } }],
  }),
  attribute(5, 'data_status', {
    alias: '数据状态',
    is_choice: true,
    choice_value: [{ value: 'active', option: { label: '使用中' } }],
  }),
  attribute(6, 'description', { alias: '描述' }),
];

const related: RelatedType = {
  ctr_id: 1,
  type: service,
  show_key: 'name',
  attributes: serviceAttributes,
  relation_type: { id: 3, name: '包含', color: '#3b82f6' },
  constraint: '0',
  parent_attr_ids: [],
  child_attr_ids: [],
};

const serviceRow: SearchRow = {
  _id: 900,
  _type: 85,
  ci_id: 900,
  ci_type: 'service',
  unique: 'uuid',
  name: '业务服务 A',
  uuid: 'dd09aace-6c48-4f37-9674-2b36ea98a9a2',
  code: 'bsvc-20260628-0001',
  environment: 'prod',
  data_status: 'active',
};

const candidateRow: SearchRow = {
  ...serviceRow,
  _id: 901,
  ci_id: 901,
  name: '业务服务 B',
  uuid: 'ff4e55fb-de33-406a-ba9a-d4e25f60c068',
  code: 'bsvc-20260628-0002',
};

function renderRelations() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <InstanceRelations ciID={5} modelRef="host" models={[host, service]} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

function mocks(onPost?: (path: string, body: unknown) => void) {
  server.use(
    http.get('/api/v1/cmdb/ci-types/service/attributes', () =>
      HttpResponse.json({ type_id: 85, unique_id: 1, unique: 'uuid', attributes: serviceAttributes }),
    ),
    http.get('/api/v1/cmdb/ci-types/host/relation-parents', () =>
      HttpResponse.json({ items: [related], total: 1 }),
    ),
    http.get('/api/v1/cmdb/ci-types/host/relation-children', () =>
      HttpResponse.json({ items: [], total: 0 }),
    ),
    http.get('/api/v1/cmdb/ci-relations/search', ({ request }) => {
      const reverse = new URL(request.url).searchParams.get('reverse') === 'true';
      return HttpResponse.json({
        numfound: reverse ? 1 : 0,
        total: reverse ? 1 : 0,
        page: 1,
        result: reverse ? [serviceRow] : [],
      });
    }),
    http.post('/api/v1/cmdb/ci/s', () =>
      HttpResponse.json({
        numfound: 2,
        total: 2,
        page: 1,
        result: [serviceRow, candidateRow],
      }),
    ),
    http.post('/api/v1/cmdb/ci-relations/:first/:second', async ({ request, params }) => {
      onPost?.(`${params.first}/${params.second}`, await request.json());
      return HttpResponse.json({ cr_id: 1 }, { status: 201 });
    }),
  );
}

beforeEach(() => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
});

describe('the related resources table', () => {
  it('shows a compact resource row with labels and detail/topology/search actions', async () => {
    mocks();
    renderRelations();

    expect(await screen.findByText('业务服务 A')).toBeInTheDocument();
    expect(screen.getByText('生产')).toBeInTheDocument();
    expect(screen.getByText('使用中')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看 业务服务 A 详情' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看 业务服务 A 拓扑' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: '在资源数据中打开 业务服务 A' });
    expect(link.getAttribute('href')).toContain('/cmdb/instances?');
    expect(link.getAttribute('href')).toContain('type=service');
    expect(link.getAttribute('href')).toContain('ci=900');
  });

  it('searches the target model and adds the ordered relation', async () => {
    const user = userEvent.setup();
    const posted: Array<{ path: string; body: unknown }> = [];
    mocks((path, body) => posted.push({ path, body }));
    renderRelations();

    await user.click(await screen.findByRole('button', { name: '添加业务服务关联' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('添加业务服务关联')).toBeInTheDocument();
    const search = within(dialog).getByRole('searchbox', { name: '搜索业务服务' });
    await user.type(search, 'B');
    const candidate = await within(dialog).findByRole('button', { name: /业务服务 B/ });
    expect(within(dialog).queryByRole('button', { name: /业务服务 A/ })).not.toBeInTheDocument();
    await user.click(candidate);
    await user.click(within(dialog).getByRole('button', { name: '添加关联' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      path: '901/5',
      body: { relation_type_id: 3 },
    });
    expect(await screen.findByText('已添加关联：业务服务 B')).toBeInTheDocument();
  });
});
