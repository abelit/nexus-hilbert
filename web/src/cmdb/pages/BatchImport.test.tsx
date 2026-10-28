import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { server } from '@/test/msw-server';
import { selectOption } from '@/test/select-option';
import { useAuth } from '@/store/auth';
import BatchImportPage from './BatchImport';
import type { RelatedType } from '../api/citype';
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

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <BatchImportPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  useAuth.setState({ token: null, role: 'admin' });
});

const rack = {
  id: 2,
  name: 'rack',
  alias: '机柜',
  enabled: true,
  is_attached: true,
  icon: '',
  order: 0,
  unique_key: 'rack_code',
  parent_ids: [],
};

const rackRelation = {
  ctr_id: 9,
  type: rack,
  attributes: [{ id: 20, name: 'rack_code', alias: '机柜编号', value_type: '2', is_list: false, is_computed: false, is_password: false, is_file: false }],
  relation_type: { id: 1, name: 'running_on', color: '#1890ff' },
  constraint: '2',
  parent_attr_ids: [],
  child_attr_ids: [],
} as unknown as RelatedType;

describe('the batch import page', () => {
  it('parses a CSV, previews it, and commits the same sheet', async () => {
    let previewBody: unknown;
    let commitBody: unknown;
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [host], total: 1 })),
      http.get('/api/v1/cmdb/ci-types/1/attributes', () =>
        HttpResponse.json({
          type_id: 1,
          unique_id: 10,
          unique: 'hostname',
          attributes: [
            { id: 10, name: 'hostname', alias: '主机名', value_type: '2', is_unique: true },
            { id: 11, name: 'cpu', alias: 'CPU', value_type: '0' },
          ],
        }),
      ),
      http.get('/api/v1/cmdb/ci-types/1/relation-parents', () => HttpResponse.json({ items: [], total: 0 })),
      http.post('/api/v1/cmdb/import/preview', async ({ request }) => {
        previewBody = await request.json();
        return HttpResponse.json({
          total: 1,
          valid: 1,
          invalid: 0,
          creates: 1,
          updates: 0,
          columns: [
            { index: 0, header: 'hostname', attr_id: 10, attr: 'hostname', alias: '主机名', matched: true, identifier: true },
            { index: 1, header: 'cpu', attr_id: 11, attr: 'cpu', alias: 'CPU', matched: true },
          ],
          rows: [{ row: 1, sheet_row: 2, ok: true, action: 'create', unique: 'web-01' }],
        });
      }),
      http.post('/api/v1/cmdb/import/commit', async ({ request }) => {
        commitBody = await request.json();
        return HttpResponse.json({
          written: 1,
          creates: 1,
          updates: 0,
          rows: [{ row: 1, sheet_row: 2, ok: true, action: 'create', unique: 'web-01', ci_id: 42 }],
        });
      }),
    );
    renderPage();

    await selectOption(await screen.findByLabelText('模型'), '主机');
    const file = new File(['hostname,cpu\nweb-01,8\n'], 'hosts.csv', { type: 'text/csv' });
    await userEvent.upload(screen.getByLabelText('上传表格'), file);

    await waitFor(() =>
      expect(previewBody).toEqual({
        ci_type: '1',
        headers: ['hostname', 'cpu'],
        rows: [['web-01', '8']],
        exist_policy: 'replace',
      }),
    );

    await userEvent.click(await screen.findByRole('button', { name: '导入' }));
    await waitFor(() => expect(commitBody).toEqual(previewBody));
    expect((await screen.findAllByText(/已导入 1 行/)).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: '完成' }));
  });

  it('shows relation columns in the mapping and offers the template dialog', async () => {
    let previewBody: unknown;
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [host], total: 1 })),
      http.get('/api/v1/cmdb/ci-types/1/attributes', () =>
        HttpResponse.json({
          type_id: 1,
          unique_id: 10,
          unique: 'hostname',
          attributes: [
            { id: 10, name: 'hostname', alias: '主机名', value_type: '2', is_unique: true },
            { id: 11, name: 'cpu', alias: 'CPU', value_type: '0' },
          ],
        }),
      ),
      http.get('/api/v1/cmdb/ci-types/1/relation-parents', () => HttpResponse.json({ items: [rackRelation], total: 1 })),
      http.post('/api/v1/cmdb/import/preview', async ({ request }) => {
        previewBody = await request.json();
        return HttpResponse.json({
          total: 1,
          valid: 1,
          invalid: 0,
          creates: 1,
          updates: 0,
          columns: [
            { index: 0, header: '主机名', attr_id: 10, attr: 'hostname', alias: '主机名', matched: true, identifier: true },
          ],
          relations: [
            {
              index: 1,
              header: '$rack.rack_code',
              parent_type_id: 2,
              parent_type: 'rack',
              parent_alias: '机柜',
              attr_id: 20,
              attr: 'rack_code',
              attr_alias: '机柜编号',
              relation_type_id: 1,
              matched: true,
            },
          ],
          rows: [{ row: 1, sheet_row: 2, ok: true, action: 'create', unique: 'web-01' }],
        });
      }),
    );
    renderPage();

    await selectOption(await screen.findByLabelText('模型'), '主机');
    const file = new File(['主机名,机柜编号\nweb-01,R-A01\n'], 'hosts.csv', { type: 'text/csv' });
    await userEvent.upload(await screen.findByLabelText('上传表格'), file);

    await waitFor(() =>
      expect(previewBody).toEqual({
        ci_type: '1',
        headers: ['主机名', '机柜编号'],
        rows: [['web-01', 'R-A01']],
        exist_policy: 'replace',
      }),
    );
    expect(await screen.findByText('$rack.rack_code')).toBeInTheDocument();
    expect(await screen.findByText('机柜 · 机柜编号')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '下载模板' }));
    expect(await screen.findByText('模型属性')).toBeInTheDocument();
    expect(screen.getByText('模型关系')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '机柜' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
  });

  it('refuses to import a sheet with issues and says why', async () => {
    server.use(
      http.get('/api/v1/cmdb/ci-types', () => HttpResponse.json({ items: [host], total: 1 })),
      http.get('/api/v1/cmdb/ci-types/1/attributes', () =>
        HttpResponse.json({
          type_id: 1,
          unique_id: 10,
          unique: 'hostname',
          attributes: [{ id: 10, name: 'hostname', alias: '主机名', value_type: '2', is_unique: true }],
        }),
      ),
      http.get('/api/v1/cmdb/ci-types/1/relation-parents', () => HttpResponse.json({ items: [], total: 0 })),
      http.post('/api/v1/cmdb/import/preview', () =>
        HttpResponse.json({
          total: 1,
          valid: 0,
          invalid: 1,
          creates: 0,
          updates: 0,
          columns: [
            { index: 0, header: '主机名', attr_id: 10, attr: 'hostname', alias: '主机名', matched: true, identifier: true },
          ],
          rows: [
            {
              row: 1,
              sheet_row: 2,
              ok: false,
              issues: [{ column: '主机名', message: 'the value is required' }],
            },
          ],
        }),
      ),
    );
    renderPage();

    await selectOption(await screen.findByLabelText('模型'), '主机');
    // A value the server rejects. The parser keeps the row; the preview marks
    // it invalid and the Import button stays disabled.
    await userEvent.upload(await screen.findByLabelText('上传表格'), new File(['主机名\nweb-01\n'], 'hosts.csv', { type: 'text/csv' }));

    expect(await screen.findByText('主机名: the value is required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导入' })).toBeDisabled();
  });

  it('hides the wizard from a read-only role', () => {
    useAuth.setState({ token: null, role: 'viewer' });
    renderPage();
    expect(screen.getByText('没有导入权限')).toBeInTheDocument();
  });
});
