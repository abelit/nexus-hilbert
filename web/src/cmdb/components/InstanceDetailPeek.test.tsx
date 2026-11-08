import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InstanceDetailPeek } from './InstanceDetailPeek';

const listCITypes = vi.fn();
const listTypeAttributes = vi.fn();
const listAttributeGroups = vi.fn();

vi.mock('../api/citype', () => ({
  listCITypes: (...args: unknown[]) => listCITypes(...args),
  listTypeAttributes: (...args: unknown[]) => listTypeAttributes(...args),
  listAttributeGroups: (...args: unknown[]) => listAttributeGroups(...args),
}));

vi.mock('./instance-detail/InstanceDetailDrawer', () => ({
  InstanceDetailDrawer: (props: { readOnly?: boolean; instanceID: number }) => (
    <div
      data-testid="peek-drawer"
      data-readonly={String(props.readOnly)}
      data-id={String(props.instanceID)}
    />
  ),
}));

beforeEach(() => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
  listCITypes.mockReset().mockResolvedValue([
    { id: 3, name: 'host', alias: '主机', enabled: true, is_attached: true },
  ]);
  listTypeAttributes.mockReset().mockResolvedValue({ attributes: [] });
  listAttributeGroups.mockReset().mockResolvedValue([]);
});

describe('InstanceDetailPeek', () => {
  it('loads the model and opens a read-only drawer', async () => {
    render(<InstanceDetailPeek instanceID={5} typeID={3} onClose={() => undefined} />);

    const drawer = await screen.findByTestId('peek-drawer');
    expect(drawer).toHaveAttribute('data-readonly', 'true');
    expect(drawer).toHaveAttribute('data-id', '5');
    expect(listCITypes).toHaveBeenCalled();
    expect(listTypeAttributes).toHaveBeenCalledWith(3);
    expect(listAttributeGroups).toHaveBeenCalledWith(3);
  });

  it('shows a readable error when the metadata fails', async () => {
    listCITypes.mockRejectedValue(new Error('boom'));

    render(<InstanceDetailPeek instanceID={5} typeID={3} onClose={() => undefined} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/boom|无法加载资源详情/);
    expect(screen.queryByTestId('peek-drawer')).not.toBeInTheDocument();
  });
});
