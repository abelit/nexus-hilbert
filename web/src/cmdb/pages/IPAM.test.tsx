import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/test/msw-server';
import { useAuth } from '@/store/auth';
import IPAMPage from './IPAM';
import { ToastProvider } from '../components/Toast';

// These tests drive several mocked endpoints and a stateful table; under a
// fully parallel suite the default 5s is a scheduler test, not a behaviour one.
vi.setConfig({ testTimeout: 15000 });

const scope = {
  _id: 1,
  _type: 11,
  ci_type: 'ipam_scope',
  ci_type_alias: '地址分组',
  name: '生产网',
  children: [
    {
      _id: 2,
      _type: 12,
      ci_type: 'ipam_subnet',
      ci_type_alias: '子网',
      name: '办公网段',
      cidr: '10.0.0.0/24',
      children: [],
    },
  ],
};

const tree = { result: [scope], type2name: { '11': 'name', '12': 'name' } };

const summary = {
  subnet_num: 1,
  address_num: 254,
  address_free_num: 250,
  address_assign_num: 4,
  address_unassign_num: 250,
  address_used_num: 2,
  address_used_free_num: 252,
  subnets: [
    {
      _id: 2,
      _type: 12,
      ci_type: 'ipam_subnet',
      ci_type_alias: '子网',
      name: '办公网段',
      cidr: '10.0.0.0/24',
      hosts_count: 254,
      assign_count: 4,
      used_count: 2,
      free_count: 250,
      scan_enabled: true,
      last_scan_time: '2026-10-18 03:00:00',
    },
  ],
};

const hosts = Array.from({ length: 254 }, (_, index) => `10.0.0.${index + 1}`);

const addresses = {
  numfound: 2,
  total: 2,
  page: 1,
  counter: {},
  result: [
    {
      _id: 21,
      _type: 13,
      ci_id: 21,
      ci_type: 'ipam_address',
      ci_type_alias: '地址',
      ip: '10.0.0.11',
      assign_status: 0,
      is_used: 1,
      name: '10.0.0.11',
      usage: 'web',
      use_obj: '服务器',
      mac_address: 'aa:bb:cc:dd:ee:ff',
      _updated_at: '2026-10-18 09:00:00',
    },
    {
      _id: 22,
      _type: 13,
      ci_id: 22,
      ci_type: 'ipam_address',
      ci_type_alias: '地址',
      ip: '10.0.0.12',
      assign_status: 1,
      is_used: 0,
      name: '10.0.0.12',
    },
  ],
};

const subnetDetail = {
  _id: 2,
  _type: 12,
  name: '办公网段',
  cidr: '10.0.0.0/24',
  hosts_count: 254,
  assign_count: 4,
  used_count: 2,
  free_count: 250,
  scan_enabled: true,
  agent_id: '0x0000',
  cron: '0 3 * * *',
  last_scan_time: '2026-10-18 03:00:00',
};

const operations = {
  numfound: 1,
  result: [
    {
      _id: 9,
      cidr: '10.0.0.0/24',
      uid: 7,
      operate_type: '6',
      description: '10.0.0.11',
      created_at: '2026-10-18 09:00:00',
    },
  ],
};

const scans = {
  numfound: 1,
  result: [
    {
      _id: 5,
      exec_id: 'abc123',
      cidr: '10.0.0.0/24',
      status: 0,
      ip_num: 2,
      stdout: '2 hosts up',
      start_at: '2026-10-18 03:00:00',
      end_at: '2026-10-18 03:00:11',
      created_at: '2026-10-18 03:00:00',
    },
  ],
};

function renderPage(entry = '/cmdb/ipam') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ToastProvider>
        <IPAMPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

function handlers() {
  server.use(
    http.get('/api/v1/cmdb/ipam/tree-view', () => HttpResponse.json(tree)),
    http.get('/api/v1/cmdb/ipam/stats', () => HttpResponse.json(summary)),
    http.get('/api/v1/cmdb/ipam/addresses', () => HttpResponse.json(addresses)),
    http.get('/api/v1/cmdb/ipam/subnets/hosts', () =>
      HttpResponse.json({ hosts, truncated: false }),
    ),
    http.get('/api/v1/cmdb/ipam/subnets/:id', () => HttpResponse.json(subnetDetail)),
    http.get('/api/v1/cmdb/ipam/history/operations', () => HttpResponse.json(operations)),
    http.get('/api/v1/cmdb/ipam/history/scans', () => HttpResponse.json(scans)),
    http.get('/api/v1/cmdb/ci-types/ipam_subnet', () => HttpResponse.json({ id: 12, name: 'ipam_subnet' })),
    http.get('/api/v1/cmdb/ci-types/ipam_address', () => HttpResponse.json({ id: 13, name: 'ipam_address' })),
    http.get('/api/v1/cmdb/ci-types/ipam_address/attributes', () =>
      HttpResponse.json({
        type_id: 13,
        unique_id: 118,
        unique: 'ip',
        attributes: [
          {
            id: 1,
            name: 'use_obj',
            alias: '使用对象',
            is_choice: true,
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
      }),
    ),
    http.get('/api/v1/users', () =>
      HttpResponse.json({ items: [{ id: 7, email: 'alice@example.com', display_name: 'Alice' }], total: 1 }),
    ),
    http.post('/api/v1/cmdb/ci/s', () => HttpResponse.json({ numfound: 0, total: 0, page: 1, result: [] })),
  );
}

async function treeItem(name: string): Promise<HTMLElement> {
  const region = await screen.findByRole('tree');
  return within(region).getByText(name);
}

async function openTab(name: RegExp | string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name }));
  return user;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  useAuth.setState({ token: null, role: 'admin' });
});

describe('the address-space shell', () => {
  it('shows the All row, the tree’s group and range, the range’s CIDR and host count', async () => {
    handlers();
    renderPage();

    expect((await screen.findAllByText('全部')).length).toBeGreaterThan(0);
    const region = await screen.findByRole('tree');
    expect(within(region).getByText('生产网')).toBeInTheDocument();
    expect(within(region).getByText('办公网段')).toBeInTheDocument();
    // The range's CIDR is shown by the overview table; the tree keeps the name
    // and the host count so long names are not truncated into nothing.
    expect(screen.getAllByText('10.0.0.0/24').length).toBeGreaterThan(0);
    // The count badge is computed arithmetically, not enumerated.
    expect(within(region).getAllByText('254').length).toBeGreaterThan(0);
  });

  it('opens the tab and node named by the URL', async () => {
    handlers();
    renderPage('/cmdb/ipam?tab=address&node=2');

    expect(await screen.findByText('10.0.0.11')).toBeInTheDocument();
    expect(screen.getByText('总地址数')).toBeInTheDocument();
  });

  it('falls back to the whole space when the deep link names a node that is gone', async () => {
    handlers();
    renderPage('/cmdb/ipam?tab=overview&node=999');

    expect(await screen.findByText('全部地址空间')).toBeInTheDocument();
  });
});

describe('the overview', () => {
  it('reports the server’s totals, rows and scan state', async () => {
    handlers();
    renderPage();

    // THE FOUR CARDS ARE THE SERVER'S NUMBERS.
    expect(await screen.findByText('子网统计')).toBeInTheDocument();
    expect(screen.getByText('地址统计')).toBeInTheDocument();
    expect(screen.getByText('分配统计')).toBeInTheDocument();
    expect(screen.getByText('在线统计')).toBeInTheDocument();
    expect(screen.getAllByText('办公网段').length).toBeGreaterThan(0);
    // The scan state is a visible column; the last-scan timestamp is available
    // from the column picker, where a secondary timestamp belongs.
    expect(screen.getAllByText('开').length).toBeGreaterThan(0);
  });

  it('asks the server to scope the summary to the selected group', async () => {
    handlers();
    let parent = '';
    server.use(
      http.get('/api/v1/cmdb/ipam/stats', ({ request }) => {
        parent = new URL(request.url).searchParams.get('parent_id') ?? '';
        return HttpResponse.json(summary);
      }),
    );
    renderPage();

    const user = userEvent.setup();
    await user.click(await treeItem('生产网'));
    await waitFor(() => expect(parent).toBe('1'));
  });
});

describe('the address workspace', () => {
  it('lists every host, with a status derived from assignment and observation', async () => {
    handlers();
    renderPage('/cmdb/ipam?tab=address&node=2');

    // A HOST WITH NO STORED ROW IS STILL LISTED — as unused.
    expect(await screen.findByText('10.0.0.11')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.13')).toBeInTheDocument();
    expect(screen.getAllByText('已分配&在线').length).toBeGreaterThan(0);
    expect(screen.getAllByText('未使用').length).toBeGreaterThan(0);
    // 254 hosts, one assigned and one merely unassigned: 253 unused.
    expect(screen.getByRole('button', { name: /未使用 \(253\)/ })).toBeInTheDocument();
  });

  it('edits the model’s attributes and omits fields left blank', async () => {
    handlers();
    const posted: unknown[] = [];
    server.use(
      http.post('/api/v1/cmdb/ipam/addresses', async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ ci_ids: [21], created: 0, assign_count: 4, used_count: 2, free_count: 250 });
      }),
    );
    renderPage('/cmdb/ipam?tab=address&node=2');

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '编辑 10.0.0.11' }));
    const dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('用途'));
    await user.type(within(dialog).getByLabelText('用途'), 'db');
    await user.clear(within(dialog).getByLabelText('MAC'));
    await user.type(within(dialog).getByLabelText('MAC'), '11:22:33:44:55:66');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      subnet_id: 2,
      ips: ['10.0.0.11'],
      assign_status: 0,
      // Seeded from the row and still an option, so it is submitted; the blank
      // description and gateway are not.
      use_obj: '服务器',
      usage: 'db',
      mac_address: '11:22:33:44:55:66',
    });
  }, 15000);

  it('recycles an assigned address through the same endpoint', async () => {
    handlers();
    const posted: unknown[] = [];
    server.use(
      http.post('/api/v1/cmdb/ipam/addresses', async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ ci_ids: [21], created: 0, assign_count: 3, used_count: 1, free_count: 251 });
      }),
    );
    renderPage('/cmdb/ipam?tab=address&node=2');

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '回收 10.0.0.11' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ subnet_id: 2, ips: ['10.0.0.11'], assign_status: 1 });
  });

  it('filters by the derived status and by a search term', async () => {
    handlers();
    renderPage('/cmdb/ipam?tab=address&node=2');

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /未使用 \(253\)/ }));
    expect(screen.getByText('10.0.0.13')).toBeInTheDocument();
    expect(screen.queryByText('10.0.0.11')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /全部 \(254\)/ }));
    await user.type(screen.getByLabelText('搜索地址'), 'web');
    await waitFor(() => expect(screen.getByText('10.0.0.11')).toBeInTheDocument());
    expect(screen.queryByText('10.0.0.13')).not.toBeInTheDocument();
  });

  it('switches to the grid and explains the colours', async () => {
    handlers();
    renderPage('/cmdb/ipam?tab=address&node=2');

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '网格视图' }));
    expect(await screen.findByRole('button', { name: '10.0.0.11' })).toBeInTheDocument();
    expect(screen.getAllByText('已分配&在线').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('网格视图')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('the global IP search', () => {
  it('queries the address model and opens the editor with the row’s range', async () => {
    handlers();
    let query = '';
    server.use(
      http.post('/api/v1/cmdb/ci/s', async ({ request }) => {
        const body = (await request.json()) as { q: string };
        query = body.q;
        return HttpResponse.json({
          numfound: 1,
          total: 1,
          page: 1,
          result: [
            {
              _id: 21,
              _type: 13,
              ci_id: 21,
              ci_type: 'ipam_address',
              ip: '10.0.0.11',
              assign_status: 0,
              is_used: 1,
              name: 'host-a',
              mac_address: 'aa:bb:cc:dd:ee:ff',
            },
          ],
        });
      }),
    );
    renderPage();

    const user = await openTab('IP 搜索');
    await user.type(screen.getByLabelText('搜索地址'), '10.0.0.11');
    await waitFor(() => expect(query).toBe('_type:13,*10.0.0.11*'));
    expect(await screen.findByText('host-a')).toBeInTheDocument();
    expect(screen.getAllByText('10.0.0.0/24').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: '编辑 10.0.0.11' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('the range list', () => {
  it('lists ranges from the server and opens edit and delete from a row', async () => {
    handlers();
    server.use(
      http.post('/api/v1/cmdb/ci/s', () =>
        HttpResponse.json({
          numfound: 1,
          total: 1,
          page: 1,
          result: [
            {
              _id: 2,
              _type: 12,
              ci_type: 'ipam_subnet',
              name: '办公网段',
              cidr: '10.0.0.0/24',
              hosts_count: 254,
              assign_count: 4,
              used_count: 2,
              free_count: 250,
            },
          ],
        }),
      ),
    );
    renderPage();

    const user = await openTab('子网列表');
    const table = await screen.findByRole('table');
    expect(within(table).getByText('办公网段')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '编辑 办公网段' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));

    await user.click(screen.getByRole('button', { name: '删除 办公网段' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/不可撤销/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '删除' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/输入「办公网段」确认/), '办公网段');
    expect(within(dialog).getByRole('button', { name: '删除' })).toBeEnabled();
  });
});

describe('history', () => {
  it('labels operations, resolves the operator and shows a scan’s output', async () => {
    handlers();
    renderPage();

    const user = await openTab('历史');
    // OPERATION TYPE 6 IS "ADDRESS ASSIGNED"; the operator resolves through
    // the admin user list rather than showing a bare id.
    expect(await screen.findByText('分配地址')).toBeInTheDocument();
    expect(await screen.findByText('Alice')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: '扫描日志' }));
    expect(await screen.findByText('成功')).toBeInTheDocument();
    expect(screen.getByText('11s')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '查看扫描结果' }));
    expect(await screen.findByText('2 hosts up')).toBeInTheDocument();
  });
});

describe('creating a range', () => {
  it('sends the selected group as the parent and no scan fields when scanning is off', async () => {
    handlers();
    const posted: unknown[] = [];
    server.use(
      http.post('/api/v1/cmdb/ipam/subnets', async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ ci_id: 40 });
      }),
    );
    renderPage();

    const user = userEvent.setup();
    await user.click(await treeItem('生产网'));
    await user.click(await screen.findByRole('button', { name: '在此新建' }));

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('名称'), '研发网段');
    await user.type(within(dialog).getByLabelText(/网段 \(CIDR\)/), '10.0.9.0/24');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ parent_id: 1, cidr: '10.0.9.0/24', name: '研发网段' });
  });

  it('writes the model’s own identifying attribute when it is not `name`', async () => {
    handlers();
    server.use(
      http.get('/api/v1/cmdb/ci-types/ipam_subnet', () =>
        HttpResponse.json({ id: 12, name: 'ipam_subnet', unique_key: 'subnet_name' }),
      ),
    );
    const posted: unknown[] = [];
    server.use(
      http.post('/api/v1/cmdb/ipam/subnets', async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ ci_id: 40 });
      }),
    );
    renderPage();

    const user = userEvent.setup();
    await user.click(await treeItem('生产网'));
    await user.click(await screen.findByRole('button', { name: '在此新建' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('名称'), '研发网段');
    await user.type(within(dialog).getByLabelText(/网段 \(CIDR\)/), '10.0.9.0/24');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ parent_id: 1, cidr: '10.0.9.0/24', subnet_name: '研发网段' });
  });

  it('renames a group through the id-addressed endpoint', async () => {
    handlers();
    const put: unknown[] = [];
    server.use(
      http.put('/api/v1/cmdb/ipam/scopes/:id', async ({ request, params }) => {
        put.push({ id: params.id, body: await request.json() });
        return HttpResponse.json({ ci_id: 1 });
      }),
    );
    renderPage();

    const user = userEvent.setup();
    await user.click(await treeItem('生产网'));
    await user.click(screen.getByRole('button', { name: '编辑' }));
    const dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('名称'));
    await user.type(within(dialog).getByLabelText('名称'), '生产网-new');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(put).toHaveLength(1));
    expect(put[0]).toEqual({ id: '1', body: { name: '生产网-new' } });
  });
});

describe('permissions', () => {
  it('does not offer writes to a viewer', async () => {
    useAuth.setState({ token: null, role: 'viewer' });
    handlers();
    renderPage('/cmdb/ipam?tab=address&node=2');

    expect(await screen.findByText('10.0.0.11')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '编辑 10.0.0.11' })).not.toBeInTheDocument();
  });
});
