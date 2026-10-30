import { render, screen } from '@testing-library/react';
import type { EdgeProps } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';

// THE EDGE IS TESTED WITHOUT REACT FLOW. The custom edge only needs to render
// the label the layout already computed; drawing the path is React Flow's job.
vi.mock('@xyflow/react', () => ({
  BaseEdge: () => null,
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="edge-label-layer">{children}</div>
  ),
  useNodes: () => [],
  getSmoothStepPath: () => ['M 0 0 L 100 0', 50, 0],
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  Background: () => null,
  BackgroundVariant: {},
  Controls: () => null,
  Handle: () => null,
  MiniMap: () => null,
  ReactFlow: () => null,
}));

import { AvoidingEdge } from './Graph';

describe('the topology edge', () => {
  it('renders the relation label the layout computed', () => {
    const props = {
      id: 'rel-7',
      source: '1',
      target: '2',
      sourceX: 0,
      sourceY: 0,
      targetX: 100,
      targetY: 0,
      sourcePosition: 'right',
      targetPosition: 'left',
      sourceHandleId: null,
      targetHandleId: null,
      label: '包含',
      labelStyle: { fill: '#6366f1', fontSize: 10 },
      labelBgStyle: { fill: '#ffffff', fillOpacity: 0.9 },
      labelBgPadding: [4, 2],
      labelBgBorderRadius: 3,
      labelShowBg: true,
      style: {},
    } as unknown as EdgeProps;

    render(<AvoidingEdge {...props} />);

    expect(screen.getByTestId('edge-label-layer')).toHaveTextContent('包含');
  });

  it('draws no label layer when the layout hid the label', () => {
    const props = {
      id: 'rel-8',
      source: '1',
      target: '2',
      sourceX: 0,
      sourceY: 0,
      targetX: 100,
      targetY: 0,
      sourcePosition: 'right',
      targetPosition: 'left',
      sourceHandleId: null,
      targetHandleId: null,
      label: undefined,
      labelStyle: { fill: '#6366f1', fontSize: 10 },
      style: {},
    } as unknown as EdgeProps;

    render(<AvoidingEdge {...props} />);

    expect(screen.queryByTestId('edge-label-layer')).not.toBeInTheDocument();
  });
});
