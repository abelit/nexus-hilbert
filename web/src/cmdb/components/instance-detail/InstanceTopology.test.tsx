import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/test/msw-server';

import type { CIType, RelatedType, TypeAttribute } from '../../api/citype';
import type { Instance, SearchRow } from '../../api/instance';
import { ToastProvider } from '../Toast';
import { InstanceTopology } from './InstanceTopology';

// THE CANVAS IS REPLACED BY BUTTONS. React Flow measures nodes in a layout
// engine jsdom does not run, so the test drives the same callbacks React Flow
// would with the node objects the component already built.
vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  type FakeNode = {
    id: string;
    data: { unique?: string; ciID?: number; typeID?: number; isRoot?: boolean };
  };
  return {
    ReactFlow: ({
      nodes,
      onNodeClick,
      onNodeDoubleClick,
    }: {
      nodes: FakeNode[];
      onNodeClick?: (event: unknown, node: FakeNode) => void;
      onNodeDoubleClick?: (event: unknown, node: FakeNode) => void;
    }) => (
      <div data-testid="topology-canvas">
        {nodes.map((node) => (
          <span key={node.id}>
            <button type="button" onClick={() => onNodeClick?.({}, node)}>
              {`单击 ${String(node.data.unique ?? node.id)}`}
            </button>
            <button type="button" onClick={() => onNodeDoubleClick?.({}, node)}>
              {`双击 ${String(node.data.unique ?? node.id)}`}
            </button>
          </span>
        ))}
      </div>
    ),
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
    MarkerType: { ArrowClosed: 'arrow-closed' },
    Position: { Left: 'left', Right: 'right' },
    useNodesState: (initial: FakeNode[]) => React.useState(initial),
  };
});

const host: CIType = {
  id: 1,
  name: 'host',
  alias: '主机',
  enabled: true,
  is_attached: true,
  order: 0,
  unique_key: 'hostname',
  parent_ids: [],
};

const rack: CIType = { ...host, id: 3, name: 'rack', alias: '机柜', unique_key: 'name' };

const nameAttribute = (id: number): TypeAttribute =>
  ({
    id,
    name: 'name',
    alias: '名称',
    value_type: '2',
    is_choice: false,
    is_list: false,
    is_password: false,
    is_reference: false,
    is_required: false,
    order: 0,
    default_show: true,
    inherited: false,
  }) as TypeAttribute;

const parentType: RelatedType = {
  ctr_id: 1,
  type: rack,
  show_key: 'name',
  attributes: [nameAttribute(30)],
  relation_type: { id: 1, name: '属于', color: '' },
  constraint: '0',
  parent_attr_ids: [],
  child_attr_ids: [],
};

const rackRow: SearchRow = {
  _id: 20,
  _type: 3,
  ci_id: 20,
  ci_type: 'rack',
  unique: 'name',
  name: 'rack-01',
};

const hostAttributes = [nameAttribute(10)];
const hostInstance: Instance = { ci_id: 5, type_id: 1, values: { name: 'web-01' } };

function renderTopology(onNavigate = vi.fn()) {
  const view = render(
    <ToastProvider>
      <InstanceTopology
        model={host}
        attributes={hostAttributes}
        instance={hostInstance}
        instanceID={5}
        instanceLabel="web-01"
        onNavigate={onNavigate}
      />
    </ToastProvider>,
  );
  return { ...view, onNavigate };
}

function mocks() {
  server.use(
    http.get('/api/v1/cmdb/ci-types/host/relation-parents', () =>
      HttpResponse.json({ items: [parentType], total: 1 }),
    ),
    http.get('/api/v1/cmdb/ci-types/host/relation-children', () =>
      HttpResponse.json({ items: [], total: 0 }),
    ),
    http.get('/api/v1/cmdb/ci-relations/search', ({ request }) => {
      const reverse = new URL(request.url).searchParams.get('reverse') === 'true';
      return HttpResponse.json({
        numfound: reverse ? 1 : 0,
        total: reverse ? 1 : 0,
        page: 1,
        result: reverse ? [rackRow] : [],
      });
    }),
  );
}

beforeEach(() => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
});

describe('the instance topology switch', () => {
  it('reports the model and instance of a double-clicked node', async () => {
    const user = userEvent.setup();
    mocks();
    const { onNavigate } = renderTopology();

    await user.dblClick(await screen.findByRole('button', { name: '双击 rack-01' }));

    expect(onNavigate).toHaveBeenCalledWith({ ciID: 20, typeID: 3 });
  });

  it('offers the same switch from the detail card for keyboard and touch', async () => {
    const user = userEvent.setup();
    mocks();
    const { onNavigate } = renderTopology();

    await user.click(await screen.findByRole('button', { name: '单击 rack-01' }));
    expect(screen.getByText('机柜')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '切换到此资源' }));

    expect(onNavigate).toHaveBeenCalledWith({ ciID: 20, typeID: 3 });
  });

  it('does not offer a switch on the current resource card', async () => {
    const user = userEvent.setup();
    mocks();
    renderTopology();

    await user.click(await screen.findByRole('button', { name: '单击 web-01' }));

    expect(screen.queryByRole('button', { name: '切换到此资源' })).not.toBeInTheDocument();
  });
});
