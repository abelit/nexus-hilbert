import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../Toast';
import { ExportMenu } from './ExportMenu';

const exportRowsMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/export')>();
  return { ...actual, exportRows: exportRowsMock };
});

type Row = { name: string };
const columns = [{ key: 'name', header: '名称', value: (row: Row) => row.name }];
const pageRows: Row[] = [{ name: 'page-1' }];
const allRows: Row[] = [{ name: 'all-1' }, { name: 'all-2' }];
const selectedRows: Row[] = [{ name: 'picked-1' }];

function renderMenu(
  extra: { selectedCount?: number; fetchSelected?: () => Promise<Row[]> } = {},
) {
  return render(
    <ToastProvider>
      <ExportMenu<Row>
        filename="host"
        columns={columns}
        rows={pageRows}
        scopes={['all', 'page', 'selected']}
        totalCount={2}
        fetchAll={() => Promise.resolve(allRows)}
        {...extra}
      />
    </ToastProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  exportRowsMock.mockReset();
  exportRowsMock.mockResolvedValue(undefined);
});

describe('the export menu', () => {
  it('fetches the whole query when 全部 is exported', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: '导出' }));
    expect(await screen.findByRole('button', { name: '全部 (2)' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('menuitem', { name: 'CSV' }));

    await waitFor(() => expect(exportRowsMock).toHaveBeenCalledWith('host', columns, allRows, 'csv'));
  });

  it('exports only the rows on screen for 当前页', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: '导出' }));
    await user.click(await screen.findByRole('button', { name: '当前页 (1)' }));
    // Picking the scope must not close the menu: the format list stays usable.
    expect(screen.getByRole('menuitem', { name: 'Excel' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Excel' }));

    await waitFor(() =>
      expect(exportRowsMock).toHaveBeenCalledWith('host', columns, pageRows, 'xlsx'),
    );
  });

  it('exports the checked rows even when they are not on the current page', async () => {
    const user = userEvent.setup();
    renderMenu({ selectedCount: 1, fetchSelected: () => Promise.resolve(selectedRows) });

    await user.click(screen.getByRole('button', { name: '导出' }));
    await user.click(await screen.findByRole('button', { name: '已选 (1)' }));
    await user.click(screen.getByRole('menuitem', { name: 'JSON' }));

    await waitFor(() =>
      expect(exportRowsMock).toHaveBeenCalledWith('host', columns, selectedRows, 'json'),
    );
  });

  it('marks every format with its own icon', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: '导出' }));
    const formats = ['CSV', 'Excel', 'JSON', 'YAML', '文本'];
    for (const name of formats) {
      const item = await screen.findByRole('menuitem', { name });
      expect(item.querySelector('svg')).not.toBeNull();
    }
  });
});
