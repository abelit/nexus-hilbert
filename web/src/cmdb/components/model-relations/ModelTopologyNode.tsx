import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Loader2 } from 'lucide-react';

import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import { CMDBIcon } from '../CMDBIcon';
import { CENTER_COLOR, CENTER_SIZE, NODE_SIZE, type BadgeState, type ModelNode } from './model-topology';

// One model, drawn as a glass card. The card is deliberately visual-only: the
// canvas owns the graph state, focus and expansion, so this component can be
// tested without React Flow and reused by the full-screen overlay.

export type ModelNodeCardData = {
  node: ModelNode;
  isCenter: boolean;
  badge: BadgeState;
  dimmed: boolean;
  focused: boolean;
};

export type ModelTopologyNodePayload = ModelNodeCardData & {
  onOpen(id: number): void;
  onToggle(id: number): void;
  onFocusNode(id: number): void;
  onBlurNode(id: number): void;
};

export function ModelNodeCard({
  data,
  onOpen,
  onToggle,
  onFocus,
  onBlur,
}: {
  data: ModelNodeCardData;
  onOpen(): void;
  onToggle(): void;
  onFocus?(): void;
  onBlur?(): void;
}) {
  const { tr } = useI18n();
  const { node, isCenter, badge, dimmed, focused } = data;
  const color = isCenter ? CENTER_COLOR : node.groupColor;
  const width = isCenter ? CENTER_SIZE.width : NODE_SIZE.width;
  const height = isCenter ? CENTER_SIZE.height : NODE_SIZE.height;

  const badgeLabel =
    badge.kind === 'count'
      ? tr(`展开 ${badge.count} 个下级`, `Expand ${badge.count} sub-models`)
      : badge.kind === 'expanded'
        ? tr('收起下级', 'Collapse sub-models')
        : badge.kind === 'loading'
          ? tr('正在加载下级', 'Loading sub-models')
          : badge.kind === 'retry'
            ? tr('展开下级', 'Expand sub-models')
            : '';

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={node.alias}
      data-center={isCenter ? 'true' : undefined}
      data-dimmed={dimmed ? 'true' : 'false'}
      data-focused={focused ? 'true' : 'false'}
      className={cn(
        'cmdb-model-topology-node relative flex min-w-0 items-center gap-2.5 rounded-xl border px-3 text-left transition-opacity duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500',
        isCenter && 'is-center',
        dimmed && 'is-dimmed',
        focused && 'is-focused',
      )}
      style={{
        width,
        height,
        opacity: dimmed ? 0.18 : 1,
        borderColor: color,
      }}
      onClick={onOpen}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={(event) => {
        // The badge is a real button and handles its own activation; a key
        // pressed there must not bubble into "open the model".
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-2 left-0 w-[3px] rounded-r"
        style={{ backgroundColor: color }}
      />
      <span
        className="flex shrink-0 items-center justify-center rounded-lg"
        style={{
          width: isCenter ? 32 : 28,
          height: isCenter ? 32 : 28,
          backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
          color,
        }}
      >
        <CMDBIcon value={node.icon} size={isCenter ? 20 : 17} label={node.alias} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="block truncate font-semibold text-text"
          style={{ fontSize: isCenter ? 13 : 12 }}
          title={node.alias}
        >
          {node.alias}
        </span>
        <span
          className="block truncate font-mono text-text-faint"
          style={{ fontSize: 9.5 }}
          title={node.name}
        >
          {node.name}
        </span>
      </span>
      {badge.kind !== 'none' && (
        <button
          type="button"
          aria-label={badgeLabel}
          title={badgeLabel}
          disabled={badge.kind === 'loading'}
          className="nodrag nopan absolute right-1.5 top-1.5 z-10 inline-flex items-center justify-center rounded-full text-white shadow-sm disabled:cursor-wait"
          style={{
            width: 18,
            height: 18,
            fontSize: 10,
            backgroundColor: badge.kind === 'loading' ? 'var(--text-faint)' : color,
          }}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        >
          {badge.kind === 'count' ? (
            `+${badge.count}`
          ) : badge.kind === 'expanded' ? (
            '−'
          ) : badge.kind === 'loading' ? (
            <Loader2 size={10} className="animate-spin" aria-hidden="true" />
          ) : (
            '+'
          )}
        </button>
      )}
    </div>
  );
}

const hiddenHandle = {
  opacity: 0,
  width: 1,
  height: 1,
  border: 'none',
  background: 'transparent',
} as const;

export function ModelTopologyNodeView({ data }: NodeProps<Node<ModelTopologyNodePayload>>) {
  return (
    <>
      {/* React Flow only draws an edge when both endpoints expose a handle.
          All four sides exist so a reverse edge can leave and enter the
          facing sides instead of wrapping around the card. */}
      <Handle type="target" position={Position.Left} id="target-left" style={hiddenHandle} />
      <Handle type="target" position={Position.Right} id="target-right" style={hiddenHandle} />
      <Handle type="source" position={Position.Left} id="source-left" style={hiddenHandle} />
      <Handle type="source" position={Position.Right} id="source-right" style={hiddenHandle} />
      <ModelNodeCard
        data={data}
        onOpen={() => data.onOpen(data.node.id)}
        onToggle={() => data.onToggle(data.node.id)}
        onFocus={() => data.onFocusNode(data.node.id)}
        onBlur={() => data.onBlurNode(data.node.id)}
      />
    </>
  );
}
