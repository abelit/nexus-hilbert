import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { OngridLogo } from './OngridLogo';

const stops = (root: ParentNode) => Array.from(root.querySelectorAll('stop')).map(node => node.getAttribute('stop-color'));

describe('OngridLogo', () => {
  it('renders one variant per theme and lets the dark class pick', () => {
    const { container } = render(<OngridLogo />);
    const groups = Array.from(container.querySelectorAll('svg > g'));

    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveClass('dark:hidden');
    expect(groups[1]).toHaveClass('hidden', 'dark:block');
    // Light palette first, bright dark-UI palette second.
    expect(stops(groups[0])).toContain('#E75DC9');
    expect(stops(groups[1])).toContain('#F27BDA');
  });

  it('keeps gradient ids unique so several marks can share a page', () => {
    const { container } = render(
      <>
        <OngridLogo />
        <OngridLogo />
      </>,
    );
    const ids = Array.from(container.querySelectorAll('defs [id]')).map(node => node.id);
    expect(new Set(ids).size).toBe(ids.length);

    const referenced = Array.from(container.querySelectorAll('path[fill^="url("]')).map(node =>
      node.getAttribute('fill')!.slice('url(#'.length, -1),
    );
    for (const id of referenced) expect(ids).toContain(id);
  });

  it('exposes an accessible name', () => {
    const { getByRole } = render(<OngridLogo title="Ongrid" />);
    expect(getByRole('img', { name: 'Ongrid' })).toBeInTheDocument();
  });
});
