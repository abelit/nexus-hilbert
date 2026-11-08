import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/test/msw-server';

beforeEach(() => localStorage.setItem('ongrid-locale', 'zh-CN'));
import { selectOption } from '@/test/select-option';
import { ProviderConfig } from './ProviderConfig';
import type { Rule } from '../../api/discovery';

const httpRule: Rule = {
  id: 1,
  name: '阿里云',
  type: 'http',
  is_inner: true,
  is_plugin: false,
  attribute_count: 2,
  has_plugin_script: false,
  categories: [{ category: '计算', items: ['ecs', 'rds'] }],
  option: { en: 'aliyun' },
};

const snmpRule: Rule = {
  id: 2,
  name: '交换机',
  type: 'snmp',
  is_inner: true,
  is_plugin: false,
  attribute_count: 0,
  has_plugin_script: false,
};

function props(rule: Rule, extra: Record<string, unknown>) {
  return {
    rule,
    extra,
    secrets: { key: '', secret: '', password: '', community: '' },
    stored: { hasKey: true, hasSecret: true, hasPassword: false, hasCommunity: false },
    refreshKey: 0,
    canEditRule: true,
    onExtraChange: vi.fn(),
    onSecretsChange: vi.fn(),
    onManageAccounts: vi.fn(),
  };
}

describe('provider config', () => {
  it('writes only the account reference and disables inline credentials', async () => {
    server.use(
      http.get('/api/v1/cmdb/discovery/rules/1/accounts', () =>
        HttpResponse.json({
          items: [{ id: 5, name: '生产账号', config: {}, has_secret: true, has_password: false, has_key: true }],
          total: 1,
        }),
      ),
    );
    const initial = props(httpRule, { category: 'ecs' });
    const { rerender } = render(<ProviderConfig {...initial} />);

    expect(await screen.findByRole('combobox', { name: '账号引用' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '资源类型' })).toBeInTheDocument();
    await selectOption(screen.getByRole('combobox', { name: '账号引用' }), '生产账号');
    await waitFor(() => expect(initial.onExtraChange).toHaveBeenCalledWith({ _reference: '5' }));

    rerender(<ProviderConfig {...initial} extra={{ category: 'ecs', _reference: '5' }} />);
    expect(await screen.findByLabelText('Access key')).toBeDisabled();
    expect(screen.getByLabelText('Secret')).toBeDisabled();
    // Region is target-level and remains writable even when credentials come
    // from an account; an account region, when present, wins at task compile.
    expect(screen.getByLabelText('区域')).not.toBeDisabled();
  });

  it('renders the cloud region field', () => {
    const initial = props(httpRule, { category: 'ecs', region: 'us-east-1' });
    render(<ProviderConfig {...initial} />);
    expect(screen.getByLabelText('区域')).toHaveValue('us-east-1');
  });

  it('renders the Huawei project id and the vCenter TLS option', () => {
    const huawei: Rule = { ...httpRule, id: 8, name: '华为云', option: { en: 'huaweicloud' } };
    const { rerender } = render(
      <ProviderConfig {...props(huawei, { category: '云服务器 ECS', project_id: 'project-1' })} />,
    );
    expect(screen.getByLabelText('Project ID')).toHaveValue('project-1');

    const vcenter: Rule = { ...httpRule, id: 9, name: 'VCenter', option: { en: 'vcenter' } };
    rerender(<ProviderConfig {...props(vcenter, { category: '虚拟机' })} />);
    expect(screen.getByLabelText('跳过 TLS 证书校验')).not.toBeChecked();

    const kvm: Rule = {
      ...httpRule,
      id: 10,
      name: 'KVM',
      option: { en: 'kvm', category: 'private_cloud' },
    };
    rerender(<ProviderConfig {...props(kvm, { category: '虚拟机' })} />);
    expect(screen.getByText('该私有云适配器尚未实现，目标不会下发。')).toBeInTheDocument();
    expect(screen.queryByLabelText('地址')).toBeNull();
  });

  it('adds an SNMP node without losing the existing one', async () => {
    const initial = props(snmpRule, {
      nodes: [{ ip: '10.0.0.1', version: '2c', has_community: true }],
    });
    render(<ProviderConfig {...initial} />);

    expect(screen.getByLabelText('节点 1 IP')).toHaveValue('10.0.0.1');
    expect(screen.getByLabelText('节点 1 community')).toHaveAttribute('placeholder', '已设置，留空保持原值');
    await userEvent.click(screen.getByRole('button', { name: '添加节点' }));
    expect(initial.onExtraChange).toHaveBeenCalledWith({
      nodes: [
        { ip: '10.0.0.1', version: '2c', has_community: true },
        { ip: '', version: '2c' },
      ],
    });
  });

  it('renders component port-scan fields', () => {
    const components: Rule = { ...snmpRule, id: 3, type: 'components', name: '服务' };
    render(<ProviderConfig {...props(components, { cidr: '10.0.0.0/8', ports: '80,443' })} />);
    expect(screen.getByLabelText('CIDR')).toHaveValue('10.0.0.0/8');
    expect(screen.getByLabelText('端口范围')).toHaveValue('80,443');
  });
});
