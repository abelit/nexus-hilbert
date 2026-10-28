import { ArrowRight, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { useI18n } from '@/i18n/locale';

import type { TypeAttribute } from '../api/citype';
import {
  relationAttributeCandidates,
  relationAttributeOptions,
} from '../lib/relation-attributes';

export type AttributePair = { source: string; target: string };

// The optional "these two attributes must agree" mapping on a model relation.
//
// CANTOR'S ROW SHAPE: one source select → one target select, with delete and add
// controls on the row. The candidate list is filtered per side (same value
// type, no secrets/JSON/booleans/references, plus the constraint's list rules),
// so an operator cannot build a mapping the backend could never match.
//
// A pair is positional: source_attr_ids[i] matches target_attr_ids[i]. Empty
// rows are dropped on submit; a half-filled row is an error, not a silent drop.
// The last row cannot be removed, because the section always needs one.

export function RelationAttributePairs({
  sourceAttributes,
  targetAttributes,
  pairs,
  onChange,
  constraint,
  disabled = false,
  loading = false,
  hint,
}: {
  sourceAttributes: TypeAttribute[];
  targetAttributes: TypeAttribute[];
  pairs: AttributePair[];
  onChange(next: AttributePair[]): void;
  constraint: string;
  disabled?: boolean;
  loading?: boolean;
  /** Explains the two sides when the surrounding form does not name them. */
  hint?: string;
}) {
  const { tr } = useI18n();
  const ready = sourceAttributes.length > 0 && targetAttributes.length > 0;

  const update = (index: number, patch: Partial<AttributePair>) => {
    const next = pairs.map((pair, i) => (i === index ? { ...pair, ...patch } : pair));
    const changed = next[index];
    // A newly chosen attribute can invalidate the other side (type, or the
    // constraint's list rule); clear it rather than leave an impossible pair.
    const targets = relationAttributeCandidates(
      targetAttributes,
      changed.source,
      sourceAttributes,
      'target',
      constraint,
    );
    if (changed.target && !targets.some((attribute) => String(attribute.id) === changed.target)) {
      changed.target = '';
    }
    const sources = relationAttributeCandidates(
      sourceAttributes,
      changed.target,
      targetAttributes,
      'source',
      constraint,
    );
    if (changed.source && !sources.some((attribute) => String(attribute.id) === changed.source)) {
      changed.source = '';
    }
    onChange(next);
  };

  const remove = (index: number) => {
    if (pairs.length <= 1) return;
    onChange(pairs.filter((_, i) => i !== index));
  };

  const add = () => {
    onChange([...pairs, { source: '', target: '' }]);
  };

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Label>{tr('属性关联', 'Attribute association')}</Label>
        <p className="mt-1 text-[11px] text-text-faint">
          {hint ??
            tr(
              '可选；用于从属性值推导实例关系。',
              'Optional; used to derive instance relations from values.',
            )}
        </p>
      </div>

      {!ready && (
        <p className="text-[11px] text-text-faint">
          {loading
            ? tr('正在读取属性…', 'Loading attributes…')
            : tr('先选择源和目标 CI 类型。', 'Choose both CI types first.')}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {pairs.map((pair, index) => {
          const sourceOptions = relationAttributeOptions(
            relationAttributeCandidates(
              sourceAttributes,
              pair.target,
              targetAttributes,
              'source',
              constraint,
            ),
          );
          const targetOptions = relationAttributeOptions(
            relationAttributeCandidates(
              targetAttributes,
              pair.source,
              sourceAttributes,
              'target',
              constraint,
            ),
          );
          const partial = Boolean(pair.source) !== Boolean(pair.target);
          return (
            <div key={index} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  aria-label={tr(`源属性 ${index + 1}`, `Source attribute ${index + 1}`)}
                  placeholder={tr('选择源属性', 'Select source attribute')}
                  value={pair.source}
                  onValueChange={(next) => update(index, { source: next })}
                  options={sourceOptions}
                  searchable
                  disabled={disabled || !ready}
                  className="min-w-0 flex-1"
                />
                <ArrowRight
                  size={14}
                  className="shrink-0 text-text-faint"
                  aria-hidden="true"
                />
                <Select
                  aria-label={tr(`目标属性 ${index + 1}`, `Target attribute ${index + 1}`)}
                  placeholder={tr('选择目标属性', 'Select target attribute')}
                  value={pair.target}
                  onValueChange={(next) => update(index, { target: next })}
                  options={targetOptions}
                  searchable
                  disabled={disabled || !ready}
                  className="min-w-0 flex-1"
                />
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    variant="plain"
                    size="sm"
                    type="button"
                    disabled={disabled || pairs.length <= 1}
                    onClick={() => remove(index)}
                    aria-label={tr(`删除第 ${index + 1} 条属性关联`, `Delete attribute association ${index + 1}`)}
                    title={tr('删除属性关联', 'Delete attribute association')}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md p-0 text-text-faint hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </Button>
                  <Button
                    variant="plain"
                    size="sm"
                    type="button"
                    disabled={disabled}
                    onClick={add}
                    aria-label={tr('添加属性关联', 'Add attribute association')}
                    title={tr('添加属性关联', 'Add attribute association')}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md p-0 text-text-faint hover:text-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Plus size={13} aria-hidden="true" />
                  </Button>
                </div>
              </div>
              {partial && (
                <p role="alert" className="text-[11px] text-red-600 dark:text-red-300">
                  {tr(
                    '源属性和目标属性需要同时选择。',
                    'Choose both a source and a target attribute.',
                  )}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
