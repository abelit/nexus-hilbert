import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CIType, TypeAttribute } from '../../api/citype';
import { ToastProvider } from '../Toast';
import { InstanceOverview } from './InstanceOverview';

vi.mock('./InstanceRelations', () => ({ InstanceRelations: () => null }));

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

const fileAttribute = {
  id: 9,
  name: 'attachment',
  alias: '附件',
  value_type: '9',
  is_choice: false,
  is_list: false,
  is_unique: false,
  is_index: true,
  is_link: false,
  is_password: false,
  is_sortable: false,
  is_dynamic: false,
  is_bool: false,
  is_file: true,
  is_reference: false,
  is_computed: false,
  has_compute_script: false,
  has_choice_web_hook: false,
  has_choice_other: false,
  is_indexed: true,
  storage_table: '',
  is_required: false,
  order: 1,
  default_show: true,
  inherited: false,
} as TypeAttribute;

beforeEach(() => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
});

describe('InstanceOverview read-only files', () => {
  it('keeps file viewing and hides upload in read-only mode', async () => {
    render(
      <ToastProvider>
        <InstanceOverview
          model={host}
          models={[host]}
          instance={{ ci_id: 5, type_id: 1, values: {} }}
          attributes={[fileAttribute]}
          groups={[]}
          loading={false}
          error={null}
          onRetry={() => undefined}
          readOnly
        />
      </ToastProvider>,
    );

    const trigger = screen.getByRole('button', { name: '查看文件：附件' });
    expect(screen.queryByRole('button', { name: '管理文件：附件' })).not.toBeInTheDocument();

    await userEvent.click(trigger);
    expect(await screen.findByText('文件 · 附件')).toBeInTheDocument();
    expect(screen.queryByLabelText('上传文件')).not.toBeInTheDocument();
  });
});
