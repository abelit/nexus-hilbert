import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelNodeCard, type ModelNodeCardData } from './ModelTopologyNode';
import type { ModelNode } from './model-topology';

const node: ModelNode = {
  id: 1,
  alias: '业务应用',
  name: 'business_application',
  groupColor: '#0ea5e9',
  side: 'right',
  depth: 1,
};

function cardData(overrides: Partial<ModelNodeCardData> = {}): ModelNodeCardData {
  return {
    node,
    isCenter: false,
    badge: { kind: 'none' },
    dimmed: false,
    focused: false,
    ...overrides,
  };
}

function renderCard(data: ModelNodeCardData, callbacks: { onOpen?: () => void; onToggle?: () => void } = {}) {
  const onOpen = callbacks.onOpen ?? vi.fn();
  const onToggle = callbacks.onToggle ?? vi.fn();
  render(<ModelNodeCard data={data} onOpen={onOpen} onToggle={onToggle} />);
  return { onOpen, onToggle };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
});

describe('ModelNodeCard', () => {
  it('shows the alias, the technical name and the model icon', () => {
    renderCard(cardData(), {});

    expect(screen.getByText('业务应用')).toHaveAttribute('title', '业务应用');
    expect(screen.getByText('business_application')).toHaveAttribute('title', 'business_application');
    expect(screen.getByRole('img', { name: '业务应用' })).toBeInTheDocument();
  });

  it('marks the center card', () => {
    renderCard(cardData({ isCenter: true }));

    expect(screen.getByRole('button', { name: '业务应用' })).toHaveAttribute('data-center', 'true');
  });

  it('does not mark an ordinary card as the center', () => {
    renderCard(cardData());

    expect(screen.getByRole('button', { name: '业务应用' })).not.toHaveAttribute('data-center');
  });

  it('renders a count badge with an accessible expand label', () => {
    renderCard(cardData({ badge: { kind: 'count', count: 5 } }));

    const badge = screen.getByRole('button', { name: '展开 5 个下级' });
    expect(badge).toHaveTextContent('+5');
  });

  it('renders the collapsed and loading states', () => {
    const { unmount } = render(
      <ModelNodeCard data={cardData({ badge: { kind: 'expanded' } })} onOpen={() => {}} onToggle={() => {}} />,
    );
    expect(screen.getByRole('button', { name: '收起下级' })).toHaveTextContent('−');
    unmount();

    render(
      <ModelNodeCard
        data={cardData({ badge: { kind: 'loading' } })}
        onOpen={() => {}}
        onToggle={() => {}}
      />,
    );
    const loading = screen.getByRole('button', { name: '正在加载下级' });
    expect(loading).toBeDisabled();
  });

  it('renders a retry plus and nothing when there is no badge', () => {
    const { unmount } = render(
      <ModelNodeCard
        data={cardData({ badge: { kind: 'retry' } })}
        onOpen={() => {}}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: '展开下级' })).toHaveTextContent('+');
    unmount();

    renderCard(cardData({ badge: { kind: 'none' } }));
    expect(screen.queryByRole('button', { name: /展开|收起/ })).not.toBeInTheDocument();
  });

  it('does not open the model when the badge is clicked', async () => {
    const user = userEvent.setup();
    const { onOpen, onToggle } = renderCard(cardData({ badge: { kind: 'count', count: 3 } }));

    await user.click(screen.getByRole('button', { name: '展开 3 个下级' }));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('opens the model when the card is clicked', async () => {
    const user = userEvent.setup();
    const { onOpen } = renderCard(cardData());

    await user.click(screen.getByRole('button', { name: '业务应用' }));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('opens with Enter and Space from the keyboard', async () => {
    const user = userEvent.setup();
    const { onOpen } = renderCard(cardData());
    const card = screen.getByRole('button', { name: '业务应用' });

    card.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');

    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('carries a focus-visible outline and the focused prop', () => {
    renderCard(cardData({ focused: true }));

    const card = screen.getByRole('button', { name: '业务应用' });
    expect(card).toHaveAttribute('data-focused', 'true');
    expect(card.className).toContain('focus-visible:outline');
  });

  it('dims unrelated cards', () => {
    const { unmount } = render(
      <ModelNodeCard data={cardData({ dimmed: true })} onOpen={() => {}} onToggle={() => {}} />,
    );
    expect(screen.getByRole('button', { name: '业务应用' })).toHaveStyle({ opacity: '0.18' });
    unmount();

    renderCard(cardData({ dimmed: false }));
    expect(screen.getByRole('button', { name: '业务应用' })).toHaveStyle({ opacity: '1' });
  });
});
