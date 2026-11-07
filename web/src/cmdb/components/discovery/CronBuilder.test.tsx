import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CronBuilder } from './CronBuilder';

describe('cron builder', () => {
  it('opens on the current expression and applies a reset', async () => {
    const apply = vi.fn();
    render(<CronBuilder value="0/1 * * * *" onApply={apply} onCancel={() => {}} />);

    expect(screen.getByRole('tab', { name: '分' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '时' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '日' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '月' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '周' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '重置' }));
    await userEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(apply).toHaveBeenCalledWith('* * * * *');
  });

  it('switches fields without losing the other tabs', async () => {
    const apply = vi.fn();
    render(<CronBuilder value="30 2 * * *" onApply={apply} onCancel={() => {}} />);

    await userEvent.click(screen.getByRole('tab', { name: '时' }));
    expect(screen.getByText('每小时')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(apply).toHaveBeenCalledWith('30 2 * * *');
  });

  it('leaves Quartz syntax to the text editor', () => {
    render(<CronBuilder value="0 2 * * ?" onApply={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent('构建器不支持');
  });
});
