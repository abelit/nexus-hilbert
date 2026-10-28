import { expect, test } from '@playwright/test';

// Responsive screenshots for the CMDB pages added in this branch.
//
// THE API IS MOCKED. These tests are about layout and theme, not the service:
// the real endpoints need a database and a populated estate, and a screenshot
// suite that only runs on a seeded deployment is a suite that never runs. The
// mocks carry one realistic row per page so an empty state is not mistaken for
// the layout.

test.use({ storageState: { cookies: [], origins: [] } });

const RULE = {
  id: 1, name: '阿里云', type: 'http', is_inner: true, is_plugin: false,
  unique_key: 'instance_id', attribute_count: 12, has_plugin_script: false,
};
const HOST = {
  id: 1, name: 'host', alias: '主机', enabled: true, is_attached: true,
  icon: '', order: 0, unique_key: 'hostname', parent_ids: [],
};
const SWITCH = {
  ...HOST, id: 2, name: 'switch', alias: '交换机', order: 1,
  unique_key: 'hostname',
};
const MODEL_GROUP = { id: 10, name: '服务器', ci_types: [HOST] };

const INSTANCE_ATTRIBUTES = [
  { id: 10, name: 'hostname', alias: '主机名', value_type: '2', is_list: false, is_index: true },
  { id: 11, name: 'note', alias: '说明', value_type: '2', is_list: false, is_index: false },
  { id: 12, name: 'environment', alias: '环境', value_type: '2', is_list: false, is_index: true },
  { id: 13, name: 'level', alias: '等级', value_type: '2', is_list: false, is_index: true },
  { id: 14, name: 'data_status', alias: '状态', value_type: '2', is_list: false, is_index: true },
  { id: 15, name: 'sla', alias: 'SLA', value_type: '2', is_list: false, is_index: false },
  { id: 16, name: 'owner', alias: '负责人', value_type: '2', is_list: false, is_index: false },
  { id: 17, name: 'region', alias: '区域', value_type: '2', is_list: false, is_index: false },
  { id: 18, name: 'application', alias: '所属应用', value_type: '2', is_list: false, is_index: false },
  { id: 19, name: 'ip_address', alias: 'IP 地址', value_type: '2', is_list: false, is_index: false },
  { id: 20, name: 'os', alias: '操作系统', value_type: '2', is_list: false, is_index: false },
  { id: 21, name: 'serial', alias: '序列号', value_type: '2', is_list: false, is_index: false },
  { id: 22, name: 'owner_team', alias: '负责团队', value_type: '2', is_list: false, is_index: false },
  { id: 23, name: 'created_at', alias: '创建时间', value_type: '2', is_list: false, is_index: false },
].map((attribute, index) => ({
  ...attribute,
  order: index,
  // The definition table's flag columns; realistic values so a screenshot
  // shows marks rather than a wall of dashes.
  is_unique: attribute.name === 'hostname',
  is_indexed: index < 12,
  default_show: index < 10,
  is_choice: ['environment', 'level', 'data_status'].includes(attribute.name),
  is_sortable: ['hostname', 'level', 'data_status'].includes(attribute.name),
  is_computed: attribute.name === 'created_at',
}));

const INSTANCE_ROWS = Array.from({ length: 40 }, (_, index) => ({
  ci_id: index + 1,
  type_id: 1,
  // The detail header's audit line; the list ignores these fields.
  updated_at: '2026-06-01T11:01:04Z',
  updated_by: 'admin',
  values: {
    hostname: `host-${String(index + 1).padStart(2, '0')}`,
    note: `rack-${(index % 3) + 1}`,
    environment: 'prod',
    level: index % 2 === 0 ? 'critical' : 'normal',
    data_status: 'active',
    sla: '99.9%',
    owner: 'ops',
    region: 'cn-north',
    application: 'orders',
    ip_address: `10.0.0.${index + 1}`,
    os: 'linux',
    serial: `SN-${1000 + index}`,
    owner_team: 'platform',
    created_at: '2026-10-27',
  },
}));

const INSTANCE_FIELDS = INSTANCE_ATTRIBUTES.map((attribute, index) => ({
  attr_id: attribute.id,
  is_fixed: index === 0,
}));

const DEFINITION_ATTRIBUTES = INSTANCE_ATTRIBUTES.slice(0, 2);
const DEFINITION_TRIGGER = {
  id: 80,
  type_id: 1,
  attr_id: 10,
  option: {
    webhooks: {
      url: 'https://example.test/hook',
      authorization: { token: 'must-not-leak' },
    },
  },
  has_webhook_authorization: true,
};

async function mockModelDefinition(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/cmdb/ci-types/1', (route) => route.fulfill({ json: HOST }));
  await page.route('**/api/v1/cmdb/ci-types', (route) =>
    route.fulfill({ json: { items: [HOST], total: 1 } }),
  );
  await page.route('**/api/v1/cmdb/preferences/model-groups', (route) =>
    route.fulfill({ json: { items: [], total: 0 } }),
  );
  await page.route('**/api/v1/cmdb/ci-types/1/attributes', (route) =>
    route.fulfill({
      json: { type_id: 1, unique_id: 10, unique: 'hostname', attributes: DEFINITION_ATTRIBUTES },
    }),
  );
  await page.route('**/api/v1/cmdb/ci-types/1/attribute-groups*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/cmdb/ci-types/1/relation-children', (route) =>
    route.fulfill({ json: { items: [], total: 0 } }),
  );
  await page.route('**/api/v1/cmdb/ci-types/1/relation-parents', (route) =>
    route.fulfill({ json: { items: [], total: 0 } }),
  );
  await page.route('**/api/v1/cmdb/ci-types/1/unique-constraints', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 70,
            type_id: 1,
            attr_ids: [10, 99],
            attributes: [DEFINITION_ATTRIBUTES[0]],
          },
        ],
        total: 1,
      },
    }),
  );
  await page.route('**/api/v1/cmdb/ci-types/1/triggers', (route) =>
    route.fulfill({ json: { items: [DEFINITION_TRIGGER], total: 1 } }),
  );
}

const TYPE_ATTRIBUTE_BASE = {
  is_list: false,
  is_choice: false,
  is_required: false,
  default_show: false,
  inherited: false,
  order: 0,
  is_unique: false,
  is_sortable: false,
  is_indexed: false,
  is_index: false,
  is_password: false,
  is_link: false,
  is_file: false,
  is_reference: false,
  storage_table: '',
};

const TYPE_ATTRIBUTES = [
  {
    ...TYPE_ATTRIBUTE_BASE,
    id: 10,
    name: 'hostname',
    alias: '主机名',
    value_type: '2',
    is_required: true,
    default_show: true,
    is_unique: true,
    is_sortable: true,
    is_index: true,
    is_indexed: true,
  },
  {
    ...TYPE_ATTRIBUTE_BASE,
    id: 11,
    name: 'cpu',
    alias: '核数',
    value_type: '0',
    is_index: true,
    is_indexed: true,
  },
  {
    ...TYPE_ATTRIBUTE_BASE,
    id: 12,
    name: 'ratio',
    alias: '比率',
    value_type: '1',
    is_index: true,
    is_indexed: true,
  },
  {
    ...TYPE_ATTRIBUTE_BASE,
    id: 13,
    name: 'note',
    alias: '备注',
    value_type: '2',
    is_index: false,
    is_indexed: false,
  },
  {
    ...TYPE_ATTRIBUTE_BASE,
    id: 14,
    name: 'root_password',
    alias: 'Root 密码',
    value_type: '2',
    is_required: true,
    is_unique: true,
    is_password: true,
    is_index: true,
    is_indexed: false,
  },
  {
    ...TYPE_ATTRIBUTE_BASE,
    id: 15,
    name: 'homepage',
    alias: '主页',
    value_type: '2',
    is_link: true,
    is_index: true,
    is_indexed: false,
  },
  {
    ...TYPE_ATTRIBUTE_BASE,
    id: 16,
    name: 'attachment',
    alias: '附件',
    value_type: '2',
    is_file: true,
    is_index: true,
    is_indexed: false,
  },
  {
    ...TYPE_ATTRIBUTE_BASE,
    id: 17,
    name: 'enabled',
    alias: '启用',
    value_type: '7',
    is_index: true,
    is_indexed: true,
  },
  {
    ...TYPE_ATTRIBUTE_BASE,
    id: 18,
    name: 'rack_ref',
    alias: '机柜引用',
    value_type: '0',
    is_reference: true,
    is_index: true,
    is_indexed: true,
  },
  {
    ...TYPE_ATTRIBUTE_BASE,
    id: 19,
    name: 'config',
    alias: '配置',
    value_type: '6',
    is_index: false,
    is_indexed: false,
  },
  {
    ...TYPE_ATTRIBUTE_BASE,
    id: 20,
    name: 'boot_at',
    alias: '启动时间',
    value_type: '3',
    is_index: true,
    is_indexed: true,
  },
  {
    ...TYPE_ATTRIBUTE_BASE,
    id: 21,
    name: 'expires_on',
    alias: '到期日',
    value_type: '4',
    is_index: true,
    is_indexed: true,
  },
  {
    ...TYPE_ATTRIBUTE_BASE,
    id: 22,
    name: 'window',
    alias: '时间窗',
    value_type: '5',
    is_index: true,
    is_indexed: true,
  },
];

const TYPE_ATTRIBUTE_GROUPS = [
  {
    id: 5,
    name: '基本信息',
    type_id: 1,
    order: 0,
    inherited: false,
    is_other: false,
    attributes: TYPE_ATTRIBUTES.slice(0, 5),
  },
  {
    id: 0,
    name: '',
    type_id: 1,
    order: 1,
    inherited: false,
    is_other: true,
    attributes: TYPE_ATTRIBUTES.slice(5),
  },
];

async function mockAttributeWorkspace(page: import('@playwright/test').Page) {
  await mockAPI(page);
  await mockModelDefinition(page);
  await page.route('**/api/v1/cmdb/ci-types/1/attributes', (route) =>
    route.fulfill({
      json: { type_id: 1, unique_id: 10, unique: 'hostname', attributes: TYPE_ATTRIBUTES },
    }),
  );
  await page.route('**/api/v1/cmdb/ci-types/1/attribute-groups*', (route) =>
    route.fulfill({ json: TYPE_ATTRIBUTE_GROUPS }),
  );
}

async function mockInstanceData(page: import('@playwright/test').Page, extraModel = false) {
  if (extraModel) {
    await page.route('**/api/v1/cmdb/ci-types', (route) =>
      route.fulfill({ json: { items: [HOST, SWITCH], total: 2 } }),
    );
  }
  await page.route('**/api/v1/cmdb/ci-types/host/attributes', (route) =>
    route.fulfill({ json: { type_id: 1, unique_id: 10, unique: 'hostname', attributes: INSTANCE_ATTRIBUTES } }),
  );
  await page.route('**/api/v1/cmdb/ci-types/host/attribute-groups*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/cmdb/preferences/ci-types/host/fields', (route) =>
    route.fulfill({ json: { type_id: 1, is_subscribed: true, fields: INSTANCE_FIELDS } }),
  );
  await page.route('**/api/v1/cmdb/ci-types/host/instances*', (route) =>
    route.fulfill({
      json: { type_id: 1, items: INSTANCE_ROWS.slice(0, 20), total: 40, numfound: 40, page: 1 },
    }),
  );
  await page.route('**/api/v1/cmdb/instances/5', (route) =>
    route.fulfill({ json: INSTANCE_ROWS[4] }),
  );
  if (extraModel) {
    await page.route('**/api/v1/cmdb/ci-types/switch/attributes', (route) =>
      route.fulfill({ json: { type_id: 2, unique_id: 10, unique: 'hostname', attributes: INSTANCE_ATTRIBUTES } }),
    );
    await page.route('**/api/v1/cmdb/ci-types/switch/attribute-groups*', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/v1/cmdb/preferences/ci-types/switch/fields', (route) =>
      route.fulfill({ json: { type_id: 2, is_subscribed: true, fields: INSTANCE_FIELDS } }),
    );
    await page.route('**/api/v1/cmdb/ci-types/switch/instances*', (route) =>
      route.fulfill({
        json: {
          type_id: 2,
          items: [{ ci_id: 6, type_id: 2, values: { ...INSTANCE_ROWS[0].values, hostname: 'sw-01' } }],
          total: 1,
          numfound: 1,
          page: 1,
        },
      }),
    );
  }
}
async function mockInstanceDetail(page: import('@playwright/test').Page) {
  await mockAPI(page);
  await mockInstanceData(page);
  await page.route('**/api/v1/cmdb/history/ci/5*', (route) =>
    route.fulfill({
      json: {
        items: [{
          id: 91, record_id: 9, uid: 7, operate_type: '2', ci_id: 5, ci_name: 'host-05',
          attr_id: 10, attr_name: 'hostname', attr_alias: '主机名',
          old: 'host-04', new: 'host-05', created_at: '2026-10-27 10:00:00',
        }],
        total: 1, page: 1, page_size: 20,
      },
    }),
  );
  await page.route('**/api/v1/cmdb/history/ci/5/triggers*', (route) =>
    route.fulfill({
      json: {
        items: [{
          id: 92, ci_id: 5, ci_name: 'host-05', trigger_id: 3, trigger_name: '主机变更通知',
          operate_type: '2', is_ok: true, notify: 'dingtalk', created_at: '2026-10-27 10:01:00',
        }],
        total: 1, page: 1, page_size: 20,
      },
    }),
  );
  const relatedAttribute = { id: 30, name: 'name', alias: '名称', value_type: '2', is_list: false, is_index: true };
  await page.route('**/api/v1/cmdb/ci-types/host/relation-parents', (route) =>
    route.fulfill({
      json: {
        items: [{
          ctr_id: 1,
          type: { ...HOST, id: 3, name: 'rack', alias: '机柜', unique_key: 'name' },
          attributes: [relatedAttribute],
          relation_type: { id: 1, name: '属于', color: '' },
          constraint: '0', parent_attr_ids: [], child_attr_ids: [],
        }],
        total: 1,
      },
    }),
  );
  await page.route('**/api/v1/cmdb/ci-types/host/relation-children', (route) =>
    route.fulfill({
      json: {
        items: [{
          ctr_id: 2,
          type: { ...HOST, id: 2, name: 'disk', alias: '磁盘', unique_key: 'name' },
          attributes: [relatedAttribute],
          relation_type: { id: 2, name: '包含', color: '' },
          constraint: '0', parent_attr_ids: [], child_attr_ids: [],
        }],
        total: 1,
      },
    }),
  );
  await page.route('**/api/v1/cmdb/ci-types/3/relation-parents', (route) =>
    route.fulfill({
      json: {
        items: [{
          ctr_id: 3,
          type: { ...HOST, id: 6, name: 'idc', alias: '机房', unique_key: 'name' },
          attributes: [relatedAttribute],
          relation_type: { id: 3, name: '位于', color: '' },
          constraint: '0', parent_attr_ids: [], child_attr_ids: [],
        }],
        total: 1,
      },
    }),
  );
  await page.route('**/api/v1/cmdb/ci-types/3/relation-children', (route) =>
    route.fulfill({
      json: {
        items: [{
          ctr_id: 4,
          type: { ...HOST, id: 1, name: 'host', alias: '主机', unique_key: 'hostname' },
          attributes: [relatedAttribute],
          relation_type: { id: 2, name: '包含', color: '' },
          constraint: '0', parent_attr_ids: [], child_attr_ids: [],
        }],
        total: 1,
      },
    }),
  );
  await page.route('**/api/v1/cmdb/ci-relations/search*', (route) => {
    const url = new URL(route.request().url());
    const reverse = url.searchParams.get('reverse') === 'true';
    const root = url.searchParams.get('root_id');
    const result = root === '41'
      ? (reverse
          ? [{ _id: 51, _type: 6, ci_id: 51, ci_type: 'idc', unique: 'name', name: 'idc-01' }]
          : [{ _id: 5, _type: 1, ci_id: 5, ci_type: 'host', unique: 'hostname', name: 'host-05' }])
      : root === '5'
        ? (reverse
            ? [{ _id: 41, _type: 3, ci_id: 41, ci_type: 'rack', unique: 'name', name: 'rack-01' }]
            : [{ _id: 21, _type: 2, ci_id: 21, ci_type: 'disk', unique: 'name', name: 'sda' }])
        : [];
    return route.fulfill({ json: { numfound: result.length, total: result.length, page: 1, result } });
  });
}

const USER = {
  id: 7, email: 'ops@example.test', display_name: '运维', phone: '',
  role: 'admin', status: 'active', created_at: '', updated_at: '',
};
const ATTRIBUTE_RECORD = {
  record_id: 2, uid: 7, type_id: 1, type_name: 'host', type_alias: '主机',
  origin: 'ui', created_at: '2026-10-26T11:00:00Z',
  changes: [{
    id: 20, record_id: 2, uid: 7, operate_type: '2', ci_id: 100, ci_name: 'web-01',
    attr_id: 10, attr_name: 'hostname', attr_alias: '主机名', value_type: '2',
    old: 'web-00', new: 'web-01', created_at: '2026-10-26T11:00:00Z',
  }],
};
const TOPOLOGY_VIEW = {
  id: 7, name: '机房拓扑', group_id: 1, central_node_type: 1,
  central_node_instances: 'hostname:web*', path: { '1': [2] }, order: 1,
};
const TOPOLOGY_GROUP = { id: 1, name: '网络', order: 1, views: [TOPOLOGY_VIEW] };
const IPAM_SCOPE = {
  _id: 1, _type: 11, ci_type: 'ipam_scope', ci_type_alias: '地址分组', name: '生产网',
  children: [{
    _id: 2, _type: 12, ci_type: 'ipam_subnet', ci_type_alias: '子网',
    name: '办公网段', cidr: '10.0.0.0/24', children: [],
  }],
};
const IPAM_TREE = { result: [IPAM_SCOPE], type2name: { '11': 'name', '12': 'name' } };
const IPAM_SUMMARY = {
  subnet_num: 1, address_num: 254, address_free_num: 250, address_assign_num: 4,
  address_unassign_num: 250, address_used_num: 2, address_used_free_num: 252,
  subnets: [{
    _id: 2, _type: 12, ci_type: 'ipam_subnet', ci_type_alias: '子网',
    name: '办公网段', cidr: '10.0.0.0/24', hosts_count: 254, assign_count: 4,
    used_count: 2, free_count: 250, scan_enabled: true, last_scan_time: '2026-10-18 03:00:00',
  }],
};
const IPAM_HOSTS = Array.from({ length: 254 }, (_, index) => `10.0.0.${index + 1}`);
const IPAM_ADDRESSES = {
  numfound: 2, total: 2, page: 1, counter: {},
  result: [
    { _id: 21, _type: 13, ci_id: 21, ci_type: 'ipam_address', ci_type_alias: '地址', ip: '10.0.0.11', assign_status: 0, is_used: 1, name: '10.0.0.11', usage: 'web', use_obj: '服务器', mac_address: 'aa:bb:cc:dd:ee:ff' },
    { _id: 22, _type: 13, ci_id: 22, ci_type: 'ipam_address', ci_type_alias: '地址', ip: '10.0.0.12', assign_status: 1, is_used: 0, name: '10.0.0.12' },
  ],
};
const IPAM_OPERATIONS = {
  numfound: 1,
  result: [{ _id: 9, cidr: '10.0.0.0/24', uid: 7, operate_type: '6', description: '10.0.0.11', created_at: '2026-10-18 09:00:00' }],
};
const IPAM_SCANS = {
  numfound: 1,
  result: [{ _id: 5, exec_id: 'abc123', cidr: '10.0.0.0/24', status: 0, ip_num: 2, stdout: '2 hosts up', start_at: '2026-10-18 03:00:00', end_at: '2026-10-18 03:00:11', created_at: '2026-10-18 03:00:00' }],
};
const POOL_ENTRY = {
  id: 1, type_id: 1, adt_id: 5, unique_value: 'i-1',
  instance: { hostname: 'i-1', cpu: 4 }, oneagent_id: 'agent-1', oneagent_name: 'agent one',
  is_accept: false, adr_name: '阿里云', adr_type: 'http', is_inner: true,
  updated_at: '2026-10-26 10:00:00',
};

type PageCase = {
  path: string;
  heading: string;
  headingEn: string;
  name: string;
};

const PAGES: PageCase[] = [
  { path: '/cmdb/discovery', heading: '自动发现', headingEn: 'Auto discovery', name: 'discovery' },
  { path: '/cmdb/adc', heading: '自动发现池', headingEn: 'Discovery pool', name: 'discovery-pool' },
  { path: '/cmdb/operation-history', heading: '操作历史', headingEn: 'Operation history', name: 'operation-history' },
  { path: '/cmdb/topology-views', heading: '拓扑视图', headingEn: 'Topology views', name: 'topology-views' },
  { path: '/cmdb/preferences', heading: '偏好设置', headingEn: 'Preferences', name: 'preferences' },
  { path: '/cmdb/tree-views', heading: '资源层级', headingEn: 'Resource hierarchy', name: 'tree-views' },
  { path: '/cmdb/relations', heading: '模型关系', headingEn: 'Model relations', name: 'relations' },
  { path: '/cmdb/batch', heading: '批量导入', headingEn: 'Batch import', name: 'batch-import' },
  { path: '/cmdb/service-tree', heading: '服务树', headingEn: 'Service tree', name: 'relation-views' },
  { path: '/cmdb/ipam', heading: 'IP 地址空间', headingEn: 'IP address space', name: 'ipam' },
];

async function mockAPI(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    switch (path) {
      case '/api/v1/me':
        await route.fulfill({ json: { id: 7, email: USER.email, display_name: USER.display_name, phone: '', role: 'admin', status: 'active', memberships: [] } });
        return;
      case '/api/v1/users':
        await route.fulfill({ json: { items: [USER], total: 1 } });
        return;
      case '/api/v1/cmdb/ci-types':
        await route.fulfill({ json: { items: [HOST], total: 1 } });
        return;
      case '/api/v1/cmdb/ci-types/ipam_subnet':
        await route.fulfill({ json: { id: 12, name: 'ipam_subnet', alias: '子网', enabled: true } });
        return;
      case '/api/v1/cmdb/ci-types/ipam_address':
        await route.fulfill({ json: { id: 13, name: 'ipam_address', alias: 'IP地址', enabled: true } });
        return;
      case '/api/v1/cmdb/ci-types/ipam_address/attributes':
        await route.fulfill({ json: {
          type_id: 13, unique_id: 118, unique: 'ip',
          attributes: [
            {
              id: 1, name: 'use_obj', alias: '使用对象', is_choice: true,
              choice_value: [
                { value: '服务器', option: { label: '服务器' } },
                { value: '交换机', option: { label: '交换机' } },
              ],
            },
            { id: 2, name: 'usage', alias: '用途', is_choice: false },
            { id: 3, name: 'description', alias: '描述', is_choice: false },
            { id: 4, name: 'mac_address', alias: 'MAC地址', is_choice: false },
            { id: 5, name: 'gateway', alias: '网关', is_choice: false },
            { id: 6, name: 'subnet_mask', alias: '子网掩码', is_choice: false },
          ],
        } });
        return;
      case '/api/v1/cmdb/ipam/tree-view':
        await route.fulfill({ json: IPAM_TREE });
        return;
      case '/api/v1/cmdb/ipam/stats':
        await route.fulfill({ json: IPAM_SUMMARY });
        return;
      case '/api/v1/cmdb/ipam/addresses':
        await route.fulfill({ json: IPAM_ADDRESSES });
        return;
      case '/api/v1/cmdb/ipam/subnets/hosts':
        await route.fulfill({ json: { hosts: IPAM_HOSTS, truncated: false } });
        return;
      case '/api/v1/cmdb/ipam/subnets/2':
        await route.fulfill({ json: {
          ...IPAM_SUMMARY.subnets[0], scan_enabled: true, agent_id: '0x0000', cron: '0 3 * * *',
        } });
        return;
      case '/api/v1/cmdb/ipam/history/operations':
        await route.fulfill({ json: IPAM_OPERATIONS });
        return;
      case '/api/v1/cmdb/ipam/history/scans':
        await route.fulfill({ json: IPAM_SCANS });
        return;
      case '/api/v1/cmdb/ci/s':
        await route.fulfill({ json: { numfound: 0, total: 0, page: 1, result: [] } });
        return;
      case '/api/v1/cmdb/discovery/rules':
        await route.fulfill({ json: { items: [RULE], total: 1 } });
        return;
      case '/api/v1/cmdb/discovery/adc/ci-types':
        await route.fulfill({ json: { items: [{ type_id: 1, name: 'host', alias: '主机', icon: '', target_count: 1 }], total: 1 } });
        return;
      case '/api/v1/cmdb/discovery/adc/counter':
        await route.fulfill({ json: { rule_count: 1, exec_target_count: 1, instance_count: 1, accept_count: 0, this_month_count: 1, this_week_count: 1, last_month_count: 0, last_week_count: 0 } });
        return;
      case '/api/v1/cmdb/discovery/adc/ci-types/1/attributes':
        await route.fulfill({ json: { items: [{ id: 10, name: 'hostname', alias: '主机名', value_type: '2', is_list: false }], total: 1 } });
        return;
      case '/api/v1/cmdb/discovery/adc':
        await route.fulfill({ json: { items: [POOL_ENTRY], total: 1, page: 1, page_size: 20 } });
        return;
      case '/api/v1/cmdb/history/attributes':
        await route.fulfill({ json: { items: [ATTRIBUTE_RECORD], total: 1, page: 1, page_size: 20 } });
        return;
      case '/api/v1/cmdb/topology-views/groups':
        await route.fulfill({ json: { items: [TOPOLOGY_GROUP], total: 1 } });
        return;
      case '/api/v1/cmdb/topology-views':
        await route.fulfill({ json: { items: [TOPOLOGY_VIEW], total: 1 } });
        return;
      case '/api/v1/cmdb/topology-views/7/graph':
        await route.fulfill({ json: {
          nodes: [
            { id: 100, type_id: 1, name: 'web-01' },
            { id: 101, type_id: 1, name: 'web-02' },
          ],
          links: [{ from: 100, to: 101 }],
          type2meta: { '1': 'icon-host' },
        } });
        return;
      case '/api/v1/cmdb/preferences/ci-types':
        await route.fulfill({ json: { groups: [], type_ids: [] } });
        return;
      case '/api/v1/cmdb/preferences/auto-subscription':
        await route.fulfill({ json: { base_strategy: 'all', group_ids: [], type_ids: [], enabled: false } });
        return;
      case '/api/v1/cmdb/preferences/tree-levels':
        await route.fulfill({ json: [] });
        return;
      default:
        await route.fulfill({ json: { items: [], total: 0 } });
    }
  });
}

// The action column must be fixed as one piece: a pinned cell under an
// unpinned header lets the headers of the columns it covers show through.
// A DOM assertion cannot see that, so this measures both boxes in Chromium.
test('the model action header stays pinned with the action cells', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockAPI(page);

  await page.goto('/cmdb/models');
  await expect(page.getByRole('heading', { name: '模型配置' })).toBeVisible();
  // 1280 以下默认网格；这个断言检查的是表格，先切回列表。
  await page.getByRole('button', { name: '列表' }).click();

  const table = page.locator('.cmdb-table');
  const scroller = table.locator('div.overflow-x-auto').first();
  await expect(table.getByText('hostname')).toBeVisible();

  const scroll = await scroller.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);

  const headerBox = await table.locator('thead th').filter({ hasText: '操作' }).boundingBox();
  const cellBox = await table.locator('tbody td.sticky').first().boundingBox();
  const scrollerBox = await scroller.boundingBox();
  expect(headerBox).not.toBeNull();
  expect(cellBox).not.toBeNull();
  expect(scrollerBox).not.toBeNull();
  if (!headerBox || !cellBox || !scrollerBox) return;

  const scrollerRight = scrollerBox.x + scrollerBox.width;
  expect(headerBox.x + headerBox.width).toBeLessThanOrEqual(scrollerRight + 1);
  expect(Math.abs((headerBox.x + headerBox.width) - (cellBox.x + cellBox.width))).toBeLessThanOrEqual(1);
});

// Three labelled row buttons take almost the whole width of a phone table,
// and because the action column is pinned they cover the model name itself.
test('the model list compresses its row actions on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockAPI(page);

  await page.goto('/cmdb/models');
  await expect(page.getByRole('heading', { name: '模型配置' })).toBeVisible();
  await page.getByRole('button', { name: '列表' }).click();

  const table = page.locator('.cmdb-table');
  const modelLink = table.locator('tbody tr a').first();
  const actionCell = table.locator('tbody td.sticky').first();
  await expect(modelLink).toBeVisible();
  await expect(page.getByRole('button', { name: '更多操作' }).first()).toBeVisible();

  const linkBox = await modelLink.boundingBox();
  const cellBox = await actionCell.boundingBox();
  expect(linkBox).not.toBeNull();
  expect(cellBox).not.toBeNull();
  if (!linkBox || !cellBox) return;

  expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(cellBox.x + 1);
  expect(cellBox.width).toBeLessThanOrEqual(80);
});

// The schema index is a table on a desktop and cards below 1280: the table is
// the exact view, the cards are the readable one. The phone default must be the
// card view, and the switch must not lose the row actions.
test('the model list opens as cards on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockAPI(page);

  await page.goto('/cmdb/models');
  await expect(page.getByRole('heading', { name: '模型配置' })).toBeVisible();
  await expect(page.getByRole('button', { name: '网格' })).toHaveAttribute('aria-pressed', 'true');

  const card = page.locator('article.cmdb-liquid-card').first();
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: '主机' })).toBeVisible();
  await expect(card.getByRole('button', { name: '编辑 host' })).toBeVisible();

  await page.getByRole('button', { name: '列表' }).click();
  await expect(page.locator('.cmdb-table')).toBeVisible();
});

// Both views live inside one scroll container. If the container is not
// height-constrained, it grows to the full list and the page's overflow hidden
// clips everything past the first viewport — the operator can see the first
// rows and nothing below them. This measures the real scroller in both views.
test('the model list can scroll to the last model in both views', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockAPI(page);
  const manyModels = Array.from({ length: 40 }, (_, index) => ({
    ...HOST,
    id: index + 1,
    name: `model_${index + 1}`,
    alias: `模型${index + 1}`,
  }));
  await page.route('**/api/v1/cmdb/ci-types', (route) =>
    route.fulfill({ json: { items: manyModels, total: manyModels.length } }),
  );

  await page.goto('/cmdb/models');
  await expect(page.getByRole('heading', { name: '模型配置' })).toBeVisible();

  const content = page.locator('.cmdb-liquid-content');
  const tableScroll = await content.evaluate((element) => ({
    client: element.clientHeight,
    scroll: element.scrollHeight,
  }));
  expect(tableScroll.scroll).toBeGreaterThan(tableScroll.client);

  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.locator('.og-resource-table tbody tr').last()).toBeVisible();

  await page.getByRole('button', { name: '网格' }).click();
  const gridScroll = await content.evaluate((element) => ({
    client: element.clientHeight,
    scroll: element.scrollHeight,
  }));
  expect(gridScroll.scroll).toBeGreaterThan(gridScroll.client);

  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.locator('article.cmdb-liquid-card').last()).toBeVisible();
});

test('the model list groups table rows and cards without duplicating the table', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockAPI(page);
  await page.route('**/api/v1/cmdb/preferences/model-groups', (route) =>
    route.fulfill({ json: { items: [MODEL_GROUP], total: 1 } }),
  );
  await page.route('**/api/v1/cmdb/ci-types', (route) =>
    route.fulfill({ json: { items: [HOST, SWITCH], total: 2 } }),
  );

  await page.goto('/cmdb/models');
  await expect(page.getByRole('heading', { name: '模型配置' })).toBeVisible();
  const toggle = page.getByRole('checkbox', { name: '按分组显示' });
  await expect(toggle).toBeVisible();
  await expect(page.getByRole('rowheader')).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('rowheader', { name: /服务器/ })).toContainText('1 个模型');
  await expect(page.getByRole('rowheader', { name: /其他/ })).toContainText('1 个模型');

  // ONE table, ONE column picker: grouping must not render a table per group.
  const table = page.locator('.cmdb-table');
  await expect(table.locator('table')).toHaveCount(1);
  await expect(table.getByRole('button', { name: /列/ })).toHaveCount(1);
  await expect(table.getByRole('link', { name: '主机' })).toBeVisible();
  await expect(table.getByRole('link', { name: '交换机' })).toBeVisible();

  await page.getByRole('button', { name: '网格' }).click();
  await expect(page.getByRole('region', { name: '服务器' })).toBeVisible();
  await expect(page.getByRole('region', { name: '其他' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '主机' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '交换机' })).toBeVisible();
});

test('a long group name stays inside the page on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockAPI(page);
  const longGroup = { ...MODEL_GROUP, name: '服务器与网络设备及存储资源组' };
  await page.route('**/api/v1/cmdb/preferences/model-groups', (route) =>
    route.fulfill({ json: { items: [longGroup], total: 1 } }),
  );
  await page.route('**/api/v1/cmdb/ci-types', (route) =>
    route.fulfill({ json: { items: [HOST, SWITCH], total: 2 } }),
  );

  await page.goto('/cmdb/models');
  await expect(page.getByRole('heading', { name: '模型配置' })).toBeVisible();
  await page.getByRole('checkbox', { name: '按分组显示' }).click();
  await expect(page.getByRole('region', { name: /服务器与网络设备及存储资源组/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: '主机' })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('resource data uses the compact header, model rail and one vertical scroller', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockAPI(page);
  await mockInstanceData(page);

  await page.goto('/cmdb/instances?type=host');
  await expect(page.getByRole('heading', { name: /资源数据/ })).toBeVisible();

  const header = page.locator('header.app-header');
  await expect(header).toBeVisible();
  await expect(page.locator('.cmdb-liquid-content header.app-header')).toHaveCount(0);
  await expect(page.locator('.cmdb-liquid-content nav[aria-label="模型对象"]')).toHaveCount(0);
  await expect(page.locator('.cmdb-liquid-content')).toHaveCount(1);

  const rail = page.getByRole('navigation', { name: '模型对象' });
  await expect(rail).toBeVisible();
  await expect(rail.getByRole('button', { name: '主机' })).toHaveAttribute('aria-pressed', 'true');
  await expect(header).toContainText('实例总数');
  await expect(header).toContainText('本页 Active');

  const content = page.locator('.cmdb-liquid-content');
  const before = await content.evaluate((element) => ({
    client: element.clientHeight,
    scroll: element.scrollHeight,
    top: element.scrollTop,
  }));
  expect(before.scroll).toBeGreaterThan(before.client);
  const railBox = await rail.boundingBox();

  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.locator('.cmdb-table tbody tr').last()).toBeVisible();
  expect(await content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const railAfter = await rail.boundingBox();
  expect(railAfter?.y).toBe(railBox?.y);

  const scroller = page.locator('.cmdb-table div.overflow-x-auto');
  const widths = await scroller.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(widths.scroll).toBeGreaterThan(widths.client);

  await page.getByRole('button', { name: '网格' }).click();
  await expect(page.locator('div.cmdb-liquid-card').first()).toBeVisible();
  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.locator('div.cmdb-liquid-card').last()).toBeVisible();

  await page.getByRole('button', { name: '列表' }).click();
  await page.getByRole('button', { name: '编辑实例 5' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('the resource model rail follows the configured model groups', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockInstanceDetail(page);
  // A second model makes the ungrouped bucket visible next to a real group.
  await mockInstanceData(page, true);
  await page.route('**/api/v1/cmdb/preferences/model-groups', (route) =>
    route.fulfill({ json: { items: [{ id: 10, name: '服务器', ci_types: [HOST] }], total: 1 } }),
  );

  await page.goto('/cmdb/instances?type=host');
  const rail = page.getByRole('navigation', { name: '模型对象' });
  await expect(rail.getByRole('heading', { name: '服务器' })).toBeVisible();
  // The switch belongs to no group, so it trails in 其他.
  await expect(rail.getByRole('heading', { name: '其他' })).toBeVisible();
  await expect(rail.getByRole('button', { name: '主机' })).toHaveAttribute('aria-pressed', 'true');
  await expect(rail.getByRole('button', { name: '交换机' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('resource-model-groups-rail-1440-light-zh-CN.png') });

  // A group folds its models and reopens on the same heading.
  const serverGroup = rail.getByRole('button', { name: /服务器/ });
  await expect(serverGroup).toHaveAttribute('aria-expanded', 'true');
  await serverGroup.click();
  await expect(serverGroup).toHaveAttribute('aria-expanded', 'false');
  await expect(rail.getByRole('button', { name: '主机' })).toHaveCount(0);
  await serverGroup.click();
  await expect(rail.getByRole('button', { name: '主机' })).toHaveAttribute('aria-pressed', 'true');

  // Searching narrows the sections; a group with no match disappears.
  await page.getByRole('searchbox', { name: '搜索模型对象' }).fill('交换');
  await expect(rail.getByRole('heading', { name: '服务器' })).toHaveCount(0);
  await expect(rail.getByRole('heading', { name: '其他' })).toBeVisible();
  await expect(rail.getByRole('button', { name: '交换机' })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('resource data lists every model attribute and saves the chosen columns', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockInstanceDetail(page);
  let saved: unknown = null;
  // Only two columns are subscribed; the picker must still offer the rest.
  await page.route('**/api/v1/cmdb/preferences/ci-types/host/fields', (route) =>
    route.fulfill({
      json: {
        type_id: 1,
        is_subscribed: true,
        fields: [{ attr_id: 10, is_fixed: true }, { attr_id: 11, is_fixed: false }],
      },
    }),
  );
  await page.route('**/api/v1/cmdb/preferences/ci-types/1/fields', (route) => {
    saved = route.request().postDataJSON();
    return route.fulfill({ json: { type_id: 1, is_subscribed: true, fields: [] } });
  });

  await page.goto('/cmdb/instances?type=host');
  await expect(page.getByRole('columnheader', { name: '说明' })).toBeVisible();
  await page.getByRole('button', { name: '查看并选择模型字段' }).click();

  const dialog = page.getByRole('dialog', { name: /属性说明/ });
  await expect(dialog).toBeVisible();
  // The definition table, not a bare name list.
  for (const header of ['名称', '别名', '类型', '可检索', '默认展示', '唯一', '枚举', '多值', '可排序', '计算属性']) {
    await expect(dialog.getByRole('columnheader', { name: header })).toBeVisible();
  }
  // The complete attribute set is listed, not only the subscribed columns.
  await expect(dialog.getByRole('checkbox', { name: '操作系统' })).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: '主机名' })).toBeDisabled();
  await expect(dialog.getByRole('img', { name: '标识列，固定显示' })).toBeVisible();
  // Flags render as marks in the definition columns.
  await expect(
    dialog.getByRole('row', { name: /hostname/ }).getByRole('img', { name: '是' }).first(),
  ).toBeVisible();
  await dialog.getByRole('checkbox', { name: '操作系统' }).click();
  await page.screenshot({ path: testInfo.outputPath('resource-data-attributes-dialog-1440-light-zh-CN.png') });
  await dialog.getByRole('button', { name: '保存' }).click();

  await expect(page.getByRole('columnheader', { name: '操作系统' })).toBeVisible();
  expect(saved).toEqual({
    fields: [
      { ref: '10', is_fixed: true },
      { ref: '11', is_fixed: false },
      { ref: '20', is_fixed: false },
    ],
  });

  // The table scrolls inside the dialog; the page itself must not overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '查看并选择模型字段' }).click();
  await expect(page.getByRole('dialog', { name: /属性说明/ })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('resource-data-attributes-dialog-390-light-zh-CN.png') });
});

test('resource data searches the whole model on the server', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockInstanceDetail(page);
  let searchBody: unknown = null;
  await page.route('**/api/v1/cmdb/ci/s', async (route) => {
    searchBody = route.request().postDataJSON();
    return route.fulfill({
      json: {
        numfound: 1,
        total: 1,
        page: 1,
        result: [{
          _id: 77, _type: 1, ci_id: 77, ci_type: 'host',
          hostname: 'web-77', note: 'server match', data_status: 'active',
        }],
      },
    });
  });

  await page.goto('/cmdb/instances?type=host');
  await expect(page.getByText('host-05').first()).toBeVisible();

  // Enter commits the term to the DSL endpoint; typing alone does not search.
  const box = page.getByRole('searchbox', { name: '搜索全部实例' });
  await box.fill('web-77');
  await box.press('Enter');

  const table = page.locator('.cmdb-table');
  await expect(table.getByText('web-77', { exact: true })).toBeVisible();
  await expect(table.getByText('server match', { exact: true })).toBeVisible();
  await expect(page.getByText('host-05')).toHaveCount(0);
  expect(searchBody).toMatchObject({ q: '_type:1,*web-77*', page: 1, count: 20 });
  await expect(page.getByText(/命中 1 条/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('resource-data-server-search-1440-light-zh-CN.png') });

  // Clearing the term returns to the ordinary list endpoint.
  await page.getByRole('button', { name: '清除搜索' }).click();
  await expect(page.getByText('host-05').first()).toBeVisible();
  await expect(page.getByText(/命中 1 条/)).toHaveCount(0);
});

test('the new relation form defines both sides, a constraint and attribute associations', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockAPI(page);
  const DISK = { ...HOST, id: 2, name: 'disk', alias: '磁盘', order: 1, unique_key: 'sn' };
  const attr = (id: number, name: string, alias: string) => ({
    id, name, alias, value_type: '2', is_list: false, is_choice: false, is_unique: false,
    is_index: true, is_indexed: true, is_password: false, is_bool: false, is_reference: false,
    is_sortable: false, is_computed: false, is_required: false, order: id,
    default_show: true, inherited: false,
  });
  let posted: unknown = null;
  await page.route('**/api/v1/cmdb/ci-types', (route) =>
    route.fulfill({ json: { items: [HOST, DISK], total: 2 } }),
  );
  await page.route('**/api/v1/cmdb/ci-types/1/attributes', (route) =>
    route.fulfill({ json: { type_id: 1, unique_id: 10, unique: 'hostname', attributes: [attr(10, 'hostname', '主机名')] } }),
  );
  await page.route('**/api/v1/cmdb/ci-types/2/attributes', (route) =>
    route.fulfill({ json: { type_id: 2, unique_id: 20, unique: 'sn', attributes: [attr(20, 'sn', '序列号')] } }),
  );
  await page.route('**/api/v1/cmdb/relation-types', (route) =>
    route.fulfill({ json: { items: [{ id: 5, name: '包含', color: '#6366f1' }], total: 1 } }),
  );
  await page.route('**/api/v1/cmdb/ci-types/1/relation-children/2', async (route) => {
    posted = route.request().postDataJSON();
    return route.fulfill({ json: { ctr_id: 1 } });
  });

  await page.goto('/cmdb/relations');
  await page.getByRole('button', { name: '新增关系' }).click();
  const dialog = page.getByRole('dialog', { name: '新增关系' });
  await expect(dialog).toBeVisible();
  for (const label of ['源 CI 类型', '目标 CI 类型', '关联类型', '关系约束', '属性关联']) {
    await expect(dialog.getByText(label, { exact: true }).first()).toBeVisible();
  }

  await dialog.getByRole('combobox', { name: '源 CI 类型' }).click();
  await page.getByRole('option', { name: '主机' }).click();
  await dialog.getByRole('combobox', { name: '目标 CI 类型' }).click();
  await page.getByRole('option', { name: '磁盘' }).click();
  await dialog.getByRole('combobox', { name: '关联类型' }).click();
  await page.getByRole('option', { name: '包含' }).click();
  await expect(dialog.getByRole('combobox', { name: '关系约束' })).toHaveText('一对多');

  // One mapping row is present from the start; both sides are combinable.
  const sourceAttr = dialog.getByRole('combobox', { name: '源属性 1' });
  await expect(sourceAttr).toBeEnabled();
  await sourceAttr.click();
  await page.getByRole('option', { name: '主机名（hostname）' }).click();
  await dialog.getByRole('combobox', { name: '目标属性 1' }).click();
  await page.getByRole('option', { name: '序列号（sn）' }).click();

  // Add and remove a second association; the first one survives.
  await dialog.getByRole('button', { name: '添加属性关联' }).first().click();
  await expect(dialog.getByRole('combobox', { name: '源属性 2' })).toBeVisible();
  await dialog.getByRole('button', { name: '删除第 2 条属性关联' }).click();
  await expect(dialog.getByRole('combobox', { name: '源属性 2' })).toHaveCount(0);
  await expect(dialog.getByRole('combobox', { name: '源属性 1' })).toHaveText('主机名（hostname）');
  await page.screenshot({ path: testInfo.outputPath('relation-create-form-1440-light-zh-CN.png') });

  await dialog.getByRole('button', { name: '保存' }).click();
  await expect.poll(() => posted).toEqual({
    relation_type_id: 5,
    constraint: '0',
    parent_attr_ids: [10],
    child_attr_ids: [20],
  });
});

test('the relation table shows model icons and the attribute association', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockAPI(page);
  const DISK = { ...HOST, id: 2, name: 'disk', alias: '磁盘', order: 1, unique_key: 'sn' };
  const attr = (id: number, name: string, alias: string) => ({
    id, name, alias, value_type: '2', is_list: false, is_choice: false, is_unique: false,
    is_index: true, is_indexed: true, is_password: false, is_bool: false, is_reference: false,
    is_sortable: false, is_computed: false, is_required: false, order: id,
    default_show: true, inherited: false,
  });
  const edge = (type: typeof HOST, attributes: unknown[]) => ({
    ctr_id: 11, type, attributes,
    relation_type: { id: 5, name: '包含', color: '#6366f1' },
    constraint: '0',
    parent_attr_ids: [10],
    child_attr_ids: [20],
  });
  await page.route('**/api/v1/cmdb/ci-type-relations', (route) =>
    route.fulfill({
      json: { items: [{
        id: 11,
        parent: edge(HOST, [attr(10, 'hostname', '主机名')]),
        child: edge(DISK, [attr(20, 'sn', '序列号')]),
      }], total: 1 },
    }),
  );

  await page.goto('/cmdb/relations');
  await expect(page.getByRole('columnheader', { name: '源 CI 类型' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '属性关联' })).toBeVisible();
  const source = page.getByRole('link', { name: '主机' });
  await expect(source).toBeVisible();
  await expect(source.locator('svg')).toBeVisible();
  await expect(page.getByRole('link', { name: '磁盘' })).toBeVisible();
  await expect(page.getByText('主机名 → 序列号')).toBeVisible();
  await expect(page.getByRole('button', { name: '删除 host → disk' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('relations-table-1440-light-zh-CN.png') });
});

test('resource data hides the rail and uses the model Select on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockAPI(page);
  await mockInstanceData(page, true);

  await page.goto('/cmdb/instances?type=host');
  await expect(page.getByRole('heading', { name: /资源数据/ })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '模型对象' })).not.toBeVisible();

  const select = page.getByRole('combobox', { name: '模型' });
  await expect(select).toBeVisible();
  await select.click();
  await page.getByRole('option', { name: '交换机' }).click();
  await expect(page.getByText('sw-01').first()).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('resource detail shows its values, topology, change history and trigger records', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockInstanceDetail(page);

  await page.goto('/cmdb/instances?type=host');
  await expect(page.getByRole('heading', { name: /资源数据/ })).toBeVisible();
  await page.getByRole('button', { name: '查看实例 5' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('tab')).toHaveCount(4);
  await expect(drawer.getByText('host-05').first()).toBeVisible();
  // The attribute section uses the same card header as 关联关系.
  await expect(drawer.getByRole('heading', { name: '属性' })).toBeVisible();
  await expect(drawer.getByRole('button', { name: '刷新' }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('resource-detail-overview-1440-light-zh-CN.png') });

  const relations = drawer.getByText('关联关系', { exact: true });
  await relations.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('resource-detail-relations-1440-light-zh-CN.png') });

  const stickyTabs = await drawer.evaluate((dialog) => {
    const scroller = dialog.querySelector('.overflow-y-auto');
    const tabs = dialog.querySelector('[role="tablist"]');
    if (!scroller || !tabs) return null;
    scroller.scrollTop = 140;
    const scrollerRect = scroller.getBoundingClientRect();
    const tabsRect = tabs.getBoundingClientRect();
    const top = document.elementFromPoint(tabsRect.left + 20, scrollerRect.top + 5);
    return {
      gap: Math.round(tabsRect.top - scrollerRect.top),
      coversPadding: top === tabs || tabs.contains(top),
    };
  });
  expect(stickyTabs).not.toBeNull();
  expect(Math.abs(stickyTabs?.gap ?? 99)).toBeLessThanOrEqual(1);
  expect(stickyTabs?.coversPadding).toBe(true);

  await drawer.getByRole('tab', { name: '拓扑' }).click();
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect(drawer.getByText('rack-01')).toBeVisible();
  await expect(drawer.getByText('sda')).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: testInfo.outputPath('resource-detail-topology-1440-light-zh-CN.png') });

  await drawer.getByRole('button', { name: '展开 rack-01' }).click();
  await expect(drawer.getByText('idc-01')).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: testInfo.outputPath('resource-detail-topology-expanded-1440-light-zh-CN.png') });

  await drawer.getByText('机柜', { exact: true }).click();
  await expect(drawer.getByRole('button', { name: '关闭节点详情' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('resource-detail-topology-node-card-1440-light-zh-CN.png') });
  await drawer.getByRole('button', { name: '关闭节点详情' }).click();

  await drawer.getByRole('tab', { name: '变更历史' }).click();
  await expect(drawer.getByText('host-04')).toBeVisible();
  await expect(drawer.getByText('运维')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('resource-detail-history-1440-light-zh-CN.png') });

  await drawer.getByRole('tab', { name: '触发记录' }).click();
  await expect(drawer.getByText('主机变更通知')).toBeVisible();
  await expect(drawer.getByText('成功')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('resource-detail-triggers-1440-light-zh-CN.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('resource-detail-triggers-390-light-zh-CN.png') });
});

test('resource detail edits one attribute in place', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockInstanceDetail(page);

  // The drawer refreshes the instance after a write; keep the mocked read in
  // step with the write so the saved value does not flip back.
  let values = { ...INSTANCE_ROWS[4].values };
  const writes: unknown[] = [];
  await page.route('**/api/v1/cmdb/instances/5', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { values?: Record<string, unknown> };
      writes.push(body);
      values = { ...values, ...(body.values ?? {}) };
      return route.fulfill({ json: { ci_id: 5, created: false } });
    }
    return route.fulfill({ json: { ci_id: 5, type_id: 1, values } });
  });

  await page.goto('/cmdb/instances?type=host');
  await page.getByRole('button', { name: '查看实例 5' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('host-05').first()).toBeVisible();

  await drawer.getByText('说明', { exact: true }).hover();
  await drawer.getByRole('button', { name: '编辑 说明' }).click();
  const input = drawer.getByRole('textbox', { name: '说明' });
  await expect(input).toBeVisible();
  await input.fill('rack Z');
  // There is no Save button: Enter (or leaving the field) writes the value.
  await input.press('Enter');

  await expect(page.getByText('已保存')).toBeVisible();
  await expect(drawer.getByText('rack Z')).toBeVisible();
  // ONLY THE EDITED FIELD IS WRITTEN: the rest of the instance is not resent.
  expect(writes).toEqual([{ values: { note: 'rack Z' } }]);

  // Leaving the field is the other save path: no confirmation step at all.
  await drawer.getByText('说明', { exact: true }).hover();
  await drawer.getByRole('button', { name: '编辑 说明' }).click();
  await drawer.getByRole('textbox', { name: '说明' }).fill('rack Y');
  await drawer.getByRole('heading', { name: 'host-05' }).click();
  await expect(drawer.getByText('rack Y')).toBeVisible();
  expect(writes).toEqual([
    { values: { note: 'rack Z' } },
    { values: { note: 'rack Y' } },
  ]);

  // Escape abandons the draft and must cancel the row, not the drawer.
  await drawer.getByText('说明', { exact: true }).hover();
  await drawer.getByRole('button', { name: '编辑 说明' }).click();
  const discarded = drawer.getByRole('textbox', { name: '说明' });
  await discarded.fill('discard me');
  await discarded.press('Escape');
  await expect(drawer.getByRole('textbox', { name: '说明' })).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('rack Y')).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('resource-detail-inline-saved-1440-light-zh-CN.png') });
});

test('resource detail topology switches to a double-clicked node', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockInstanceDetail(page);

  // The drawer resolves a cross-model target through the model list and that
  // model's own metadata; the rack type is not in the host page's list.
  const RACK = { ...HOST, id: 3, name: 'rack', alias: '机柜', unique_key: 'name' };
  const RACK_ATTRIBUTE = { id: 30, name: 'name', alias: '名称', value_type: '2', is_list: false, is_index: true };
  await page.route(
    (url) => url.pathname === '/api/v1/cmdb/ci-types' && url.searchParams.get('ids') === '3',
    (route) => route.fulfill({ json: { items: [RACK], total: 1 } }),
  );
  await page.route('**/api/v1/cmdb/instances/41', (route) =>
    route.fulfill({ json: { ci_id: 41, type_id: 3, values: { name: 'rack-01' } } }),
  );
  await page.route('**/api/v1/cmdb/ci-types/rack/attributes', (route) =>
    route.fulfill({ json: { type_id: 3, unique_id: 30, unique: 'name', attributes: [RACK_ATTRIBUTE] } }),
  );
  await page.route('**/api/v1/cmdb/ci-types/rack/attribute-groups*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/cmdb/ci-types/rack/relation-parents', (route) =>
    route.fulfill({ json: { items: [], total: 0 } }),
  );
  await page.route('**/api/v1/cmdb/ci-types/rack/relation-children', (route) =>
    route.fulfill({ json: { items: [], total: 0 } }),
  );

  await page.goto('/cmdb/instances?type=host');
  await expect(page.getByRole('heading', { name: /资源数据/ })).toBeVisible();
  await page.getByRole('button', { name: '实例 5 拓扑' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.locator('.react-flow')).toBeVisible();
  await expect(drawer.getByText('机柜', { exact: true })).toBeVisible();

  await drawer.getByText('机柜', { exact: true }).dblclick();

  // Cantor switched the whole detail panel and kept the topology tab active.
  await expect(drawer.getByRole('heading', { name: 'rack-01' })).toBeVisible();
  await expect(drawer.getByText('ID: 41', { exact: true })).toBeVisible();
  await expect(drawer.getByRole('tab', { name: '拓扑' })).toHaveAttribute('aria-selected', 'true');
  // The page's edit form belongs to the host model, so editing is not offered
  // after a cross-model switch.
  await expect(drawer.getByRole('button', { name: '编辑' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('resource-detail-topology-switched-1440-light-zh-CN.png') });
});

test('resource topology expands inside a phone drawer', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockInstanceDetail(page);

  await page.goto('/cmdb/instances?type=host');
  await expect(page.getByRole('heading', { name: /资源数据/ })).toBeVisible();
  await page.getByRole('button', { name: '实例 5 拓扑' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('tab', { name: '拓扑' })).toBeVisible();
  await expect(drawer.locator('.react-flow')).toBeVisible();
  await expect(drawer.getByText('rack-01')).toBeVisible();

  await drawer.getByRole('button', { name: '展开 rack-01' }).click();
  await expect(drawer.getByText('idc-01')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('resource-detail-topology-390-light-zh-CN.png') });
});

const DETAIL_WIDTHS = [390, 768, 1280, 1920];
const DETAIL_THEMES = ['light', 'dark'] as const;
const DETAIL_LOCALES = ['zh-CN', 'en-US'] as const;

for (const width of DETAIL_WIDTHS) {
  for (const theme of DETAIL_THEMES) {
    for (const locale of DETAIL_LOCALES) {
      test(`resource detail drawer ${width}px ${theme} ${locale}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(({ locale, theme }) => {
          localStorage.setItem('ongrid-locale', locale);
          localStorage.setItem('ongrid-theme-preference', theme);
          localStorage.setItem('ongrid.auth', JSON.stringify({
            state: {
              token: 'e2e-token', refreshToken: null,
              email: 'e2e@example.com', role: 'admin',
            },
            version: 0,
          }));
        }, { locale, theme });
        await mockInstanceDetail(page);

        await page.goto('/cmdb/instances?type=host');
        await expect(page.getByRole('heading', { name: locale === 'en-US' ? /Resources/ : /资源数据/ })).toBeVisible();
        await page.getByRole('button', { name: locale === 'en-US' ? 'View instance 5' : '查看实例 5' }).click();
        const drawer = page.getByRole('dialog');
        await expect(drawer).toBeVisible();
        await expect(drawer.getByRole('tab')).toHaveCount(4);

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(1);
        await page.screenshot({
          path: testInfo.outputPath(`resource-detail-${width}-${theme}-${locale}.png`),
        });

        // Inline editing is a new control on every row; open it at every width,
        // theme and locale before moving on to the topology.
        await drawer.getByText('说明', { exact: true }).hover();
        await drawer.getByRole('button', {
          name: locale === 'en-US' ? 'Edit 说明' : '编辑 说明',
        }).click();
        await expect(drawer.getByRole('textbox', { name: '说明' })).toBeVisible();
        const editOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(editOverflow).toBeLessThanOrEqual(1);
        await page.screenshot({
          path: testInfo.outputPath(`resource-detail-inline-edit-${width}-${theme}-${locale}.png`),
        });
        // Leaving an unchanged field closes the row without a write.
        await page.keyboard.press('Tab');
        await expect(drawer.getByRole('textbox', { name: '说明' })).toHaveCount(0);

        // The topology node card gained the keyboard/touch switch; check it at
        // every width and theme rather than only in the 1440 flow.
        await drawer.getByRole('tab', { name: locale === 'en-US' ? 'Topology' : '拓扑' }).click();
        await expect(drawer.locator('.react-flow')).toBeVisible();
        await drawer.getByText('机柜', { exact: true }).click();
        const switchButton = drawer.getByRole('button', {
          name: locale === 'en-US' ? 'Switch to this resource' : '切换到此资源',
        });
        await expect(switchButton).toBeVisible();
        await expect(switchButton).toBeInViewport();
        const topologyOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(topologyOverflow).toBeLessThanOrEqual(1);
        await page.screenshot({
          path: testInfo.outputPath(`resource-detail-topology-card-${width}-${theme}-${locale}.png`),
        });
      });
    }
  }
}

test('the model definition can be viewed, copied and downloaded', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          (window as unknown as { __copiedModelDefinition?: string }).__copiedModelDefinition = text;
          return Promise.resolve();
        },
      },
    });
  });
  await mockAPI(page);
  await mockModelDefinition(page);

  await page.goto('/cmdb/models/1');
  await expect(page.getByRole('heading', { level: 1, name: /主机/ })).toBeVisible();
  await page.getByRole('button', { name: '模型定义' }).click();

  await expect(page.getByRole('dialog')).toBeVisible();
  const json = page.getByLabel('模型定义 JSON');
  await expect(json).toContainText('"format": "ongrid.cmdb.model"');
  await expect(json).toContainText('"hostname"');
  await expect(json).toContainText('"unique_constraints"');
  await expect(json).not.toContainText('must-not-leak');

  await page.getByRole('button', { name: '复制 JSON' }).click();
  await expect(page.getByRole('status')).toContainText('已复制模型定义');
  const copied = await page.evaluate(
    () => (window as unknown as { __copiedModelDefinition?: string }).__copiedModelDefinition ?? '',
  );
  expect(copied).toContain('"format": "ongrid.cmdb.model"');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '下载 JSON' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('cmdb-model-host.json');
});

test('the model definition drawer stays inside a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockAPI(page);
  await mockModelDefinition(page);

  await page.goto('/cmdb/models/1');
  await expect(page.getByRole('heading', { level: 1, name: /主机/ })).toBeVisible();
  await page.getByRole('button', { name: '模型定义' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('模型定义 JSON')).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('the attribute type filter and effective type icon work in both views', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockAttributeWorkspace(page);

  await page.goto('/cmdb/models/1');
  await expect(page.getByRole('heading', { level: 1, name: /主机/ })).toBeVisible();

  const table = page.getByRole('table').first();
  await expect(table.getByText('短文本', { exact: true })).toBeVisible();
  await expect(table.locator('[data-attribute-type-icon="2"]')).toHaveCount(1);

  const integerFilter = page.getByRole('button', { name: '整数', exact: true });
  await expect(integerFilter).toHaveAttribute('aria-pressed', 'false');
  await integerFilter.click();
  await expect(integerFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(table.getByText('核数', { exact: true })).toBeVisible();
  await expect(table.getByText('主机名', { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('attribute-workspace-1440-filter-active-light-zh-CN.png'),
  });

  await integerFilter.click();
  await expect(integerFilter).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '网格', exact: true }).click();

  const card = page.locator('article').filter({ hasText: 'Root 密码' });
  await expect(card.locator('[data-attribute-type-icon="7"]')).toBeVisible();
  await expect(card.getByText('密码', { exact: true })).toBeVisible();
  await expect(card.getByText('唯一', { exact: true })).toBeVisible();
  await expect(card.getByText('*', { exact: true })).toBeVisible();

  await card.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('attribute-workspace-1440-grid-light-zh-CN.png'),
  });

  await page.setViewportSize({ width: 1920, height: 900 });
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('attribute-workspace-1920-grid-light-zh-CN.png'),
  });
});

const ATTRIBUTE_WIDTHS = [390, 768, 1280, 1920];
const ATTRIBUTE_THEMES = ['light', 'dark'] as const;
const ATTRIBUTE_LOCALES = ['zh-CN', 'en-US'] as const;

for (const width of ATTRIBUTE_WIDTHS) {
  for (const theme of ATTRIBUTE_THEMES) {
    for (const locale of ATTRIBUTE_LOCALES) {
      test(`attribute workspace ${width}px ${theme} ${locale}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(({ locale, theme }) => {
          localStorage.setItem('ongrid-locale', locale);
          localStorage.setItem('ongrid-theme-preference', theme);
          localStorage.setItem('ongrid.auth', JSON.stringify({
            state: {
              token: 'e2e-token', refreshToken: null,
              email: 'e2e@example.com', role: 'admin',
            },
            version: 0,
          }));
        }, { locale, theme });
        await mockAttributeWorkspace(page);

        await page.goto('/cmdb/models/1');
        await expect(page.getByRole('heading', { level: 1, name: /主机/ })).toBeVisible();
        const filterLabel = locale === 'en-US' ? 'Short text' : '短文本';
        await expect(page.getByRole('button', { name: filterLabel, exact: true })).toBeVisible();

        const content = page.locator('.cmdb-liquid-content');
        const firstTypeIcon = content.locator('[data-attribute-type-icon]').first();
        await expect(firstTypeIcon).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(`attribute-workspace-${width}-${theme}-${locale}-top.png`),
        });

        await firstTypeIcon.scrollIntoViewIfNeeded();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(1);

        await page.screenshot({
          path: testInfo.outputPath(`attribute-workspace-${width}-${theme}-${locale}-attributes.png`),
        });
      });
    }
  }
}

test('IPAM workspace: merge, filter, edit, history', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'light');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockAPI(page);

  await page.goto('/cmdb/ipam?tab=address&node=2');
  await expect(page.getByRole('heading', { name: 'IP 地址空间' })).toBeVisible();

  const tree = page.getByRole('tree');
  await expect(tree.getByText('办公网段')).toBeVisible();
  // Both the group and the range show their host count.
  await expect(tree.getByText('254').first()).toBeVisible();

  // The whole range is shown: a host nobody registered is still a row.
  await expect(page.getByText('10.0.0.11', { exact: true })).toBeVisible();
  await expect(page.getByText('10.0.0.13', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /未使用 \(253\)/ })).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('ipam-address-1440-light-zh.png') });

  // The table scrolls in its own container, never the page.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  await page.getByRole('button', { name: '网格视图' }).click();
  await expect(page.getByRole('button', { name: '10.0.0.11', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '表格视图' }).click();

  // A plain row click opens the editor seeded from that row.
  await page.getByText('10.0.0.11', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('已选择 1 个 IP')).toBeVisible();
  await expect(dialog.getByLabel('用途')).toHaveValue('web');
  await dialog.getByRole('button', { name: '取消' }).click();

  await page.getByRole('tab', { name: '历史' }).click();
  await expect(page.getByText('分配地址')).toBeVisible();
  await expect(page.getByRole('table').getByText('运维')).toBeVisible();
  await page.getByRole('tab', { name: '扫描日志' }).click();
  await page.getByRole('button', { name: '查看扫描结果' }).click();
  await expect(page.getByText('2 hosts up')).toBeVisible();
});

test('IPAM address table stays inside the page at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('ongrid-locale', 'zh-CN');
    localStorage.setItem('ongrid-theme-preference', 'dark');
    localStorage.setItem('ongrid.auth', JSON.stringify({
      state: { token: 'e2e-token', refreshToken: null, email: 'e2e@example.com', role: 'admin' },
      version: 0,
    }));
  });
  await mockAPI(page);

  await page.goto('/cmdb/ipam?tab=address&node=2');
  await expect(page.getByText('10.0.0.11', { exact: true })).toBeVisible();
  const metrics = await page.evaluate(() => {
    const table = document.querySelector('table');
    const scroller = table?.parentElement;
    return {
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tableOverflow: scroller ? scroller.scrollWidth - scroller.clientWidth : 0,
      actionPosition: table ? getComputedStyle(table.querySelector('td.sticky') ?? table).position : '',
    };
  });
  // The page does not widen; the table scrolls inside its card. Below `sm` the
  // action column is static so it cannot cover the only visible data column.
  expect(metrics.pageOverflow).toBeLessThanOrEqual(1);
  expect(metrics.tableOverflow).toBeGreaterThan(0);
  expect(metrics.actionPosition).toBe('static');
});

for (const pageDef of PAGES) {
  const widths = [390, 768, 1280, 1920];
  const themes = ['light', 'dark'] as const;
  const locales = ['zh-CN', 'en-US'] as const;
  for (const width of widths) {
    for (const theme of themes) {
      for (const locale of locales) {
        test(`${pageDef.name} ${width}px ${theme} ${locale}`, async ({ page }, testInfo) => {
          await page.setViewportSize({ width, height: 900 });
          await page.addInitScript(({ locale, theme }) => {
            localStorage.setItem('ongrid-locale', locale);
            localStorage.setItem('ongrid-theme-preference', theme);
            localStorage.setItem('ongrid.auth', JSON.stringify({
              state: {
                token: 'e2e-token', refreshToken: null,
                email: 'e2e@example.com', role: 'admin',
              },
              version: 0,
            }));
          }, { locale, theme });
          await mockAPI(page);

          await page.goto(pageDef.path);
          await expect(page.getByRole('heading', { name: locale === 'en-US' ? pageDef.headingEn : pageDef.heading })).toBeVisible();
          await expect(page.locator('html')).toHaveClass(theme === 'light' ? /\blight\b/ : /\bdark\b/);
          // Let a lazy route and a mocked fetch settle before measuring.
          await page.waitForTimeout(300);

          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow).toBeLessThanOrEqual(1);

          await page.screenshot({
            path: testInfo.outputPath(`${pageDef.name}-${width}-${theme}-${locale}.png`),
            fullPage: false,
          });
        });
      }
    }
  }
}
