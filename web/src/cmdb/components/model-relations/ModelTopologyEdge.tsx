import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';

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

  // THE CARDINALITY LIVES IN THE MIDPOINT CHIP. Endpoint badges were tried and
  // rejected: every edge converging on one node handle gets the same anchor, so
  // a 1/N pair from different relations sits on the same pixel and one glyph
  // occludes the other. The chip is the one place the graph already labels a
  // relation, the relation table uses the same 一对多 vocabulary, and it
  // inherits the existing focus / mobile / PNG-export rules.
  const label = [data.label, data.constraintLabel].filter(Boolean).join(' · ');

  return (
    <>
      <g transform={`translate(0, ${offset * 12})`}>
        {label ? <title>{label}</title> : null}
        <BaseEdge
          id={props.id}
          path={path}
          markerEnd={props.markerEnd}
          style={{ ...props.style, stroke: color, opacity }}
        />
      </g>
      {showLabel && label ? (
        <EdgeLabelRenderer>
          <div
            data-edge-label=""
            data-testid="edge-label"
            data-constraint-label={data.constraintLabel}
            className={`cmdb-model-topology-edge-label nodrag nopan${data.connected ? ' is-connected' : ''}`}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) translate(0px, ${offset * 12}px)`,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              border: `1px solid ${color}`,
              borderRadius: 8,
              padding: '1px 5px',
              fontSize: 9.5,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              color,
              background: 'rgb(var(--bg))',
              opacity,
            }}
          >
            {/* The name truncates; the cardinality never does. A long relation
                name must not push the number out of the chip or into a node. */}
            <span className="cmdb-model-topology-edge-name">{data.label}</span>
            {data.constraintLabel ? <span> · {data.constraintLabel}</span> : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
