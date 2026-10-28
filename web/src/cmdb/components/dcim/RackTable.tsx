import { useMemo, useState } from 'react';
import { Eye } from 'lucide-react';

import { Button } from '@/components/ui';
import { Chip } from '@/components/ui/Chip';
import { PaginationFooter } from '@/components/ui/PaginationFooter';
import { useI18n } from '@/i18n/locale';

import type { CIType, TypeAttribute } from '../../api/citype';
import {
  attributeDisplay,
  attributeLabel,
  type RackRow,
} from '../../lib/dcim';
import { referenceText, useReferenceLabels } from '../../lib/reference-labels';
import { DataTable, type Column, type SortState } from '../DataTable';

export function RackTable({
  racks,
  fields,
  models,
  loading,
  error,
  onRetry,
  onOpen,
  selection,
  onSelectionChange,
  page,
  pageSize,
  onPageChange,
  hasRacks,
  onClearFilters,
}: {
  /** The whole filtered set; this component sorts it before paging. */
  racks: RackRow[];
  fields: TypeAttribute[];
  models: CIType[];
  loading: boolean;
  error: string | null;
  onRetry(): void;
  onOpen(rack: RackRow): void;
  selection: ReadonlySet<string | number>;
  onSelectionChange(next: ReadonlySet<string | number>): void;
  page: number;
  pageSize: number;
  onPageChange(page: number): void;
  hasRacks: boolean;
  onClearFilters?(): void;
}) {
  const { tr } = useI18n();
  // Rack attributes are flat rows; the label resolver wants the nested shape
  // the instance page uses, so adapt without copying the values.
  const referenceLabels = useReferenceLabels(
    racks.map((rack) => ({ values: rack.row })),
    fields,
    models,
  );
  // These three are already on the row: the name cell carries the height and
  // used units, and the usage cell carries the ratio and the conflict badge.
  // Repeating them as subscribed columns spends the width the action column
  // needs without adding a fact.
  const visibleFields = useMemo(
    () =>
      fields.filter(
        (attribute) => !['u_count', 'free_u_count', 'u_start', 'u_slot_abnormal'].includes(attribute.name),
      ),
    [fields],
  );

  const columns = useMemo<Column<RackRow>[]>(() => [
    {
      key: 'name',
      header: tr('机柜', 'Rack'),
      width: 'w-full max-sm:w-auto',
      sortable: true,
      sortValue: (rack) => rack.name,
      cell: (rack) => (
        <span className="block min-w-0">
          <span className="block truncate text-xs font-medium text-text" title={rack.name}>
            {rack.name}
          </span>
          <span className="mt-0.5 block text-[10px] text-text-faint">
            {rack.uCount}U · {rack.usedUCount}U {tr('已用', 'used')}
          </span>
        </span>
      ),
    },
    {
      key: 'usage',
      header: tr('使用率', 'Used'),
      sortable: true,
      sortValue: (rack) => rack.usedRatio,
      cell: (rack) => (
        <span className="flex min-w-32 items-center gap-2">
          <span className="h-1.5 w-20 overflow-hidden rounded-full bg-border">
            <span
              className="block h-full rounded-full bg-indigo-500"
              style={{ width: `${Math.min(100, Math.max(0, rack.usedRatio))}%` }}
            />
          </span>
          <span className={rack.usedRatio > 100 ? 'whitespace-nowrap text-[11px] tabular-nums text-red-400' : 'whitespace-nowrap text-[11px] tabular-nums text-text-muted'}>
            {rack.usedRatio}%
          </span>
          {rack.abnormal && <Chip tone="danger" dense>{tr('异常', 'Conflict')}</Chip>}
        </span>
      ),
    },
    ...visibleFields.map((attribute, index): Column<RackRow> => ({
      key: `attr-${attribute.id}`,
      header: attributeLabel(attribute),
      sortable: true,
      // Keep the identity, the capacity and the actions visible first. The
      // subscription still decides what the wider table shows.
      hideBelow: index >= 2 ? 1536 : index >= 1 ? 1400 : undefined,
      sortValue: (rack) => attributeDisplay(attribute, rack.row[attribute.name]),
      cell: (rack) => {
        const value = rack.row[attribute.name];
        const label = attribute.is_reference ? referenceText(value, referenceLabels) : undefined;
        return (
          <span className="block max-w-48 truncate text-xs text-text-muted" title={label ?? attributeDisplay(attribute, value)}>
            {label ?? attributeDisplay(attribute, value)}
          </span>
        );
      },
    })),
  ], [referenceLabels, tr, visibleFields]);

  // SORT THE WHOLE SET, THEN PAGE. Sorting the page an operator is holding
  // would put the largest rack on page 7 wherever it happened to land.
  const [sort, setSort] = useState<SortState | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return racks;
    const column = columns.find((candidate) => candidate.key === sort.key);
    if (!column?.sortValue) return racks;
    const direction = sort.desc ? -1 : 1;
    return [...racks].sort((left, right) => {
      const a = column.sortValue!(left);
      const b = column.sortValue!(right);
      if (a < b) return -direction;
      if (a > b) return direction;
      return 0;
    });
  }, [columns, racks, sort]);
  const pageRows = sorted.slice(page * pageSize, page * pageSize + pageSize);

  return (
    <>
      <DataTable
        columns={columns}
        rows={pageRows}
        rowKey={(rack) => rack.id}
        loading={loading}
        error={error}
        onRetry={onRetry}
        sort={sort}
        onSortChange={(next) => {
          setSort(next);
          onPageChange(0);
        }}
        storageKey="dcim-racks-table"
        empty={
          hasRacks ? (
            <span className="inline-flex flex-wrap items-center justify-center gap-2">
              {tr('没有匹配的机柜', 'No matching racks')}
              {onClearFilters && (
                <Button variant="outline" size="sm" type="button" onClick={onClearFilters}>
                  {tr('清除全部筛选', 'Clear all filters')}
                </Button>
              )}
            </span>
          ) : (
            tr('这个机房还没有机柜', 'This room has no racks yet')
          )
        }
        selection={{ selected: selection, onChange: onSelectionChange }}
        onRowClick={onOpen}
        actions={(rack) => (
          <Button
            variant="plain"
            size="sm"
            type="button"
            onClick={() => onOpen(rack)}
            aria-label={tr(`查看 ${rack.name}`, `View ${rack.name}`)}
            title={tr('查看详情', 'View details')}
            className="inline-flex size-7 items-center justify-center p-0 text-text-faint hover:text-text"
          >
            <Eye size={12} aria-hidden="true" />
          </Button>
        )}
      />
      <PaginationFooter
        page={page}
        pageSize={pageSize}
        shown={pageRows.length}
        total={racks.length}
        onPageChange={onPageChange}
        sticky={false}
        className="mt-3 bg-transparent"
      />
    </>
  );
}
