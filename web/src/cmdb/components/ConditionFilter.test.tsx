import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CIType, TypeAttribute } from '../api/citype';
import { selectOption } from '../../test/select-option';
import { AppliedCondition, ConditionFilter } from './ConditionFilter';

const attribute = (id: number, name: string, alias: string, extra: Partial<TypeAttribute> = {}): TypeAttribute =>
  ({
    id,
    name,
    alias,
    value_type: '2',
    is_choice: false,
    is_list: false,
    is_unique: false,
    is_index: false,
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
  }) as TypeAttribute;

const hostname = attribute(1, 'hostname', '主机名');
const note = attribute(2, 'note', '备注');
const owner = attribute(3, 'ops_owner', '运维负责人', {
  value_type: '0',
  is_reference: true,
  reference_type_id: 54,
});
const secret = attribute(4, 'root_password', '密码', { is_password: true });
const attributes = [hostname, note, owner, secret];
const models: CIType[] = [
  {
    id: 54,
    name: 'members',
    alias: '人员',
    enabled: true,
    is_attached: true,
    order: 0,
    unique_key: 'userid',
    parent_ids: [],
  },
];

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ConditionFilter attributes={attributes} models={models} value={value} onApply={setValue} />
      <output data-testid="expression">{value}</output>
    </>
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
});

describe('the condition builder', () => {
  it('applies an equality condition and hides password attributes', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<ConditionFilter attributes={attributes} models={models} value="" onApply={onApply} />);

    await user.click(screen.getByRole('button', { name: /条件过滤/ }));
    // A password is not matchable; offering it would turn search into an oracle.
    await user.click(screen.getByRole('combobox', { name: '属性' }));
    expect(screen.queryByRole('option', { name: '密码' })).not.toBeInTheDocument();
    await selectOption(screen.getByRole('combobox', { name: '属性' }), '主机名');

    await user.type(screen.getByLabelText('值'), 'web-01');
    await user.click(screen.getByRole('button', { name: '确定' }));

    expect(onApply).toHaveBeenCalledWith('hostname:web-01');
  });

  it('builds an empty-value operator and an OR connector', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: /条件过滤/ }));
    await selectOption(screen.getByRole('combobox', { name: '条件' }), '为空');
    await user.click(screen.getByRole('button', { name: '确定' }));
    expect(screen.getByTestId('expression')).toHaveTextContent('~hostname:*');

    await user.click(screen.getByRole('button', { name: /条件过滤/ }));
    await user.click(screen.getByRole('button', { name: '新增' }));
    await selectOption(screen.getAllByRole('combobox', { name: '连接方式' })[1], '或');
    await selectOption(screen.getAllByRole('combobox', { name: '属性' })[1], '备注');
    await user.type(screen.getByLabelText('值'), 'rack');
    await user.click(screen.getByRole('button', { name: '确定' }));
    expect(screen.getByTestId('expression')).toHaveTextContent('~hostname:*,-note:rack');
  });

  it('reopens the applied expression as editable rows', async () => {
    const user = userEvent.setup();
    render(<Harness initial="hostname:web-01" />);

    await user.click(screen.getByRole('button', { name: /条件过滤/ }));
    expect(screen.getByLabelText('值')).toHaveValue('web-01');
  });

  it('uses the referenced model picker for a reference attribute', async () => {
    const user = userEvent.setup();
    render(<Harness initial="ops_owner:374" />);

    await user.click(screen.getByRole('button', { name: /条件过滤/ }));
    expect(screen.getByRole('combobox', { name: '运维负责人' })).toBeInTheDocument();
    expect(screen.queryByLabelText('值')).not.toBeInTheDocument();
  });
});

describe('the applied condition', () => {
  it('shows the expression and offers save and clear', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onClear = vi.fn();
    render(<AppliedCondition value="ops_owner:374" matches={3} onSave={onSave} onClear={onClear} />);

    expect(screen.getByText('q=ops_owner:374')).toBeInTheDocument();
    expect(screen.getByText('命中 3 条')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存条件' }));
    await user.click(screen.getByRole('button', { name: '清除条件' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
