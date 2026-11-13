import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SettingsGeneral from './General';

const listMock = vi.fn();
const setMock = vi.fn();

vi.mock('@/api/settings', () => ({
  listSettings: (category?: string) => listMock(category),
  setSetting: (category: string, key: string, value: string, sensitive?: boolean) =>
    setMock(category, key, value, sensitive),
}));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  listMock.mockReset().mockResolvedValue({ items: [], total: 0 });
  setMock.mockReset().mockResolvedValue({});
});

describe('general settings — Edge install addresses', () => {
  it('saves the internal and external base URLs', async () => {
    const user = userEvent.setup();
    render(<SettingsGeneral />);

    const internal = await screen.findByLabelText('内网地址');
    const external = screen.getByLabelText('外网地址');
    await user.type(internal, 'https://ongrid.intra');
    await user.type(external, 'https://ongrid.example.com');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        'edge',
        'install_internal_url',
        'https://ongrid.intra',
        false,
      ),
    );
    expect(setMock).toHaveBeenCalledWith(
      'edge',
      'install_external_url',
      'https://ongrid.example.com',
      false,
    );
    expect(await screen.findByText('已保存')).toBeInTheDocument();
  });

  it('rejects a value that is not an absolute http(s) URL', async () => {
    const user = userEvent.setup();
    render(<SettingsGeneral />);

    const internal = await screen.findByLabelText('内网地址');
    await user.type(internal, 'ongrid.intra');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText(/必须是完整的 http\(s\) URL/)).toBeInTheDocument();
    expect(setMock).not.toHaveBeenCalled();
  });
});
