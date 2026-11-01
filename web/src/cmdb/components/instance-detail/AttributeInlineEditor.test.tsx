import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { TypeAttribute } from '../../api/citype';
import { AttributeInlineEditor } from './AttributeInlineEditor';

const booleanAttribute = {
  id: 302,
  name: 'mon_enabled',
  alias: '启用监控',
  value_type: '7',
  is_bool: true,
  is_choice: false,
  is_list: false,
  is_password: false,
  is_reference: false,
  is_computed: false,
  is_required: false,
  order: 1,
  default_show: true,
  inherited: false,
} as TypeAttribute;

describe('the inline attribute editor', () => {
  it('saves a boolean as soon as the switch changes', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onDone = vi.fn();
    render(
      <AttributeInlineEditor
        attribute={booleanAttribute}
        value={false}
        models={[]}
        labels={new Map()}
        onSave={onSave}
        onDone={onDone}
        onCancel={() => undefined}
      />,
    );

    await act(async () => {
      await user.click(screen.getByRole('switch'));
    });

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(true));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('保存中…')).not.toBeInTheDocument());
  });
});
