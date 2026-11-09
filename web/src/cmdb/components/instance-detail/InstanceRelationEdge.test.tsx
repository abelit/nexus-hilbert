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
}));

import { InstanceRelationEdge, type InstanceRelationEdgeData } from './InstanceRelationEdge';

function edgeProps(data: Partial<InstanceRelationEdgeData> = {}): EdgeProps {
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
      name: '包含',
      cardinality: '1:N',
      color: '#0ea5e9',
      showLabel: true,
      ...data,
    },
    style: {},
  } as unknown as EdgeProps;
}

describe('InstanceRelationEdge', () => {
  it('draws the relation name and cardinality badge on the edge', () => {
    render(<InstanceRelationEdge {...edgeProps()} />);

    expect(screen.getByTestId('edge-path')).toHaveAttribute('d', 'M 0 0 C 50 0 50 40 100 40');
    expect(screen.getByTestId('edge-label-name')).toHaveTextContent('包含');
    expect(screen.getByTestId('edge-cardinality')).toHaveTextContent('1:N');
  });

  it('hides the chip when the relation style is off', () => {
    render(<InstanceRelationEdge {...edgeProps({ showLabel: false })} />);

    expect(screen.queryByTestId('edge-label')).not.toBeInTheDocument();
    expect(screen.queryByTestId('edge-label-layer')).not.toBeInTheDocument();
  });
});
