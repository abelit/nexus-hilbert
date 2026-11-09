import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RelationEdgeChip } from './RelationEdgeChip';

describe('RelationEdgeChip', () => {
  it('draws the relation name and puts the cardinality on the top border', () => {
    render(<RelationEdgeChip name="包含" cardinality="1:N" color="#0ea5e9" x={50} y={20} />);

    const label = screen.getByTestId('edge-label');
    expect(label).toHaveAttribute('data-edge-label');
    expect(label).toHaveAttribute('data-constraint-label', '1:N');
    expect(screen.getByTestId('edge-label-name')).toHaveTextContent('包含');
    expect(screen.queryByText('包含 · 1:N')).not.toBeInTheDocument();

    const cardinality = screen.getByTestId('edge-cardinality');
    expect(cardinality).toHaveTextContent('1:N');
    expect(cardinality.className).toContain('cmdb-relation-edge-cardinality');
    // It must ride the chip, not sit in the label text or on the edge line.
    expect(cardinality.closest('[data-edge-label]')).toBe(label);
    expect(label).toHaveStyle({ color: '#0ea5e9', borderColor: '#0ea5e9' });
    expect(label.style.background).toBe('rgb(var(--bg))');
    expect(label.style.transform).toContain('translate(50px, 20px)');
  });

  it('exposes the full relation and cardinality as a tooltip', () => {
    render(<RelationEdgeChip name="包含" cardinality="1:N" color="#0ea5e9" x={0} y={0} />);

    expect(screen.getByTestId('edge-label')).toHaveAttribute('title', '包含 · 1:N');
  });

  it('keeps the name alone when the constraint is unknown', () => {
    render(<RelationEdgeChip name="包含" color="#0ea5e9" x={0} y={0} />);

    expect(screen.queryByTestId('edge-cardinality')).not.toBeInTheDocument();
    expect(screen.getByTestId('edge-label')).not.toHaveAttribute('data-constraint-label');
    expect(screen.getByTestId('edge-label')).toHaveAttribute('title', '包含');
  });

  it('dims and marks the focused path', () => {
    render(<RelationEdgeChip name="包含" color="#0ea5e9" x={0} y={0} opacity={0.18} connected />);

    const label = screen.getByTestId('edge-label');
    expect(label).toHaveStyle({ opacity: '0.18' });
    expect(label.className).toContain('is-connected');
  });

  it('offsets a parallel edge label vertically', () => {
    render(<RelationEdgeChip name="包含" color="#0ea5e9" x={10} y={20} offsetY={24} />);

    expect(screen.getByTestId('edge-label').style.transform).toContain('translate(0px, 24px)');
  });
});
