import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BaselinePreview } from '../../api/history';
import { ToastProvider } from '../Toast';
import { RollbackDialog } from './RollbackDialog';

const { previewMock, rollbackMock } = vi.hoisted(() => ({
  previewMock: vi.fn(),
  rollbackMock: vi.fn(),
}));

vi.mock('../../api/history', () => ({
  previewInstanceBaseline: previewMock,
  rollbackInstance: rollbackMock,
}));

const PREVIEW: BaselinePreview = {
  ci_id: 5,
  before: '2026-10-01T10:00:00Z',
  record_id: 12,
  changes: [
    {
      attr_id: 1,
      attr_name: 'cpu_count',
      attr_alias: 'CPU',
      value_type: '0',
      current: ['16'],
      target: ['8'],
    },
    {
      attr_id: 2,
      attr_name: 'note',
      attr_alias: '备注',
      value_type: '2',
      current: ['new'],
      target: [],
    },
  ],
  skipped: [{ attr_id: 3, attr_name: 'root_password', attr_alias: '密码', reason: 'sensitive' }],
};

function renderDialog(
  target: { before?: string; recordID?: number },
  overrides: { onRolledBack?: () => void; onOpenChange?: (open: boolean) => void } = {},
) {
  const onRolledBack = overrides.onRolledBack ?? vi.fn();
  const onOpenChange = overrides.onOpenChange ?? vi.fn();
  render(
    <ToastProvider>
      <RollbackDialog
        open
        ciID={5}
        initialBefore={target.before}
        initialRecordID={target.recordID}
        onOpenChange={onOpenChange}
        onRolledBack={onRolledBack}
      />
    </ToastProvider>,
  );
  return { onRolledBack, onOpenChange };
}

beforeEach(() => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
  previewMock.mockReset();
  rollbackMock.mockReset();
  previewMock.mockResolvedValue(PREVIEW);
  rollbackMock.mockResolvedValue(PREVIEW);
});

describe('RollbackDialog', () => {
  it('previews the selected write automatically and shows the restored values', async () => {
    renderDialog({ before: '2026-10-01T10:00:00Z', recordID: 12 });

    await waitFor(() =>
      expect(previewMock).toHaveBeenCalledWith(5, {
        before: '2026-10-01T10:00:00Z',
        record_id: 12,
      }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('CPU')).toBeInTheDocument();
    expect(within(dialog).getByText('16')).toBeInTheDocument();
    expect(within(dialog).getByText('8')).toBeInTheDocument();
    expect(within(dialog).getByText('已清空')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '确认回滚' })).toBeEnabled();
  });

  it('explains why some attributes cannot be restored', async () => {
    renderDialog({ before: '2026-10-01T10:00:00Z', recordID: 12 });

    const dialog = await screen.findByRole('dialog');
    // The helper paragraph also mentions passwords, so anchor on the reason
    // label that only the skipped list carries.
    const note = await within(dialog).findByText(/敏感属性/);
    expect(note).toHaveTextContent('密码');
    expect(within(dialog).getByRole('button', { name: '确认回滚' })).toBeEnabled();
  });

  it('asks for confirmation and applies the rollback once', async () => {
    const user = userEvent.setup();
    const { onRolledBack } = renderDialog({ before: '2026-10-01T10:00:00Z', recordID: 12 });

    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: '确认回滚' }));

    const confirm = await screen.findByRole('dialog', { name: /确认操作/ });
    await user.click(within(confirm).getByRole('button', { name: '确认' }));

    await waitFor(() =>
      expect(rollbackMock).toHaveBeenCalledWith(5, {
        before: '2026-10-01T10:00:00Z',
        record_id: 12,
      }),
    );
    await act(async () => {
      await rollbackMock.mock.results[rollbackMock.mock.results.length - 1]?.value;
    });
    expect(rollbackMock).toHaveBeenCalledTimes(1);
    expect(onRolledBack).toHaveBeenCalled();
    expect(await screen.findByText('已回滚到指定时间点')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('确认操作')).not.toBeInTheDocument());
  });

  it('previews a manually chosen time without a record id', async () => {
    const user = userEvent.setup();
    renderDialog({});

    const dialog = await screen.findByRole('dialog');
    expect(previewMock).not.toHaveBeenCalled();

    const input = within(dialog).getByLabelText('回滚到');
    fireEvent.change(input, { target: { value: '2026-10-01T09:30:00' } });
    await user.click(within(dialog).getByRole('button', { name: '预览变更' }));

    await waitFor(() =>
      expect(previewMock).toHaveBeenCalledWith(5, {
        before: new Date('2026-10-01T09:30:00').toISOString(),
      }),
    );
    // Let the resolved preview paint inside act, rather than leaking a state
    // update out of the test's async boundary.
    await act(async () => {
      await previewMock.mock.results[previewMock.mock.results.length - 1]?.value;
    });
    expect(within(dialog).getByText('CPU')).toBeInTheDocument();
  });

  it('previews on Enter from the time field', async () => {
    renderDialog({});

    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('回滚到');
    fireEvent.change(input, { target: { value: '2026-10-01T09:30:00' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() =>
      expect(previewMock).toHaveBeenCalledWith(5, {
        before: new Date('2026-10-01T09:30:00').toISOString(),
      }),
    );
    await act(async () => {
      await previewMock.mock.results[previewMock.mock.results.length - 1]?.value;
    });
    expect(within(dialog).getByText('CPU')).toBeInTheDocument();
  });

  it('invalidates the preview when the time changes', async () => {
    renderDialog({ before: '2026-10-01T10:00:00Z', recordID: 12 });

    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: '确认回滚' })).toBeEnabled(),
    );

    fireEvent.change(within(dialog).getByLabelText('回滚到'), {
      target: { value: '2026-10-01T09:30:00' },
    });

    expect(within(dialog).getByRole('button', { name: '确认回滚' })).toBeDisabled();
    expect(within(dialog).getByText('时间已修改，请重新预览')).toBeInTheDocument();
  });

  it('does not offer a rollback when nothing differs', async () => {
    previewMock.mockResolvedValue({ ...PREVIEW, changes: [] });
    renderDialog({ before: '2026-10-01T10:00:00Z', recordID: 12 });

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('该时间点之后没有可回滚的变更')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '确认回滚' })).toBeDisabled();
  });

  it('keeps the dialog usable after a failed preview', async () => {
    previewMock.mockRejectedValue(new Error('历史服务暂不可用'));
    renderDialog({ before: '2026-10-01T10:00:00Z', recordID: 12 });

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('历史服务暂不可用')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '确认回滚' })).toBeDisabled();
  });
});
