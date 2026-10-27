import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/test/msw-server';
import { ModelDefinitionDrawer } from './ModelDefinitionDrawer';
import { ToastProvider } from './Toast';

const model = {
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

const hostname = {
  id: 10,
  name: 'hostname',
  alias: '主机名',
  value_type: '2',
  is_list: false,
  is_index: true,
  is_indexed: true,
  is_required: true,
  order: 0,
  default_show: true,
  inherited: false,
  is_password: false,
  is_reference: false,
  is_computed: false,
  storage_table: 'c_value_index_texts',
};

function coreHandlers() {
  server.use(
    http.get('/api/v1/cmdb/ci-types/1', () => HttpResponse.json(model)),
    http.get('/api/v1/cmdb/ci-types/1/attributes', () =>
      HttpResponse.json({ type_id: 1, unique_id: 10, unique: 'hostname', attributes: [hostname] }),
    ),
    http.get('/api/v1/cmdb/ci-types/1/attribute-groups', () =>
      HttpResponse.json([
        { id: 5, name: '基本信息', type_id: 1, order: 0, inherited: false, attributes: [hostname], is_other: false },
      ]),
    ),
    http.get('/api/v1/cmdb/ci-types/1/relation-children', () => HttpResponse.json({ items: [], total: 0 })),
    http.get('/api/v1/cmdb/ci-types/1/relation-parents', () => HttpResponse.json({ items: [], total: 0 })),
  );
}

function adminRuleHandlers() {
  server.use(
    http.get('/api/v1/cmdb/ci-types/1/unique-constraints', () =>
      HttpResponse.json({
        items: [{ id: 70, type_id: 1, attr_ids: [10], attributes: [hostname] }],
        total: 1,
      }),
    ),
    http.get('/api/v1/cmdb/ci-types/1/triggers', () =>
      HttpResponse.json({
        items: [
          {
            id: 80,
            type_id: 1,
            attr_id: 10,
            option: { webhooks: { url: 'https://example.test/hook', authorization: { token: 'must-not-leak' } } },
            has_webhook_authorization: true,
          },
        ],
        total: 1,
      }),
    ),
  );
}

function renderDrawer(isAdmin = true) {
  return render(
    <ToastProvider>
      <ModelDefinitionDrawer ref_="1" modelLabel="主机" isAdmin={isAdmin} onClose={() => {}} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
});

describe('the model definition drawer', () => {
  it('shows the snapshot and copies its exact JSON text', async () => {
    const user = userEvent.setup();
    coreHandlers();
    adminRuleHandlers();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    renderDrawer();

    const json = await screen.findByLabelText('模型定义 JSON');
    expect(json).toHaveTextContent('"format": "ongrid.cmdb.model"');
    expect(json).toHaveTextContent('"form_sections"');
    expect(json).toHaveTextContent('"unique_constraints"');
    expect(json).not.toHaveTextContent('must-not-leak');

    await user.click(screen.getByRole('button', { name: '复制 JSON' }));
    expect(writeText).toHaveBeenCalledWith(json.textContent);
    expect(await screen.findByRole('status')).toHaveTextContent('已复制模型定义');
  });

  it('keeps the JSON selectable and reports a failed copy', async () => {
    const user = userEvent.setup();
    coreHandlers();
    adminRuleHandlers();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    renderDrawer();

    const json = await screen.findByLabelText('模型定义 JSON');
    await user.click(screen.getByRole('button', { name: '复制 JSON' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('复制失败');
    expect(json).toBeInTheDocument();
  });

  it('downloads the same JSON with a sanitized filename', async () => {
    const user = userEvent.setup();
    coreHandlers();
    adminRuleHandlers();
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:definition');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    let filename = '';
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      filename = this.download;
    });
    renderDrawer();

    const json = await screen.findByLabelText('模型定义 JSON');
    await user.click(screen.getByRole('button', { name: '下载 JSON' }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/json;charset=utf-8');
    expect(filename).toBe('cmdb-model-host.json');
    expect(click).toHaveBeenCalled();
    expect(json).toHaveTextContent('"host"');
  });

  it('keeps the drawer open and offers retry after a read failure', async () => {
    const user = userEvent.setup();
    coreHandlers();
    adminRuleHandlers();
    let failed = true;
    server.use(
      http.get('/api/v1/cmdb/ci-types/1/relation-children', () =>
        failed ? new HttpResponse(null, { status: 500 }) : HttpResponse.json({ items: [], total: 0 }),
      ),
    );
    renderDrawer();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByLabelText('模型定义 JSON')).not.toBeInTheDocument();

    failed = false;
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByLabelText('模型定义 JSON')).toBeInTheDocument();
  });

  it('omits the admin-only sections for a non-admin without calling their endpoints', async () => {
    coreHandlers();
    renderDrawer(false);

    const json = await screen.findByLabelText('模型定义 JSON');
    expect(json).toHaveTextContent('"unique_constraints": null');
    expect(json).toHaveTextContent('"triggers": null');
    expect(json).toHaveTextContent('"reason": "admin_required"');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
