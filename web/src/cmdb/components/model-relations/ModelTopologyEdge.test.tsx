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
    data: {
      label: 'contain',
      color: '#0ea5e9',
      dimmed: false,
      showLabel: true,
      offset: 0,
      constraintLabel: '1:N',
      ...data,
    },
    style: {},
  } as unknown as EdgeProps;
}

function labelText(): string {
  return screen.getByTestId('edge-label-name').textContent ?? '';
}

describe('ModelTopologyEdge', () => {
  it('labels a visible edge with its relation name', () => {
    render(<ModelTopologyEdge {...edgeProps()} />);

    const label = screen.getByTestId('edge-label');
    expect(label).toHaveAttribute('data-edge-label');
    expect(label).toHaveAttribute('data-constraint-label', '1:N');
    expect(labelText()).toBe('contain');
    expect(label).toHaveStyle({ color: '#0ea5e9', borderColor: '#0ea5e9' });
    expect(label.style.background).toBe('rgb(var(--bg))');
  });

  it('puts the cardinality on the chip border instead of the edge line', () => {
    render(<ModelTopologyEdge {...edgeProps()} />);

    const cardinality = screen.getByTestId('edge-cardinality');
    expect(cardinality).toHaveTextContent('1:N');
    expect(cardinality.className).toContain('cmdb-relation-edge-cardinality');
    expect(cardinality.closest('[data-edge-label]')).toBe(screen.getByTestId('edge-label'));
  });

  it('keeps the relation name when the constraint code is unknown', () => {
    render(<ModelTopologyEdge {...edgeProps({ constraintLabel: undefined })} />);

    expect(screen.getByTestId('edge-label')).not.toHaveAttribute('data-constraint-label');
    expect(labelText()).toBe('contain');
    expect(screen.queryByTestId('edge-cardinality')).not.toBeInTheDocument();
  });

  it('exposes the full relation and cardinality as the edge tooltip', () => {
    render(<ModelTopologyEdge {...edgeProps()} />);

    expect(screen.getByText('contain · 1:N', { selector: 'title' })).toBeInTheDocument();
  });

  it('hides the label when the layout asks it to', () => {
    render(<ModelTopologyEdge {...edgeProps({ showLabel: false })} />);

    expect(screen.queryByTestId('edge-label')).not.toBeInTheDocument();
    expect(screen.queryByTestId('edge-label-layer')).not.toBeInTheDocument();
  });

  it('dims the path and the label together', () => {
    render(<ModelTopologyEdge {...edgeProps({ dimmed: true })} />);

    expect(screen.getByTestId('edge-path')).toHaveStyle({ opacity: '0.18' });
    expect(screen.getByTestId('edge-label')).toHaveStyle({ opacity: '0.18' });
  });

  it('marks the label of the focused path', () => {
    render(<ModelTopologyEdge {...edgeProps({ connected: true })} />);

    expect(screen.getByTestId('edge-label').className).toContain('is-connected');
  });

  it('keeps a fully opaque path by default', () => {
    render(<ModelTopologyEdge {...edgeProps()} />);

    expect(screen.getByTestId('edge-path')).toHaveStyle({ opacity: '1' });
  });

  it('offsets a parallel edge and its label by twelve pixels per index', () => {
    render(<ModelTopologyEdge {...edgeProps({ offset: 2 })} />);

    expect(screen.getByTestId('edge-label').style.transform).toContain('translate(0px, 24px)');
  });
});
