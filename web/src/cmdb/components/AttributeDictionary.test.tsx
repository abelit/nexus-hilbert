import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { server } from '@/test/msw-server';
import { useAuth } from '@/store/auth';
import { AttributeDictionary } from './AttributeDictionary';
import { ToastProvider } from './Toast';

const attribute = (id: number, name: string) => ({
  id,
  name,
  alias: `${name} 别名`,
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
});

function renderDictionary() {
  return render(
    <ToastProvider>
      <AttributeDictionary open onClose={() => {}} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
  useAuth.setState({ token: null, role: 'admin' });
});

describe('the attribute dictionary', () => {
  it('reports the total across pages and loads the next page', async () => {
    const user = userEvent.setup();
    let requests = 0;
    server.use(
      http.get('/api/v1/cmdb/attributes', ({ request }) => {
        requests += 1;
        const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
        const items = page === 1 ? [attribute(1, 'hostname'), attribute(2, 'cpu')] : [attribute(3, 'serial')];
        return HttpResponse.json({ items, total: 120 });
      }),
    );
    renderDictionary();

    expect(await screen.findByText('hostname')).toBeInTheDocument();
    expect(screen.getByText('120 个属性')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /下一页/ })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /下一页/ }));

    expect(await screen.findByText('serial')).toBeInTheDocument();
    expect(requests).toBeGreaterThanOrEqual(2);
  });

  it('searches by name on the server and resets to page one', async () => {
    const user = userEvent.setup();
    const pages: string[] = [];
    server.use(
      http.get('/api/v1/cmdb/attributes', ({ request }) => {
        const url = new URL(request.url);
        pages.push(`${url.searchParams.get('page')}:${url.searchParams.get('name') ?? ''}`);
        return HttpResponse.json({ items: [attribute(1, 'hostname')], total: 1 });
      }),
    );
    renderDictionary();

    await screen.findByText('hostname');
    await user.type(screen.getByLabelText('搜索属性'), 'host');
    await waitFor(() => expect(pages.some((entry) => entry.endsWith(':host'))).toBe(true));
    expect(pages[pages.length - 1]).toBe('1:host');
  });

  it('opens the full editor for a new attribute', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/cmdb/attributes', () => HttpResponse.json({ items: [], total: 0 })),
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [], total: 0 })),
    );
    renderDictionary();

    await user.click(await screen.findByRole('button', { name: /新建属性/ }));
    expect(await screen.findByLabelText('属性名')).toBeInTheDocument();
    expect(screen.getByLabelText('值类型')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '密码' })).toBeInTheDocument();
  });
});
