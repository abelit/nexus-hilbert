import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';

import { RelationEdgeChip } from '../RelationEdgeChip';

// A resource-topology edge: the same bezier line the canvas drew before, plus
// the shared relation chip. The chip carries the relation type and the
// cardinality badge, matching the model-config topology instead of putting the
// cardinality in the edge text.

export type InstanceRelationEdgeData = {
  /** The relation type name. */
  name: string;
  /** Compact cardinality, e.g. `1:N`; absent for an unknown code. */
  cardinality?: string;
  color?: string;
  /** False when the canvas's relation-style toggle is off. */
  showLabel: boolean;
};

const FALLBACK_COLOR = '#94a3b8';

export function InstanceRelationEdge(props: EdgeProps) {
  const data = (props.data ?? {}) as Partial<InstanceRelationEdgeData>;
  const color = data.color ?? FALLBACK_COLOR;
  const showLabel = data.showLabel ?? false;

  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });

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
