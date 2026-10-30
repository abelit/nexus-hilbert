import { render, screen } from '@testing-library/react';
import type { EdgeProps } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@xyflow/react', () => ({
  BaseEdge: ({ path, style }: { path: string; style?: React.CSSProperties }) => (
    <path data-testid="edge-path" d={path} style={style} />
  ),
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="edge-label-layer">{children}</div>
  ),
  getBezierPath: () => ['M 0 0 C 50 0 50 40 100 40', 50, 20],
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

import { ModelTopologyEdge, type ModelEdgePaintData } from './ModelTopologyEdge';

function edgeProps(data: Partial<ModelEdgePaintData> = {}): EdgeProps {
  return {
    id: 'edge-7',
    source: '1',
    target: '2',
    sourceX: 0,
    sourceY: 0,
    targetX: 100,
    targetY: 40,
    sourcePosition: 'right',
    targetPosition: 'left',
    sourceHandleId: null,
    targetHandleId: null,
    data: { label: 'contain', color: '#0ea5e9', dimmed: false, showLabel: true, offset: 0, ...data },
    style: {},
  } as unknown as EdgeProps;
}

describe('ModelTopologyEdge', () => {
  it('labels a visible edge with its relation name', () => {
    render(<ModelTopologyEdge {...edgeProps()} />);

    const label = screen.getByText('contain');
    expect(label).toHaveAttribute('data-edge-label');
    expect(label).toHaveStyle({ color: '#0ea5e9', borderColor: '#0ea5e9' });
    expect(label.style.background).toBe('rgb(var(--bg))');
  });

  it('hides the label when the layout asks it to', () => {
    render(<ModelTopologyEdge {...edgeProps({ showLabel: false })} />);

    expect(screen.queryByText('contain')).not.toBeInTheDocument();
    expect(screen.queryByTestId('edge-label-layer')).not.toBeInTheDocument();
  });

  it('dims the path and the label together', () => {
    render(<ModelTopologyEdge {...edgeProps({ dimmed: true })} />);

    expect(screen.getByTestId('edge-path')).toHaveStyle({ opacity: '0.18' });
    expect(screen.getByText('contain')).toHaveStyle({ opacity: '0.18' });
  });

  it('keeps a fully opaque path by default', () => {
    render(<ModelTopologyEdge {...edgeProps()} />);

    expect(screen.getByTestId('edge-path')).toHaveStyle({ opacity: '1' });
  });

  it('offsets a parallel edge and its label by twelve pixels per index', () => {
    render(<ModelTopologyEdge {...edgeProps({ offset: 2 })} />);

    expect(screen.getByText('contain').style.transform).toContain('translate(0px, 24px)');
  });
});
