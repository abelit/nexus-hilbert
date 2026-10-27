import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { useI18n } from '@/i18n/locale';

import type { TypeAttribute } from '../api/citype';

export type AttributePair = { parent: string; child: string };

// The optional "these two attributes must agree" mapping on a model relation.
//
// THE BACKEND ALREADY STORES parent_attr_ids/child_attr_ids and uses them when
// it derives instance relations from attribute values. The port's relation form
// did not expose the fields, so the mapping existed in the schema and in
// imported cantor data but could not be created from the console.
//
// A pair is positional: parent_attr_ids[i] matches child_attr_ids[i]. Empty
// rows are dropped on submit, so an operator can add a row and fill it later.

export function RelationAttributePairs({
  parentAttributes,
  childAttributes,
  pairs,
  onChange,
  disabled = false,
}: {
  parentAttributes: TypeAttribute[];
  childAttributes: TypeAttribute[];
  pairs: AttributePair[];
  onChange(next: AttributePair[]): void;
  disabled?: boolean;
}) {
  const { tr } = useI18n();
  const parentOptions = parentAttributes.map((attribute) => ({
    value: String(attribute.id),
    label: `${attribute.alias || attribute.name}（${attribute.name}）`,
  }));
  const childOptions = childAttributes.map((attribute) => ({
    value: String(attribute.id),
    label: `${attribute.alias || attribute.name}（${attribute.name}）`,
  }));

  const update = (index: number, patch: Partial<AttributePair>) => {
    onChange(pairs.map((pair, i) => (i === index ? { ...pair, ...patch } : pair)));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Label>{tr('属性映射（可选）', 'Attribute mapping (optional)')}</Label>
          <p className="mt-1 text-[11px] text-text-faint">
            {tr(
              '建立“父属性 → 子属性”的对应关系，用来从属性值推导实例关系。',
              'Map a parent attribute to a child attribute; the backend uses it to derive instance relations from values.',
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          type="button"
          disabled={disabled || parentAttributes.length === 0 || childAttributes.length === 0}
          onClick={() => onChange([...pairs, { parent: '', child: '' }])}
          className="inline-flex items-center gap-1.5"
        >
          <Plus size={12} aria-hidden="true" />
          {tr('添加映射', 'Add mapping')}
        </Button>
      </div>

      {pairs.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-3 text-center text-[11px] text-text-faint">
          {tr('没有属性映射；关系仍可创建。', 'No attribute mapping; the relation can still be created.')}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {pairs.map((pair, index) => (
            <div key={index} className="grid grid-cols-1 gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_1fr_auto]">
              <div>
                <Label htmlFor={`cmdb-pair-parent-${index}`}>{tr('父属性', 'Parent attribute')}</Label>
                <Select
                  id={`cmdb-pair-parent-${index}`}
                  label={tr('父属性', 'Parent attribute')}
                  value={pair.parent}
                  onValueChange={(next) => update(index, { parent: next })}
                  options={parentOptions}
                  searchable
                  disabled={disabled}
                  className="mt-1 w-full"
                />
              </div>
              <div>
                <Label htmlFor={`cmdb-pair-child-${index}`}>{tr('子属性', 'Child attribute')}</Label>
                <Select
                  id={`cmdb-pair-child-${index}`}
                  label={tr('子属性', 'Child attribute')}
                  value={pair.child}
                  onValueChange={(next) => update(index, { child: next })}
                  options={childOptions}
                  searchable
                  disabled={disabled}
                  className="mt-1 w-full"
                />
              </div>
              <Button
                variant="dangerGhost"
                size="sm"
                type="button"
                className="mt-5"
                disabled={disabled}
                onClick={() => onChange(pairs.filter((_, i) => i !== index))}
                aria-label={tr(`删除第 ${index + 1} 条属性映射`, `Delete attribute mapping ${index + 1}`)}
              >
                <Trash2 size={12} aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
