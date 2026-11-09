import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';

import { relationEdgeLabel } from '../../lib/relation';
import { RelationEdgeChip } from '../RelationEdgeChip';

// A labelled cubic edge. The line stays soft on purpose: the graph's job is the
// relation shape, and a right-angled path would add corners the data does not
// have. Parallel relations shift the whole edge by twelve pixels per index so
// two "contain" edges between the same pair do not sit on top of each other.

export type ModelEdgePaintData = {
  label: string;
  color: string;
  dimmed: boolean;
  showLabel: boolean;
  offset: number;
  /** Localized cardinality label, e.g. 一对多. Unknown codes leave it empty. */
  constraintLabel?: string;
  /** True when this edge belongs to the focused node's direct path. */
  connected?: boolean;
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

  // THE CHIP IS SHARED with the resource topology and the relation view; the
  // cardinality rides its top border. The model-only class keeps this canvas's
  // focus / mobile / PNG rules without imposing them on the other two.
  const title = relationEdgeLabel(data.label ?? '', data.constraintLabel);

  return (
    <>
      <g transform={`translate(0, ${offset * 12})`}>
        {title ? <title>{title}</title> : null}
        <BaseEdge
          id={props.id}
          path={path}
          markerEnd={props.markerEnd}
          style={{ ...props.style, stroke: color, opacity }}
        />
      </g>
      {showLabel && data.label ? (
        <EdgeLabelRenderer>
          <RelationEdgeChip
            name={data.label}
            cardinality={data.constraintLabel}
            color={color}
            x={labelX}
            y={labelY}
            offsetY={offset * 12}
            opacity={opacity}
            connected={data.connected}
            className="cmdb-model-topology-edge-label"
          />
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
