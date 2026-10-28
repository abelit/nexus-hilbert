import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PaginationFooter } from './PaginationFooter';

beforeEach(() => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
});

describe('the pagination footer', () => {
  it('floats by default', () => {
    render(
      <PaginationFooter page={0} pageSize={50} shown={50} total={254} onPageChange={() => {}} />,
    );
    expect(screen.getByText('1-50 / 共 254 条').parentElement).toHaveClass('sticky');
  });

  it('can spread a caller summary to the start and show page numbers', () => {
    const go = vi.fn();
    render(
      <PaginationFooter
        page={1}
        pageSize={20}
        shown={20}
        total={89}
        showPageNumbers
        summary="显示 21 至 40 条，共 89 条模型"
        onPageChange={go}
      />,
    );
    expect(screen.getByText('显示 21 至 40 条，共 89 条模型')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '第 2 页' })).toHaveAttribute('aria-current', 'page');
    screen.getByRole('button', { name: '第 3 页' }).click();
    expect(go).toHaveBeenCalledWith(2);
  });

  it('can stay in the flow so it does not cover table rows', () => {
    render(
      <PaginationFooter
        page={0}
        pageSize={50}
        shown={50}
        total={254}
        sticky={false}
        onPageChange={() => {}}
      />,
    );
    const footer = screen.getByText('1-50 / 共 254 条').parentElement!;
    expect(footer).not.toHaveClass('sticky');
    expect(footer).toHaveAttribute('data-slot', 'pagination-footer');
  });
});
