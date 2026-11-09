import { cn } from '@/lib/cn';

import { relationEdgeLabel } from '../lib/relation';

// The chip a relation canvas draws at an edge's midpoint.
//
// THE CARDINALITY SITS ON THE CHIP'S TOP BORDER, not in its text. Keeping it on
// the horizontal line made the chip long enough to hide a short edge's length
// and arrowhead; the relation name stays compact and the 1:N tag rides the top
// border. It is shared by the model-config topology, the resource topology and
// the relation-view canvas so one relation cannot look different in each.

export type RelationEdgeChipProps = {
  name: string;
  /** The compact cardinality label, e.g. `1:N`; absent for unknown codes. */
  cardinality?: string;
  color: string;
  x: number;
  y: number;
  /** Vertical offset for parallel edges. */
  offsetY?: number;
  opacity?: number;
  /** True when this edge belongs to the focused node's direct path. */
  connected?: boolean;
  /** Canvas-specific behaviour, e.g. the model topology's focus / mobile rules. */
  className?: string;
};

export function RelationEdgeChip({
  name,
  cardinality,
  color,
  x,
  y,
  offsetY = 0,
  opacity = 1,
  connected = false,
  className,
}: RelationEdgeChipProps) {
  return (
    <div
      data-edge-label=""
      data-testid="edge-label"
      data-constraint-label={cardinality}
      title={relationEdgeLabel(name, cardinality)}
      className={cn('cmdb-relation-edge-label nodrag nopan', connected && 'is-connected', className)}
      style={{
        position: 'absolute',
        transform: `translate(-50%, -50%) translate(${x}px, ${y}px) translate(0px, ${offsetY}px)`,
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
      <span data-testid="edge-label-name" className="cmdb-relation-edge-name">
        {name}
      </span>
      {cardinality ? (
        <span data-testid="edge-cardinality" className="cmdb-relation-edge-cardinality">
          {cardinality}
        </span>
      ) : null}
    </div>
  );
}
