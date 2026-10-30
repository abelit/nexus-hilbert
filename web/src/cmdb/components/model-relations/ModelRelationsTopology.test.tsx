import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/test/msw-server';

import type { CIType, RelatedType } from '../../api/citype';
import { ToastProvider } from '../Toast';
import { ModelRelationsTopology, type ModelRelationsTopologyProps } from './ModelRelationsTopology';

const flow = vi.hoisted(() => ({
  fitView: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  setCenter: vi.fn(),
}));
const exportPng = vi.hoisted(() => vi.fn());

vi.mock('./model-topology-export', () => ({ downloadTopologyPng: exportPng }));

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReactFlow: () => flow,
    ReactFlow: ({
      nodes,
      edges,
      nodeTypes,
      children,
      onNodeMouseEnter,
      onNodeMouseLeave,
      onNodeClick,
      onPaneClick,
    }: {
      nodes: Array<{ id: string; type: string; data: { node?: { alias?: string } } }>;
      edges: Array<{
        id: string;
        sourceHandle?: string;
        targetHandle?: string;
        data?: { label?: string; dimmed?: boolean; showLabel?: boolean; connected?: boolean; offset?: number };
      }>;
      nodeTypes?: Record<string, React.ComponentType<{ id: string; data: unknown; selected: boolean }>>;
      children?: React.ReactNode;
      onNodeMouseEnter?(event: unknown, node: unknown): void;
      onNodeMouseLeave?(event: unknown, node: unknown): void;
      onNodeClick?(event: unknown, node: unknown): void;
      onPaneClick?(event: unknown): void;
    }) => (
      <div data-testid="flow-canvas" onClick={() => onPaneClick?.({})}>
        {nodes.map((node) => {
          const Component = nodeTypes?.[node.type];
          return (
            <div
              key={node.id}
              data-testid={`flow-node-${node.id}`}
              onMouseEnter={() => onNodeMouseEnter?.({}, node)}
              onMouseLeave={() => onNodeMouseLeave?.({}, node)}
              onClick={(event) => {
                event.stopPropagation();
                onNodeClick?.({}, node);
              }}
            >
              {Component ? React.createElement(Component, { id: node.id, data: node.data, selected: false }) : node.data?.node?.alias}
            </div>
          );
        })}
        {edges.map((edge) => (
          <span
            key={edge.id}
            data-testid={`flow-edge-${edge.id}`}
            data-label={edge.data?.label}
            data-dimmed={edge.data?.dimmed ? 'true' : 'false'}
            data-show-label={edge.data?.showLabel ? 'true' : 'false'}
            data-connected={edge.data?.connected ? 'true' : 'false'}
            data-offset={edge.data?.offset}
            data-source-handle={edge.sourceHandle}
            data-target-handle={edge.targetHandle}
          />
        ))}
        {children}
      </div>
    ),
    Background: () => null,
    BackgroundVariant: {},
    BaseEdge: () => null,
    EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Handle: () => null,
    MiniMap: () => <div data-testid="minimap" />,
    Controls: () => null,
    Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    MarkerType: { ArrowClosed: 'arrowclosed' },
    getBezierPath: () => ['M 0 0', 50, 20],
  };
});

const model = (id: number, name: string, alias = name): CIType => ({
  id,
  name,
  alias,
  enabled: true,
  is_attached: true,
  order: 0,
  parent_ids: [],
});

const relation = (
  ctrID: number,
  type: CIType,
  relationName = 'contain',
  color = '#0ea5e9',
): RelatedType => ({
  ctr_id: ctrID,
  type,
  show_key: 'name',
  attributes: [],
  relation_type: { id: 1, name: relationName, color },
  constraint: '0',
  parent_attr_ids: [],
  child_attr_ids: [],
});

const center = model(10, 'business_application', '业务应用');
const parent = model(20, 'service', '服务');
const child = model(30, 'certificate', '证书');
const parentRelation = relation(1, parent, 'depend', '#f59e0b');
const childRelation = relation(2, child, 'contain', '#0ea5e9');

const probeItems = Array.from({ length: 5 }, (_, index) => {
  const id = 40 + index;
  return relation(100 + index, model(id, `up_${id}`, `上级${id}`));
});

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}
      {location.search}
    </div>
  );
}

function view(props: Partial<ModelRelationsTopologyProps> = {}) {
  return (
    <MemoryRouter initialEntries={['/cmdb/models/10']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <ToastProvider>
                <ModelRelationsTopology
                  center={props.center ?? center}
                  parents={props.parents ?? [parentRelation]}
                  children={props.children ?? [childRelation]}
                  groups={props.groups ?? []}
                />
              </ToastProvider>
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

function stubCoarsePointer() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('pointer: coarse'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ongrid-locale', 'zh-CN');
  window.matchMedia = undefined as unknown as typeof window.matchMedia;
  flow.fitView.mockClear();
  flow.zoomIn.mockClear();
  flow.zoomOut.mockClear();
  exportPng.mockReset();
});

describe('ModelRelationsTopology', () => {
  it('renders the center and its one-hop relations', async () => {
    render(view());

    expect(await screen.findByText('业务应用')).toBeInTheDocument();
    expect(screen.getByText('服务')).toBeInTheDocument();
    expect(screen.getByText('证书')).toBeInTheDocument();
    expect(screen.getByTestId('flow-edge-20-10-1')).toHaveAttribute('data-label', 'depend');
    expect(screen.getByTestId('flow-edge-10-30-2')).toHaveAttribute('data-label', 'contain');
  });

  it('probes a left node on hover and shows the real count', async () => {
    let requests = 0;
    server.use(
      http.get('/api/v1/cmdb/ci-types/20/relation-parents', () => {
        requests += 1;
        return HttpResponse.json({ items: probeItems, total: 5 });
      }),
    );
    render(view());

    fireEvent.mouseEnter(screen.getByTestId('flow-node-20'));

    const badge = await screen.findByRole('button', { name: '展开 5 个下级' }, { timeout: 2000 });
    expect(badge).toHaveTextContent('+5');
    expect(requests).toBe(1);
  });

  it('probes children for a right-side node', async () => {
    let requested = '';
    server.use(
      http.get('/api/v1/cmdb/ci-types/30/relation-children', () => {
        requested = 'children';
        return HttpResponse.json({ items: [relation(600, model(60, 'x', '子模型'))], total: 1 });
      }),
    );
    render(view());
    const user = userEvent.setup();

    await user.hover(screen.getByTestId('flow-node-30'));

    expect(
      await screen.findByRole('button', { name: '展开 1 个下级' }, { timeout: 2000 }),
    ).toBeInTheDocument();
    expect(requested).toBe('children');
  });

  it('shows no badge when a probed node has no further relations', async () => {
    let requests = 0;
    server.use(
      http.get('/api/v1/cmdb/ci-types/20/relation-parents', () => {
        requests += 1;
        return HttpResponse.json({ items: [], total: 0 });
      }),
    );
    render(view());
    const user = userEvent.setup();

    await user.hover(screen.getByTestId('flow-node-20'));
    await waitFor(() => expect(requests).toBe(1));

    expect(screen.queryByRole('button', { name: /展开 \d+ 个下级/ })).not.toBeInTheDocument();
  });

  it('expands from the probe cache and collapses with a hidden count', async () => {
    let requests = 0;
    server.use(
      http.get('/api/v1/cmdb/ci-types/20/relation-parents', () => {
        requests += 1;
        return HttpResponse.json({ items: probeItems, total: 5 });
      }),
    );
    render(view());
    const user = userEvent.setup();

    await user.hover(screen.getByTestId('flow-node-20'));
    const badge = await screen.findByRole('button', { name: '展开 5 个下级' }, { timeout: 2000 });
    await user.click(badge);

    expect(await screen.findByText('上级40')).toBeInTheDocument();
    expect(requests).toBe(1);

    await user.click(screen.getByRole('button', { name: '收起下级' }));
    expect(screen.queryByText('上级40')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '展开 5 个下级' })).toBeInTheDocument();
  });

  it('resets the graph when the center changes', async () => {
    const { rerender } = render(view());
    expect(await screen.findByText('业务应用')).toBeInTheDocument();

    rerender(view({ center: child, parents: [], children: [] }));

    expect(await screen.findByText('证书')).toBeInTheDocument();
    expect(screen.queryByText('业务应用')).not.toBeInTheDocument();
    expect(screen.queryByText('服务')).not.toBeInTheDocument();
  });

  it('drops a probe that resolves after the center changed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    server.use(
      http.get('/api/v1/cmdb/ci-types/20/relation-parents', async () => {
        started += 1;
        await gate;
        return HttpResponse.json({
          items: [relation(300, model(99, 'stale', '旧节点'))],
          total: 1,
        });
      }),
    );
    const { rerender } = render(view());
    const user = userEvent.setup();

    await user.hover(screen.getByTestId('flow-node-20'));
    await waitFor(() => expect(started).toBe(1));

    rerender(view({ center: child, parents: [], children: [] }));
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByText('旧节点')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /展开 1 个下级/ })).not.toBeInTheDocument();
  });

  it('refuses an expansion that would exceed 300 visible nodes', async () => {
    const many = Array.from({ length: 300 }, (_, index) =>
      relation(400 + index, model(1000 + index, `m${index}`, `模型${index}`)),
    );
    server.use(
      http.get('/api/v1/cmdb/ci-types/20/relation-parents', () =>
        HttpResponse.json({ items: many, total: 300 }),
      ),
    );
    render(view());
    const user = userEvent.setup();

    await user.hover(screen.getByTestId('flow-node-20'));
    const badge = await screen.findByRole('button', { name: '展开 300 个下级' }, { timeout: 2000 });
    await user.click(badge);

    expect(await screen.findByText('节点过多，请先折叠部分分支')).toBeInTheDocument();
    expect(screen.queryByText('模型0')).not.toBeInTheDocument();
  });

  it('retries a failed probe when the retry badge is clicked', async () => {
    let calls = 0;
    server.use(
      http.get('/api/v1/cmdb/ci-types/20/relation-parents', () => {
        calls += 1;
        if (calls === 1) return new HttpResponse(null, { status: 500 });
        return HttpResponse.json({
          items: [relation(500, model(50, 'a', '甲模型'))],
          total: 1,
        });
      }),
    );
    render(view());
    const user = userEvent.setup();

    await user.hover(screen.getByTestId('flow-node-20'));
    const retry = await screen.findByRole('button', { name: '展开下级' }, { timeout: 2000 });
    await user.click(retry);

    expect(await screen.findByText('甲模型')).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it('dims everything except the hovered node and its direct path', () => {
    server.use(
      http.get('/api/v1/cmdb/ci-types/20/relation-parents', () =>
        HttpResponse.json({ items: [], total: 0 }),
      ),
    );
    render(view());

    fireEvent.mouseEnter(screen.getByTestId('flow-node-20'));

    expect(screen.getByRole('button', { name: '业务应用' })).toHaveAttribute('data-dimmed', 'false');
    expect(screen.getByRole('button', { name: '服务' })).toHaveAttribute('data-dimmed', 'false');
    expect(screen.getByRole('button', { name: '证书' })).toHaveAttribute('data-dimmed', 'true');
    expect(screen.getByTestId('flow-edge-20-10-1')).toHaveAttribute('data-dimmed', 'false');
    expect(screen.getByTestId('flow-edge-10-30-2')).toHaveAttribute('data-dimmed', 'true');

    fireEvent.mouseLeave(screen.getByTestId('flow-node-20'));

    expect(screen.getByRole('button', { name: '证书' })).toHaveAttribute('data-dimmed', 'false');
    expect(screen.getByTestId('flow-edge-10-30-2')).toHaveAttribute('data-dimmed', 'false');
  });

  it('opens the model on a mouse click', async () => {
    const user = userEvent.setup();
    render(view());

    await user.click(screen.getByRole('button', { name: '服务' }));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/cmdb/models/20?tab=relations'),
    );
  });

  it('focuses on the first tap and opens on the second for a coarse pointer', async () => {
    stubCoarsePointer();
    server.use(
      http.get('/api/v1/cmdb/ci-types/20/relation-parents', () =>
        HttpResponse.json({ items: [], total: 0 }),
      ),
    );
    render(view());
    const card = screen.getByRole('button', { name: '服务' });

    fireEvent.click(card);
    expect(screen.getByRole('button', { name: '服务' })).toHaveAttribute('data-focused', 'true');
    expect(screen.getByTestId('location')).toHaveTextContent('/cmdb/models/10');

    fireEvent.click(screen.getByRole('button', { name: '服务' }));
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/cmdb/models/20?tab=relations'),
    );
  });

  it('clears focus when the pane is clicked', () => {
    server.use(
      http.get('/api/v1/cmdb/ci-types/20/relation-parents', () =>
        HttpResponse.json({ items: [], total: 0 }),
      ),
    );
    render(view());

    fireEvent.mouseEnter(screen.getByTestId('flow-node-20'));
    expect(screen.getByRole('button', { name: '证书' })).toHaveAttribute('data-dimmed', 'true');

    fireEvent.click(screen.getByTestId('flow-canvas'));

    expect(screen.getByRole('button', { name: '证书' })).toHaveAttribute('data-dimmed', 'false');
  });

  it('focuses and probes when the card receives keyboard focus', async () => {
    let requests = 0;
    server.use(
      http.get('/api/v1/cmdb/ci-types/20/relation-parents', () => {
        requests += 1;
        return HttpResponse.json({ items: [], total: 0 });
      }),
    );
    render(view());

    fireEvent.focus(screen.getByRole('button', { name: '服务' }));

    expect(screen.getByRole('button', { name: '证书' })).toHaveAttribute('data-dimmed', 'true');
    await waitFor(() => expect(requests).toBe(1));
  });

  it('wires the toolbar to fit and zoom', async () => {
    const user = userEvent.setup();
    render(view());

    await user.click(screen.getByRole('button', { name: '居中' }));
    expect(flow.fitView).toHaveBeenCalledWith({
      padding: { top: 0.1, right: 0.04, bottom: 1, left: 0.04 },
      duration: 300,
    });

    await user.click(screen.getByRole('button', { name: '放大' }));
    expect(flow.zoomIn).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '缩小' }));
    expect(flow.zoomOut).toHaveBeenCalledTimes(1);
  });

  it('enters and leaves fullscreen with Esc', async () => {
    const user = userEvent.setup();
    render(view());
    const container = screen.getByTestId('topology-container');
    const toggle = screen.getByRole('button', { name: '全屏' });
    expect(container).toHaveAttribute('data-fullscreen', 'false');

    await user.click(toggle);

    expect(container).toHaveAttribute('data-fullscreen', 'true');
    expect(screen.getByRole('button', { name: '关闭全屏' })).toBe(toggle);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(container).toHaveAttribute('data-fullscreen', 'false');
    expect(screen.getByRole('button', { name: '全屏' })).toBe(toggle);
    await waitFor(() => expect(document.activeElement).toBe(toggle));
  });

  it('exports the canvas and shows the busy class while capturing', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    exportPng.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    render(view());
    const container = screen.getByTestId('topology-container');

    await user.click(screen.getByRole('button', { name: '导出图片' }));

    await waitFor(() => expect(container).toHaveClass('is-exporting'));
    await waitFor(() =>
      expect(exportPng).toHaveBeenCalledWith(container, 'cmdb-business_application-relations.png'),
    );

    release();
    await waitFor(() => expect(container).not.toHaveClass('is-exporting'));
  });

  it('toasts when the export fails', async () => {
    const user = userEvent.setup();
    exportPng.mockRejectedValueOnce(new Error('capture failed'));
    render(view());

    await user.click(screen.getByRole('button', { name: '导出图片' }));

    expect(await screen.findByText('capture failed')).toBeInTheDocument();
  });

  it('toggles the minimap', async () => {
    const user = userEvent.setup();
    render(view());
    expect(screen.getByTestId('minimap')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '迷你地图' }));
    expect(screen.queryByTestId('minimap')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '迷你地图' }));
    expect(screen.getByTestId('minimap')).toBeInTheDocument();
  });

  it('does not commit an expansion that started before the center changed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    server.use(
      http.get('/api/v1/cmdb/ci-types/20/relation-parents', async () => {
        calls += 1;
        if (calls === 1) return new HttpResponse(null, { status: 500 });
        await gate;
        return HttpResponse.json({
          items: [relation(700, model(70, 'old', '旧展开'))],
          total: 1,
        });
      }),
    );
    const otherCenter = model(90, 'other_application', '其他模型');
    const { rerender } = render(view());
    const user = userEvent.setup();

    await user.hover(screen.getByTestId('flow-node-20'));
    const retry = await screen.findByRole('button', { name: '展开下级' }, { timeout: 2000 });
    await user.click(retry);
    await waitFor(() => expect(calls).toBe(2));

    rerender(view({ center: otherCenter, parents: [], children: [], groups: [] }));
    release();
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(screen.getByText('其他模型')).toBeInTheDocument();
    expect(screen.queryByText('旧展开')).not.toBeInTheDocument();
  });

  it('keeps a bidirectional relation on the inbound side with facing handles', () => {
    render(
      view({
        parents: [relation(1, parent, 'depend', '#f59e0b')],
        children: [relation(2, parent, 'contain', '#0ea5e9')],
      }),
    );

    expect(screen.getAllByRole('button', { name: '服务' })).toHaveLength(1);
    expect(screen.getByTestId('flow-edge-20-10-1')).toHaveAttribute('data-source-handle', 'source-right');
    expect(screen.getByTestId('flow-edge-20-10-1')).toHaveAttribute('data-target-handle', 'target-left');
    expect(screen.getByTestId('flow-edge-10-20-2')).toHaveAttribute('data-source-handle', 'source-left');
    expect(screen.getByTestId('flow-edge-10-20-2')).toHaveAttribute('data-target-handle', 'target-right');
  });

  it('offsets parallel relations in ctr_id order and caps labels at three', () => {
    const parallel = [5, 2, 9, 1].map((id) => relation(id, child, `relation_${id}`, '#0ea5e9'));
    render(view({ children: parallel }));
    const ordered = ['1', '2', '5', '9'];

    expect(
      ordered.map((id) =>
        screen.getByTestId(`flow-edge-10-30-${id}`).getAttribute('data-offset'),
      ),
    ).toEqual(['-1.5', '-0.5', '0.5', '1.5']);
    expect(
      ordered.map((id) =>
        screen.getByTestId(`flow-edge-10-30-${id}`).getAttribute('data-show-label'),
      ),
    ).toEqual(['true', 'true', 'true', 'false']);
  });

  it('reveals only the focused path labels after the first coarse tap', () => {
    stubCoarsePointer();
    server.use(
      http.get('/api/v1/cmdb/ci-types/20/relation-parents', () =>
        HttpResponse.json({ items: [], total: 0 }),
      ),
    );
    render(view());

    fireEvent.click(screen.getByRole('button', { name: '服务' }));

    expect(screen.getByTestId('flow-edge-20-10-1')).toHaveAttribute('data-show-label', 'true');
    expect(screen.getByTestId('flow-edge-20-10-1')).toHaveAttribute('data-connected', 'true');
    expect(screen.getByTestId('flow-edge-10-30-2')).toHaveAttribute('data-show-label', 'false');
  });
});
