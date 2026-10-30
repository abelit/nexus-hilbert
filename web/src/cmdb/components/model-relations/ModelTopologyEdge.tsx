import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';

// A labelled cubic edge. The line stays soft on purpose: the graph's job is the
// relation shape, and a right-angled path would add corners the data does not
// have. Parallel relations shift the whole edge by ten pixels per index so two
// "contain" edges between the same pair do not sit on top of each other.

export type ModelEdgePaintData = {
  label: string;
  color: string;
  dimmed: boolean;
  showLabel: boolean;
  offset: number;
};

const FALLBACK_COLOR = '#94a3b8';

export function ModelTopologyEdge(props: EdgeProps) {
  const data = (props.data ?? {}) as Partial<ModelEdgePaintData>;
  const color = data.color ?? FALLBACK_COLOR;
  const dimmed = data.dimmed ?? false;
  const showLabel = data.showLabel ?? false;
  const offset = data.offset ?? 0;
  const opacity = dimmed ? 0.18 : 1;

  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    curvature: 0.35,
  });

  return (
    <>
      <g transform={`translate(0, ${offset * 10})`}>
        <BaseEdge
          id={props.id}
          path={path}
          markerEnd={props.markerEnd}
          style={{ ...props.style, stroke: color, opacity }}
        />
      </g>
      {showLabel && data.label ? (
        <EdgeLabelRenderer>
          <div
            data-edge-label=""
            className="cmdb-model-topology-edge-label nodrag nopan"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) translate(0px, ${offset * 10}px)`,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              border: `1px solid ${color}`,
              borderRadius: 8,
              padding: '1px 5px',
              fontSize: 9.5,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              color,
              background: 'var(--bg-primary)',
              opacity,
            }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
