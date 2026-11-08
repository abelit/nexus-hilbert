import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RelationGraph } from '../lib/relation-graph';
import { RelationGraphCard } from './RelationGraphCard';

const listCITypes = vi.fn();
const listTypeAttributes = vi.fn();
const listAttributeGroups = vi.fn();
const listRelations = vi.fn();
const searchHierarchy = vi.fn();

vi.mock('../api/citype', () => ({
  listCITypes: (...args: unknown[]) => listCITypes(...args),
  listTypeAttributes: (...args: unknown[]) => listTypeAttributes(...args),
  listAttributeGroups: (...args: unknown[]) => listAttributeGroups(...args),
  listRelations: (...args: unknown[]) => listRelations(...args),
}));

vi.mock('../api/instance', () => ({
  searchHierarchy: (...args: unknown[]) => searchHierarchy(...args),
}));

vi.mock('./Drawer', () => ({
  Drawer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('./instance-detail/InstanceDetailDrawer', () => ({
  InstanceDetailDrawer: (props: { readOnly?: boolean; instanceID: number }) => (
    <div
      data-testid="ci-detail-drawer"
      data-readonly={String(props.readOnly)}
      data-id={String(props.instanceID)}
    />
  ),
}));

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    ReactFlow: ({
      nodes,
      nodeTypes,
    }: {
      nodes: Array<{ id: string; type?: string; data?: unknown }>;
      nodeTypes?: Record<string, React.ComponentType<{ data: unknown }>>;
    }) => (
      <div data-testid="relation-graph-flow">
        {nodes.map((node) => {
          const Component = nodeTypes?.[node.type ?? ''];
          if (!Component) return null;
          return <Component key={node.id} data={node.data} />;
        })}
      </div>
    ),
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
    MarkerType: { ArrowClosed: 'arrowclosed' },
    Position: { Left: 'left', Right: 'right' },
  };
});

function graphFixture(): RelationGraph {
  return {
    root: { id: 1, name: 'web-01', type_id: 3, type_name: 'server' },
    nodes: [
      { id: 1, name: 'web-01', type_id: 3, type_name: 'server' },
      { id: 9, name: 'app-01', type_id: 3, type_name: 'server' },
    ],
    edges: [{ source: 9, target: 1, label: 'runs on' }],
    counts: { upstream: 1, downstream: 0 },
    truncated: false,
  };
}

beforeEach(() => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
  listCITypes.mockReset().mockResolvedValue([
    { id: 3, name: 'host', alias: '主机', enabled: true, is_attached: true },
  ]);
  listTypeAttributes.mockReset().mockResolvedValue({ attributes: [] });
  listAttributeGroups.mockReset().mockResolvedValue([]);
  listRelations.mockReset().mockResolvedValue([]);
  searchHierarchy.mockReset().mockResolvedValue({ result: [] });
});

describe('RelationGraphCard CI detail drawer', () => {
  it('opens the right-side CI detail drawer when the node card is clicked', async () => {
    render(<RelationGraphCard graph={graphFixture()} />);

    await userEvent.click(screen.getByRole('button', { name: '查看 app-01 详情' }));

    const drawer = await screen.findByTestId('ci-detail-drawer');
    expect(drawer).toHaveAttribute('data-readonly', 'true');
    expect(drawer).toHaveAttribute('data-id', '9');
    expect(listCITypes).toHaveBeenCalled();
    expect(listTypeAttributes).toHaveBeenCalledWith(3);
  });
});
