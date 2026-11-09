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
  getBezierPath: () => ['bezier-path', 50, 20],
  getSimpleBezierPath: () => ['simple-path', 50, 20],
  getSmoothStepPath: () => ['smooth-path', 50, 20, 0, 0],
  getStraightPath: () => ['straight-path', 50, 20],
}));

import { RelationGraphEdge, type RelationGraphEdgeData } from './RelationGraphEdge';

function edgeProps(data: Partial<RelationGraphEdgeData> = {}): EdgeProps {
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
    sourceHandleId: 'source-right',
    targetHandleId: 'target-left',
    data: {
      name: '包含',
      cardinality: '1:N',
      color: '#94a3b8',
      showLabel: true,
      pathType: 'smoothstep',
      ...data,
    },
    style: {},
  } as unknown as EdgeProps;
}

describe('RelationGraphEdge', () => {
  it('draws a smooth step path for the tree layout with the cardinality badge', () => {
    render(<RelationGraphEdge {...edgeProps()} />);

    expect(screen.getByTestId('edge-path')).toHaveAttribute('d', 'smooth-path');
    expect(screen.getByTestId('edge-label-name')).toHaveTextContent('包含');
    expect(screen.getByTestId('edge-cardinality')).toHaveTextContent('1:N');
  });

  it('follows the selected layout path', () => {
    const { rerender } = render(<RelationGraphEdge {...edgeProps({ pathType: 'straight' })} />);
    expect(screen.getByTestId('edge-path')).toHaveAttribute('d', 'straight-path');

    rerender(<RelationGraphEdge {...edgeProps({ pathType: 'simplebezier' })} />);
    expect(screen.getByTestId('edge-path')).toHaveAttribute('d', 'simple-path');

    rerender(<RelationGraphEdge {...edgeProps({ pathType: 'bezier' })} />);
    expect(screen.getByTestId('edge-path')).toHaveAttribute('d', 'bezier-path');
  });

  it('hides the chip when the link is dimmed or too dense to label', () => {
    render(<RelationGraphEdge {...edgeProps({ showLabel: false })} />);

    expect(screen.queryByTestId('edge-label')).not.toBeInTheDocument();
  });
});
