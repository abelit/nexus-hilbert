import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AttributeChange, BaselinePreview } from '../../api/history';
import { ToastProvider } from '../Toast';
import { InstanceHistory } from './InstanceHistory';

const { listMock, previewMock, rollbackMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  previewMock: vi.fn(),
  rollbackMock: vi.fn(),
}));

vi.mock('../../api/history', () => ({
  listCIHistory: listMock,
  previewInstanceBaseline: previewMock,
  rollbackInstance: rollbackMock,
}));

const ROWS: AttributeChange[] = [
  {
    id: 3,
    record_id: 12,
    uid: 7,
    operate_type: '2',
    ci_id: 5,
    attr_id: 1,
    attr_name: 'cpu_count',
    attr_alias: 'CPU',
    old: '8',
    new: '16',
    created_at: '2026-10-01T10:00:00Z',
  },
  {
    id: 2,
    record_id: 12,
    uid: 7,
    operate_type: '2',
    ci_id: 5,
    attr_id: 2,
    attr_name: 'note',
    attr_alias: '备注',
    old: 'a',
    new: 'b',
    created_at: '2026-10-01T10:00:00Z',
  },
  {
    id: 1,
    record_id: 11,
    uid: 7,
    operate_type: '2',
    ci_id: 5,
    attr_id: 1,
    attr_name: 'cpu_count',
    attr_alias: 'CPU',
    old: '4',
    new: '8',
    created_at: '2026-09-01T10:00:00Z',
  },
];

const PREVIEW: BaselinePreview = {
  ci_id: 5,
  before: '2026-10-01T10:00:00Z',
  record_id: 12,
  changes: [
    {
      attr_id: 1,
      attr_name: 'cpu_count',
      attr_alias: 'CPU',
      current: ['16'],
      target: ['8'],
    },
  ],
  skipped: [],
};

function renderHistory(props: { canRollback?: boolean; onRolledBack?: () => void } = {}) {
  render(
    <ToastProvider>
      <InstanceHistory ciID={5} userLabel={() => 'alice'} {...props} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
  listMock.mockReset();
  previewMock.mockReset();
  rollbackMock.mockReset();
  listMock.mockResolvedValue({ items: ROWS, total: ROWS.length, page: 1, page_size: 20 });
  previewMock.mockResolvedValue(PREVIEW);
  rollbackMock.mockResolvedValue(PREVIEW);
});

describe('InstanceHistory rollback entry', () => {
  it('offers one rollback action per write, not per changed attribute', async () => {
    renderHistory({ canRollback: true });

    await screen.findAllByText('CPU');
    expect(
      screen.getAllByRole('button', { name: '回滚到此变更之前' }),
    ).toHaveLength(2);
  });

  it('opens the rollback dialog at the selected write', async () => {
    const user = userEvent.setup();
    renderHistory({ canRollback: true });

    await screen.findAllByText('CPU');
    await user.click(screen.getAllByRole('button', { name: '回滚到此变更之前' })[0]);

    await waitFor(() =>
      expect(previewMock).toHaveBeenCalledWith(5, {
        before: '2026-10-01T10:00:00Z',
        record_id: 12,
      }),
    );
    expect(await screen.findByRole('heading', { name: '回滚资源' })).toBeInTheDocument();
  });

  it('offers no write entry to a read-only viewer', async () => {
    renderHistory({ canRollback: false });

    await screen.findAllByText('CPU');
    expect(
      screen.queryByRole('button', { name: '回滚到此变更之前' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '回滚' })).not.toBeInTheDocument();
  });

  it('refreshes the history and the drawer after a rollback', async () => {
    const user = userEvent.setup();
    const onRolledBack = vi.fn();
    renderHistory({ canRollback: true, onRolledBack });

    await screen.findAllByText('CPU');
    await user.click(screen.getAllByRole('button', { name: '回滚到此变更之前' })[0]);
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: '确认回滚' }));
    const confirm = await screen.findByRole('dialog', { name: /确认操作/ });
    await user.click(within(confirm).getByRole('button', { name: '确认' }));

    await waitFor(() => expect(rollbackMock).toHaveBeenCalledTimes(1));
    expect(onRolledBack).toHaveBeenCalled();
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });
});
