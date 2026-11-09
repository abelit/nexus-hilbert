import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSimpleBezierPath,
  getSmoothStepPath,
  getStraightPath,
  type EdgeProps,
} from '@xyflow/react';

import { RelationEdgeChip } from '../RelationEdgeChip';

// A relation-view edge. The layout picks the path shape; the label is the same
// shared chip the model-config topology uses, so the cardinality shows on the
// chip's top border here too.

export type RelationGraphEdgeData = {
  /** The relation type name. */
  name: string;
  /** Compact cardinality, e.g. `1:N`; absent for an unknown code. */
  cardinality?: string;
  color?: string;
  showLabel: boolean;
  pathType: 'smoothstep' | 'straight' | 'simplebezier' | 'bezier';
};

const FALLBACK_COLOR = '#94a3b8';

export function RelationGraphEdge(props: EdgeProps) {
  const data = (props.data ?? {}) as Partial<RelationGraphEdgeData>;
  const color = data.color ?? FALLBACK_COLOR;
  const showLabel = data.showLabel ?? false;
  const ends = {
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  };

  let path: string;
  let labelX: number;
  let labelY: number;
  switch (data.pathType) {
    case 'straight':
      [path, labelX, labelY] = getStraightPath(ends);
      break;
    case 'simplebezier':
      [path, labelX, labelY] = getSimpleBezierPath(ends);
      break;
    case 'smoothstep':
      [path, labelX, labelY] = getSmoothStepPath(ends);
      break;
    default:
      [path, labelX, labelY] = getBezierPath(ends);
  }

  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} />
      {showLabel && data.name ? (
        <EdgeLabelRenderer>
          <RelationEdgeChip
            name={data.name}
            cardinality={data.cardinality}
            color={color}
            x={labelX}
            y={labelY}
          />
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
