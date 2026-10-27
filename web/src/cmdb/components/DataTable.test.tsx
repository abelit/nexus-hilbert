import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DataTable, type Column } from './DataTable';

type Row = { id: number; name: string; cpu: number };

const rows: Row[] = [
  { id: 1, name: 'web-01', cpu: 8 },
  { id: 2, name: 'Cache-01', cpu: 4 },
];

const columns: Column<Row>[] = [
  { key: 'name', header: 'Name', sortable: true, sortValue: (row) => row.name, cell: (row) => row.name },
  { key: 'cpu', header: 'CPU', sortable: true, sortValue: (row) => row.cpu, cell: (row) => String(row.cpu) },
];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
});

describe('states', () => {
  it('distinguishes loading, empty and failed', () => {
    const { rerender } = render(<DataTable columns={columns} rows={[]} rowKey={(row) => row.id} loading />);
    expect(screen.getByText('加载中…')).toBeInTheDocument();

    rerender(<DataTable columns={columns} rows={[]} rowKey={(row) => row.id} empty="还没有内容" />);
    expect(screen.getByText('没有数据')).toBeInTheDocument();
    expect(screen.getByText('还没有内容')).toBeInTheDocument();

    // A FAILURE KEEPS THE ROWS IT HAS. A load error after a successful one must
    // not blank the table — the operator may still be reading it.
    rerender(
      <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} error="读取失败" onRetry={() => {}} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('读取失败');
    expect(screen.getByText('web-01')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument();
  });
});

describe('sorting', () => {
  it('cycles ascending, descending, then the natural order', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={columns} rows={rows} rowKey={(row) => row.id} />);

    const header = screen.getByRole('button', { name: /CPU/ });
    const firstCell = () => within(screen.getAllByRole('row')[1]).getAllByRole('cell')[1];

    // NUMERIC, not lexicographic: 4 before 8. A `String()` sort would put "4"
    // before "8" too, so the pair is chosen so a string sort of "10" vs "9"
    // would fail — see the third case below.
    await user.click(header);
    expect(firstCell()).toHaveTextContent('4');
    expect(screen.getByRole('columnheader', { name: /CPU/ })).toHaveAttribute('aria-sort', 'ascending');

    await user.click(header);
    expect(firstCell()).toHaveTextContent('8');
    expect(screen.getByRole('columnheader', { name: /CPU/ })).toHaveAttribute('aria-sort', 'descending');

    // THIRD CLICK CLEARS IT, so the operator gets back to the server's order.
    await user.click(header);
    expect(screen.getByRole('columnheader', { name: /CPU/ })).toHaveAttribute('aria-sort', 'none');
    expect(firstCell()).toHaveTextContent('8');
  });

  it('hands the intent to the server when the caller sorts', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        sort={null}
        onSortChange={onSortChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Name/ }));
    // THE ROWS ARE NOT REORDERED for a server-sorted table: sorting one page of a
    // larger set would produce an order that is wrong past the page.
    expect(onSortChange).toHaveBeenCalledWith({ key: 'name', desc: false });
    expect(within(screen.getAllByRole('row')[1]).getAllByRole('cell')[0]).toHaveTextContent('web-01');
  });
});

describe('grouped rows', () => {
  const groupedRows: Row[] = [
    { id: 1, name: 'web-01', cpu: 8 },
    { id: 2, name: 'cache-01', cpu: 4 },
    { id: 3, name: 'db-01', cpu: 16 },
    { id: 4, name: 'api-01', cpu: 2 },
  ];
  const groups = [
    { key: 'hardware', header: <span>硬件</span>, rows: [groupedRows[0], groupedRows[1]] },
    { key: 'software', header: <span>软件</span>, rows: [groupedRows[2], groupedRows[3]] },
    { key: 'empty', header: <span>空组</span>, rows: [] },
  ];

  it('renders one table with a header row per non-empty group', () => {
    const withExtra: Column<Row>[] = [
      ...columns,
      { key: 'extra', header: 'Extra', hideable: true, cell: () => 'extra-value' },
    ];
    render(
      <DataTable
        columns={withExtra}
        rows={groupedRows}
        groups={groups}
        rowKey={(row) => row.id}
        actions={() => <button type="button">edit</button>}
      />,
    );

    // ONE table and ONE column picker. A table per group would repeat both and
    // give each group its own horizontal scroller.
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /列/ })).toHaveLength(1);

    // The group header spans every visible column plus the action column.
    expect(screen.getByRole('rowheader', { name: '硬件' })).toHaveAttribute('colspan', '4');
    expect(screen.getByRole('rowheader', { name: '软件' })).toHaveAttribute('colspan', '4');
    expect(screen.queryByText('空组')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'edit' })).toHaveLength(4);
  });

  it('recomputes the group header colspan after a column is hidden', async () => {
    const user = userEvent.setup();
    const withExtra: Column<Row>[] = [
      ...columns,
      { key: 'extra', header: 'Extra', hideable: true, cell: () => 'extra-value' },
    ];
    render(
      <DataTable
        columns={withExtra}
        rows={groupedRows}
        groups={groups}
        rowKey={(row) => row.id}
        actions={() => <button type="button">edit</button>}
        storageKey="grouped-colspan"
      />,
    );
    expect(screen.getByRole('rowheader', { name: '硬件' })).toHaveAttribute('colspan', '4');

    await user.click(screen.getByRole('button', { name: /列/ }));
    await user.click(await screen.findByRole('button', { name: 'Extra' }));

    // Two visible columns plus the action column.
    expect(screen.getByRole('rowheader', { name: '硬件' })).toHaveAttribute('colspan', '3');
  });

  it('sorts inside every group without changing group order', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={columns} rows={groupedRows} groups={groups} rowKey={(row) => row.id} />);

    await user.click(screen.getByRole('button', { name: /CPU/ }));

    expect(screen.getAllByRole('rowheader').map((header) => header.textContent)).toEqual(['硬件', '软件']);
    const hardwareBody = screen.getByRole('rowheader', { name: '硬件' }).closest('tbody');
    const softwareBody = screen.getByRole('rowheader', { name: '软件' }).closest('tbody');
    expect(hardwareBody).not.toBeNull();
    expect(softwareBody).not.toBeNull();
    if (!hardwareBody || !softwareBody) return;

    expect(within(hardwareBody).getAllByRole('row')[1]).toHaveTextContent('cache-01');
    expect(within(softwareBody).getAllByRole('row')[1]).toHaveTextContent('api-01');

    await user.click(screen.getByRole('button', { name: /CPU/ }));
    expect(within(hardwareBody).getAllByRole('row')[1]).toHaveTextContent('web-01');
    expect(within(softwareBody).getAllByRole('row')[1]).toHaveTextContent('db-01');
  });

  it('shows the empty state when every group is empty', () => {
    render(
      <DataTable
        columns={columns}
        rows={[]}
        groups={[{ key: 'empty', header: <span>空组</span>, rows: [] }]}
        rowKey={(row) => row.id}
        empty="还没有内容"
      />,
    );

    expect(screen.getByText('没有数据')).toBeInTheDocument();
    expect(screen.queryByRole('rowheader')).not.toBeInTheDocument();
  });
});

describe('columns', () => {
  it('hides a column and remembers the choice', async () => {
    const user = userEvent.setup();
    const hideable: Column<Row>[] = [
      ...columns,
      { key: 'extra', header: 'Extra', hideable: true, cell: () => 'extra-value' },
    ];
    const { unmount } = render(
      <DataTable columns={hideable} rows={rows} rowKey={(row) => row.id} storageKey="t" />,
    );
    expect(screen.getAllByText('extra-value')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: /列/ }));
    await user.click(await screen.findByRole('button', { name: 'Extra' }));
    expect(screen.queryByText('extra-value')).not.toBeInTheDocument();

    unmount();
    render(<DataTable columns={hideable} rows={rows} rowKey={(row) => row.id} storageKey="t" />);
    expect(screen.queryByText('extra-value')).not.toBeInTheDocument();
  });

  it('starts with the declared default hidden, and a stored choice overrides it', async () => {
    const user = userEvent.setup();
    const withDefault: Column<Row>[] = [
      ...columns,
      { key: 'extra', header: 'Extra', hideable: true, defaultHidden: true, cell: () => 'extra-value' },
    ];
    const { unmount } = render(
      <DataTable columns={withDefault} rows={rows} rowKey={(row) => row.id} storageKey="d" />,
    );
    // `defaultHidden` MEANS "NOT IN THE FIRST VIEW", not "gone for good": the
    // column picker still offers it.
    expect(screen.queryByText('extra-value')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /列/ }));
    await user.click(await screen.findByRole('button', { name: 'Extra' }));
    expect(screen.getAllByText('extra-value')).toHaveLength(2);

    // AND THE EXPLICIT "SHOW EVERYTHING" IS REMEMBERED: a stored empty list is
    // a choice, so the default must not hide the column again.
    unmount();
    render(<DataTable columns={withDefault} rows={rows} rowKey={(row) => row.id} storageKey="d" />);
    expect(screen.getAllByText('extra-value')).toHaveLength(2);
  });
});

describe('selection', () => {
  it('selects one row and then the whole page', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        selection={{ selected: new Set(), onChange }}
      />,
    );

    // Index 0 is the header's "select every row on this page"; 1 and 2 are the rows.
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);

    await user.click(boxes[1]);
    const one = onChange.mock.calls.at(-1)![0] as Set<number>;
    expect([...one]).toEqual([1]);

    await user.click(boxes[0]);
    const all = onChange.mock.calls.at(-1)![0] as Set<number>;
    expect([...all].sort()).toEqual([1, 2]);
  });

  it('reports a partly selected page as indeterminate rather than checked', () => {
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        selection={{ selected: new Set([1]), onChange: () => {} }}
      />,
    );
    const all = screen.getAllByRole('checkbox')[0];
    // A half-selected page is NOT the same as a selected one: showing it as
    // checked would tell the operator every row is included when one is.
    expect(all).toHaveAttribute('aria-checked', 'mixed');
  });
});

describe('the action column', () => {
  it('is sticky and content-sized rather than a guessed width', () => {
    render(
      <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} actions={() => <button type="button">edit</button>} />,
    );
    const table = screen.getByRole('table');
    // The shared `.og-action-table` rules paint the sticky column; the table has
    // to opt into them or the fixed cell shows through.
    expect(table.className).toContain('og-action-table');
    const headers = screen.getAllByRole('columnheader');
    expect(headers.at(-1)?.className).toContain('w-px');
    expect(headers.at(-1)?.className).toContain('whitespace-nowrap');
    expect(screen.getAllByRole('button', { name: 'edit' })).toHaveLength(2);
  });
});
