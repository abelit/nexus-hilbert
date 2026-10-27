import { useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';

import { Select } from '@/components/ui/Select';
import { useI18n } from '@/i18n/locale';

import type { CIType, TypeAttribute } from '../../api/citype';
import { describeError } from '../../api/http';
import { displayValue, isValueTypeCode, type ValueTypeCode } from '../../lib/valuetype';
import { AttributeControl } from '../AttributeControl';
import { ReferencePicker } from '../ReferencePicker';

// One attribute, edited in place.
//
// CANTOR'S RULE, WITHOUT ITS SAVE BUTTON: the pencil replaces the value with
// the control that value type needs, and the row writes itself — a text field
// on blur or Enter, a choice/boolean/reference on selection. Escape abandons the
// draft. There is no confirm step, so the row reads as the value it edits.
//
// WHY BLUR IS SAFE FOR PORTALLED CONTROLS: a choice or reference renders its
// popup in a portal, and picking an option blurs the trigger into that portal.
// Those controls commit from `onChange` instead, and a blur that lands in a
// popup is ignored. Only text-like controls — which own no popup — commit on
// blur.
//
// WHY A SAVE STILL WRITES ONE KEY: the writer is the same `PUT /instances/{id}`
// the form uses, and the usecase normalises only the supplied keys, so one
// field cannot clobber the rest of the instance.

export function AttributeInlineEditor({
  attribute,
  value,
  models,
  labels,
  onSave,
  onDone,
  onCancel,
  onBusyChange,
}: {
  attribute: TypeAttribute;
  value: unknown;
  models: CIType[];
  labels: Map<number, string>;
  onSave(next: unknown): Promise<void>;
  /** The value is saved (or unchanged); the row can close. */
  onDone(): void;
  /** Escape: discard the draft and close without writing. */
  onCancel(): void;
  /** A write is in flight; the caller disables starting another edit. */
  onBusyChange?(busy: boolean): void;
}) {
  const { tr } = useI18n();
  const type = isValueTypeCode(attribute.value_type) ? attribute.value_type : '2';
  const label = attribute.alias || attribute.name;
  const [draft, setDraft] = useState<unknown>(() => initialDraft(attribute, value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const originalRef = useRef<unknown>(initialDraft(attribute, value));

  const referenceModel = attribute.is_reference && attribute.reference_type_id
    ? models.find((candidate) => Number(candidate.id) === Number(attribute.reference_type_id))
    : undefined;
  // Cantor edits a choice as a select of the configured options, not as a box
  // where the operator has to know the stored code.
  const singleChoice = Boolean(attribute.is_choice) && !attribute.is_list;
  // These controls commit from the selection itself; the rest commit on blur.
  const instant = type === '7' || singleChoice || Boolean(referenceModel);
  // A multi-reference keeps accumulating picks; it closes when the operator
  // leaves the row instead of after the first one.
  const keepOpen = Boolean(attribute.is_reference) && attribute.is_list;

  const choiceOptions = useMemo(() => {
    if (!singleChoice) return [];
    const options = (attribute.choice_value ?? []).map((choice) => ({
      value: displayValue(choice.value),
      label:
        typeof choice.option?.label === 'string' && choice.option.label.trim()
          ? choice.option.label.trim()
          : displayValue(choice.value),
    }));
    const current = displayValue(value);
    if (current && !options.some((option) => option.value === current)) {
      options.unshift({ value: current, label: current });
    }
    return [{ value: '', label: tr('未设置', 'Not set') }, ...options];
  }, [attribute.choice_value, singleChoice, tr, value]);

  // Opening the row is the operator's click; move the caret to the control so
  // the value can be replaced by typing, not by clicking a second time.
  useEffect(() => {
    rootRef.current
      ?.querySelector<HTMLElement>('input, textarea, [role="combobox"], button')
      ?.focus();
  }, []);

  const commit = async (nextValue?: unknown) => {
    if (saving) return;
    let next = nextValue === undefined ? draft : nextValue;
    if (type === '6') {
      const text = typeof next === 'string' ? next.trim() : '';
      if (!text) {
        next = null;
      } else {
        try {
          next = JSON.parse(text);
        } catch {
          setError(tr('JSON 格式无效', 'This is not valid JSON.'));
          return;
        }
      }
    } else if (singleChoice) {
      next = next === '' || next === null || next === undefined ? null : next;
    }
    setError(null);
    // An unchanged value needs no write; leaving the field still closes it.
    if (sameValue(next, wireValue(originalRef.current, type))) {
      onDone();
      return;
    }
    setSaving(true);
    onBusyChange?.(true);
    try {
      await onSave(next);
      if (!keepOpen) onDone();
    } catch (cause) {
      setError(describeError(cause, tr('保存失败', 'Could not save')));
    } finally {
      setSaving(false);
      onBusyChange?.(false);
    }
  };

  const choose = (next: unknown) => {
    setDraft(next);
    void commit(next);
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (saving) return;
    const related = event.relatedTarget;
    if (related instanceof Node && rootRef.current?.contains(related)) return;
    // Focus moving into an option popup is a choice in progress, not a leave.
    if (related instanceof Element && related.closest('.og-select-popup, .og-select-positioner')) return;
    if (instant) {
      onCancel();
      return;
    }
    void commit();
  };

  const editor = referenceModel ? (
    <ReferencePicker
      id={`cmdb-inline-${attribute.id}`}
      attribute={attribute}
      target={referenceModel}
      labels={labels}
      value={draft}
      onChange={choose}
      disabled={saving}
      placeholder={label}
    />
  ) : attribute.is_reference ? (
    <p className="text-[11px] text-red-500 dark:text-red-300">
      {tr('找不到引用的模型，暂时无法编辑。', 'The referenced model is unavailable, so this value cannot be edited.')}
    </p>
  ) : singleChoice ? (
    <Select
      value={displayValue(draft)}
      onValueChange={choose}
      options={choiceOptions}
      aria-label={label}
      disabled={saving}
      className="w-full"
    />
  ) : (
    <AttributeControl
      id={`cmdb-inline-${attribute.id}`}
      type={type}
      isList={attribute.is_list}
      value={draft}
      onChange={setDraft}
      disabled={saving}
      placeholder={label}
      aria-label={label}
      className="w-full"
    />
  );

  return (
    <div
      ref={rootRef}
      className="flex min-w-0 flex-col gap-1"
      onBlur={handleBlur}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
          return;
        }
        if (
          event.key === 'Enter' &&
          !instant &&
          !event.shiftKey &&
          event.target instanceof HTMLInputElement
        ) {
          event.preventDefault();
          void commit();
        }
      }}
    >
      {editor}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        {saving && (
          <span className="text-[10px] text-text-faint" role="status">
            {tr('保存中…', 'Saving…')}
          </span>
        )}
        {!saving && !error && (
          <span className="text-[10px] text-text-faint">
            {instant
              ? tr('选择后立即保存 · Esc 放弃', 'Saves on selection · Esc cancels')
              : tr('离开字段即保存 · Esc 放弃', 'Saves when you leave the field · Esc cancels')}
          </span>
        )}
        {error && (
          <span role="alert" className="min-w-0 text-[11px] text-red-600 dark:text-red-300">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The stored value in the shape its control edits.
 *
 * JSON is text in the editor and an object on the wire; a reference is an id or
 * a list of ids; everything else is handed over as stored and the shared
 * `AttributeControl` converts it (`toControlValue`).
 */
function initialDraft(attribute: TypeAttribute, value: unknown): unknown {
  if (attribute.value_type === '6') {
    if (value === null || value === undefined || value === '') return '';
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }
  if (attribute.is_reference) {
    if (Array.isArray(value)) return [...value];
    return value === undefined ? null : value;
  }
  return value ?? '';
}

/** The comparable form of a stored value for the "nothing changed" check. */
function wireValue(value: unknown, type: ValueTypeCode): unknown {
  if (type === '6') {
    if (value === null || value === undefined || value === '') return null;
    return typeof value === 'string' ? value : JSON.parse(JSON.stringify(value));
  }
  return value === undefined ? null : value;
}

function sameValue(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  } catch {
    return left === right;
  }
}
