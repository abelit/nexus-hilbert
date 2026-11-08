import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RelationGraph } from '../lib/relation-graph';
import { RelationGraphCard } from './RelationGraphCard';

const searchHierarchy = vi.fn();
const listRelations = vi.fn();

vi.mock('../api/instance', () => ({
  searchHierarchy: (...args: unknown[]) => searchHierarchy(...args),
}));

vi.mock('../api/citype', () => ({
  listRelations: (...args: unknown[]) => listRelations(...args),
}));

vi.mock('./InstanceDetailPeek', () => ({
  InstanceDetailPeek: ({
    instanceID,
    typeID,
  }: {
    instanceID: number;
    typeID?: number;
  }) => <div data-testid="ci-peek" data-id={String(instanceID)} data-type={String(typeID ?? '')} />,
}));

const flow = vi.hoisted(() => ({
  nodes: [] as Array<{
    id: string;
    type?: string;
    data?: unknown;
    style?: { pointerEvents?: string };
  }>,
  fitView: vi.fn(),
}));

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    ReactFlow: ({
      nodes,
      nodeTypes,
      onInit,
    }: {
      nodes: typeof flow.nodes;
      nodeTypes?: Record<string, React.ComponentType<{ data: unknown }>>;
      onInit?: (instance: { fitView: typeof flow.fitView }) => void;
    }) => {
      flow.nodes = nodes;
      onInit?.({ fitView: flow.fitView });
      return (
        <div data-testid="relation-graph-flow">
          {nodes.map((node) => {
            const Component = nodeTypes?.[node.type ?? ''];
            if (!Component) return null;
            return <Component key={node.id} data={node.data} />;
          })}
        </div>
      );
    },
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
      { id: 9, name: 'app-01', type_id: 5, type_name: 'app' },
      { id: 2, name: 'db-01', type_id: 4, type_name: 'mysql' },
    ],
    edges: [
      { source: 9, target: 1, label: 'runs on' },
      { source: 1, target: 2, label: 'depends on' },
    ],
    counts: { upstream: 1, downstream: 1 },
    truncated: false,
  };
}

beforeEach(() => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
  searchHierarchy.mockReset().mockResolvedValue({ result: [] });
  listRelations.mockReset().mockResolvedValue([]);
});

describe('RelationGraphCard', () => {
  it('names the root and counts both directions', async () => {
    render(<RelationGraphCard graph={graphFixture()} />);

    expect(screen.getByText('关系图')).toBeInTheDocument();
    expect(screen.getByText(/1 上游/)).toBeInTheDocument();
    expect(screen.getByText(/1 下游/)).toBeInTheDocument();
  });

  it('lists every relation with its label', async () => {
    render(<RelationGraphCard graph={graphFixture()} />);

    await userEvent.click(screen.getByText('关联'));
    expect(screen.getByText(/runs on/)).toBeInTheDocument();
    expect(screen.getByText(/depends on/)).toBeInTheDocument();
  });

  it('expands a node and merges the new hop', async () => {
    searchHierarchy.mockImplementation((request: { reverse?: boolean }) =>
      Promise.resolve(
        request.reverse
          ? { result: [] }
          : { result: [{ _id: 7, _type: 4, name: 'db-02', ci_type: 'mysql', ci_type_alias: 'mysql' }] },
      ),
    );
    render(<RelationGraphCard graph={graphFixture()} />);

    await userEvent.click(screen.getByRole('button', { name: '展开 app-01 一跳' }));

    await waitFor(() => expect(flow.nodes.some((node) => node.id === '7')).toBe(true));
    expect(searchHierarchy).toHaveBeenCalledTimes(2);
  });

  it('keeps an expansion when the parent re-renders with an equal graph', async () => {
    searchHierarchy.mockImplementation((request: { reverse?: boolean }) =>
      Promise.resolve(
        request.reverse
          ? { result: [] }
          : { result: [{ _id: 7, _type: 4, name: 'db-02', ci_type: 'mysql', ci_type_alias: 'mysql' }] },
      ),
    );
    const { rerender } = render(<RelationGraphCard graph={graphFixture()} />);

    await userEvent.click(screen.getByRole('button', { name: '展开 app-01 一跳' }));
    await waitFor(() => expect(flow.nodes.some((node) => node.id === '7')).toBe(true));

    rerender(<RelationGraphCard graph={graphFixture()} />);
    expect(flow.nodes.some((node) => node.id === '7')).toBe(true);
  });

  it('re-fits the view after an expansion', async () => {
    searchHierarchy.mockImplementation((request: { reverse?: boolean }) =>
      Promise.resolve(
        request.reverse
          ? { result: [] }
          : { result: [{ _id: 7, _type: 4, name: 'db-02', ci_type: 'mysql', ci_type_alias: 'mysql' }] },
      ),
    );
    render(<RelationGraphCard graph={graphFixture()} />);
    flow.fitView.mockClear();

    await userEvent.click(screen.getByRole('button', { name: '展开 app-01 一跳' }));

    await waitFor(() => expect(flow.fitView).toHaveBeenCalled());
  });

  it('opts every CI node into pointer events', () => {
    render(<RelationGraphCard graph={graphFixture()} />);

    const ciNodes = flow.nodes.filter((node) => node.type === 'ci');
    expect(ciNodes.length).toBeGreaterThan(0);
    expect(ciNodes.every((node) => node.style?.pointerEvents === 'all')).toBe(true);
  });

  it('opens the read-only CI peek from a node', async () => {
    render(<RelationGraphCard graph={graphFixture()} />);

    await userEvent.click(screen.getByRole('button', { name: '查看 app-01 详情' }));
    expect(screen.getByTestId('ci-peek')).toHaveAttribute('data-id', '9');
  });

  it('aggregates a wide column', async () => {
    const graph = graphFixture();
    for (let i = 0; i < 12; i++) {
      graph.nodes.push({ id: 100 + i, name: `host-${i}`, type_id: 4, type_name: 'mysql' });
      graph.edges.push({ source: 1, target: 100 + i, label: 'contain' });
    }
    render(<RelationGraphCard graph={graph} />);

    expect(flow.nodes.filter((node) => node.type === 'ci')).toHaveLength(8);
    expect(flow.nodes.filter((node) => node.type === 'more')).toHaveLength(1);
    expect(screen.getByText('还有 7 个')).toBeInTheDocument();
  });

  it('opens an enlarged graph in a dialog', async () => {
    render(<RelationGraphCard graph={graphFixture()} />);

    await userEvent.click(screen.getByRole('button', { name: '放大关系图' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('relation-graph-modal-canvas')).toBeInTheDocument();
    expect(flow.nodes.filter((node) => node.type === 'ci')).toHaveLength(3);
  });

  it('collapses without losing the summary', async () => {
    render(<RelationGraphCard graph={graphFixture()} />);
    expect(screen.getByTestId('relation-graph-flow')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '收起关系图' }));

    expect(screen.getByText('关系图')).toBeInTheDocument();
    expect(screen.queryByTestId('relation-graph-flow')).not.toBeInTheDocument();
  });

  it('shows a readable error when expansion fails', async () => {
    searchHierarchy.mockRejectedValue(new Error('upstream down'));
    render(<RelationGraphCard graph={graphFixture()} />);

    await userEvent.click(screen.getByRole('button', { name: '展开 app-01 一跳' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/upstream down|无法展开关系/);
  });
});
