import { useEffect, useId, useMemo, useState } from 'react';
import { CheckCircle2, Copy, Filter, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui';
import { Input } from '@/components/ui/Input';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/Popover';
import { Select } from '@/components/ui/Select';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';

import type { CIType, TypeAttribute } from '../api/citype';
import type { ReferenceLabels } from '../lib/reference-labels';
import {
  ADVANCED_OPERATORS,
  buildClause,
  joinClauses,
  operatorNeedsValue,
  parseClause,
  parseConnectors,
  type Clause,
  type CompareOp,
  type Operator,
} from '../lib/dsl';
import { COMPARE_OPS } from '../lib/dsl';
import { ReferencePicker } from './ReferencePicker';

// 条件过滤 — the compact rule builder for one model's resource list.
//
// THE EXPRESSION IS THE SOURCE OF TRUTH. Opening the popover decodes the applied
// `q` back into rows, which keeps the builder, the visible expression and what
// the server receives from drifting apart. The port already has the query
// language in lib/dsl; this component only chooses which operators make sense
// for each attribute and renders the value control.
//
// THE CONNECTOR IS 与/或, as in cantor. Negation belongs to the operator
// (不等于 / 为空 / 范围外), so the builder never has to teach the operator a
// second vocabulary for `~` and `-~`.

const EMPTY_LABELS: ReferenceLabels = new Map();

type Connector = 'and' | 'or';

type Rule = {
  id: number;
  connector: Connector;
  clause: Clause | null;
};

const CONNECTOR_LABELS: Record<Connector, [string, string]> = {
  and: ['与', 'And'],
  or: ['或', 'Or'],
};

const OPERATOR_LABELS: Record<Operator, [string, string]> = {
  is: ['等于', 'Equals'],
  notIs: ['不等于', 'Does not equal'],
  contain: ['包含', 'Contains'],
  notContain: ['不包含', "Doesn't contain"],
  startsWith: ['开头是', 'Starts with'],
  notStartsWith: ['开头不是', "Doesn't start with"],
  endsWith: ['结尾是', 'Ends with'],
  notEndsWith: ['结尾不是', "Doesn't end with"],
  hasNoValue: ['为空', 'Is empty'],
  hasValue: ['不为空', 'Is not empty'],
  in: ['in 查询', 'In'],
  notIn: ['非 in 查询', 'Not in'],
  range: ['范围', 'Range'],
  notRange: ['范围外', 'Outside range'],
  compare: ['比较', 'Compare'],
};

const TEXT_OPERATORS: Operator[] = [
  'is',
  'notIs',
  'contain',
  'notContain',
  'startsWith',
  'notStartsWith',
  'endsWith',
  'notEndsWith',
  'hasNoValue',
  'hasValue',
  ...ADVANCED_OPERATORS,
];

const COMPACT_OPERATORS: Operator[] = [
  'is',
  'notIs',
  'hasNoValue',
  'hasValue',
  ...ADVANCED_OPERATORS,
];

let ruleSeq = 1;
const nextRuleID = () => ruleSeq++;

function newRule(attribute?: TypeAttribute): Rule {
  return {
    id: nextRuleID(),
    connector: 'and',
    clause: attribute ? { ref: attribute.name, operator: 'is' } : null,
  };
}

/** The attribute's value is numeric/date/reference-shaped, so text pattern
 *  operators (contains, starts with) would never match the stored value. */
function compactOperators(attribute: TypeAttribute): boolean {
  return (
    attribute.is_reference ||
    attribute.is_bool ||
    attribute.is_choice ||
    ['0', '1', '3', '4', '5', '7'].includes(attribute.value_type)
  );
}

function operatorsFor(attribute?: TypeAttribute): Operator[] {
  if (!attribute) return TEXT_OPERATORS;
  return compactOperators(attribute) ? COMPACT_OPERATORS : TEXT_OPERATORS;
}

function negated(operator: Operator): Operator | null {
  switch (operator) {
    case 'is':
      return 'notIs';
    case 'notIs':
      return 'is';
    case 'contain':
      return 'notContain';
    case 'notContain':
      return 'contain';
    case 'startsWith':
      return 'notStartsWith';
    case 'notStartsWith':
      return 'startsWith';
    case 'endsWith':
      return 'notEndsWith';
    case 'notEndsWith':
      return 'endsWith';
    case 'hasValue':
      return 'hasNoValue';
    case 'hasNoValue':
      return 'hasValue';
    case 'in':
      return 'notIn';
    case 'notIn':
      return 'in';
    case 'range':
      return 'notRange';
    case 'notRange':
      return 'range';
    default:
      return null;
  }
}

/**
 * Decodes the applied expression into rows.
 *
 * `~attr:value` is how the builder writes 不等于, but the language also reads it
 * as the AND-NOT connector. The two are the same predicate, so the row is
 * normalised to the connector the menu offers (与/或) and the negated operator.
 */
function rowsFromExpression(expression: string): Rule[] {
  if (!expression.trim()) return [];
  return parseConnectors(expression).flatMap((entry) => {
    const parsed = parseClause(entry.clause);
    if (!parsed) return [];
    const connector: Connector = entry.connector === 'or' || entry.connector === 'orNot' ? 'or' : 'and';
    let operator = parsed.operator;
    if (entry.connector === 'andNot' || entry.connector === 'orNot') {
      const opposite = negated(operator);
      if (!opposite) return [];
      operator = opposite;
    }
    return [{ id: nextRuleID(), connector, clause: { ...parsed, operator } }];
  });
}

function buildExpression(rules: Rule[]): { expression: string; invalid: boolean } {
  let invalid = false;
  const parts: Array<{ connector: 'and' | 'or'; clause: string }> = [];
  for (const rule of rules) {
    if (!rule.clause) {
      invalid = true;
      continue;
    }
    try {
      parts.push({ connector: rule.connector, clause: buildClause(rule.clause) });
    } catch {
      invalid = true;
    }
  }
  return { expression: joinClauses(parts), invalid };
}

function inputTypeFor(attribute?: TypeAttribute): 'text' | 'number' | 'date' | 'datetime-local' {
  if (!attribute) return 'text';
  if (attribute.value_type === '0' || attribute.value_type === '1') return 'number';
  if (attribute.value_type === '4') return 'date';
  if (attribute.value_type === '3') return 'datetime-local';
  return 'text';
}

function choiceOptions(attribute: TypeAttribute): Array<{ value: string; label: string }> {
  return (attribute.choice_value ?? []).map((choice) => {
    const label = choice.option?.label;
    return {
      value: String(choice.value),
      label: typeof label === 'string' && label.trim() ? label.trim() : String(choice.value),
    };
  });
}

export function ConditionFilter({
  attributes,
  models,
  value,
  onApply,
}: {
  attributes: TypeAttribute[];
  models: CIType[];
  /** The applied expression, without the `_type` term. */
  value: string;
  onApply(next: string): void;
}) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<Rule[]>([]);

  const searchable = useMemo(
    () =>
      attributes.filter(
        (attribute) =>
          !attribute.is_password &&
          !attribute.is_file &&
          !attribute.is_link &&
          attribute.value_type !== '6',
      ),
    [attributes],
  );

  const attributeByName = useMemo(
    () => new Map(searchable.map((attribute) => [attribute.name, attribute])),
    [searchable],
  );

  useEffect(() => {
    if (open) {
      const parsed = rowsFromExpression(value);
      setRules(parsed.length > 0 ? parsed : [newRule(searchable[0])]);
    }
    // Only reopening decodes the applied expression; editing rows must not be
    // overwritten while the popover is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const appliedCount = useMemo(() => (value.trim() ? parseConnectors(value).length : 0), [value]);
  const draft = useMemo(() => buildExpression(rules), [rules]);

  const update = (id: number, patch: Partial<Rule>) => {
    setRules((current) => current.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  };

  const updateClause = (id: number, patch: Partial<Clause>) => {
    setRules((current) =>
      current.map((rule) =>
        rule.id === id && rule.clause ? { ...rule, clause: { ...rule.clause, ...patch } } : rule,
      ),
    );
  };

  const chooseAttribute = (id: number, ref: string) => {
    update(id, {
      clause: {
        ref,
        operator: 'is',
        // No stale value from the previous attribute's type.
        value: '',
      },
    });
  };

  const chooseOperator = (id: number, operator: Operator) => {
    const rule = rules.find((item) => item.id === id);
    if (!rule?.clause) return;
    update(id, {
      clause: {
        ref: rule.clause.ref,
        operator,
        value: operatorNeedsValue(operator) ? rule.clause.value ?? '' : undefined,
        values: operator === 'in' || operator === 'notIn' ? rule.clause.values ?? [] : undefined,
        from: operator === 'range' || operator === 'notRange' ? rule.clause.from ?? '' : undefined,
        to: operator === 'range' || operator === 'notRange' ? rule.clause.to ?? '' : undefined,
        compare: operator === 'compare' ? rule.clause.compare ?? '>' : undefined,
      },
    });
  };

  const addRule = () => {
    setRules((current) => [...current, newRule(searchable[0])]);
  };

  const copyRule = (id: number) => {
    setRules((current) => {
      const at = current.findIndex((rule) => rule.id === id);
      if (at < 0) return current;
      const clone: Rule = {
        id: nextRuleID(),
        connector: 'and',
        clause: current[at].clause ? { ...current[at].clause } : null,
      };
      return [...current.slice(0, at + 1), clone, ...current.slice(at + 1)];
    });
  };

  const deleteRule = (id: number) => {
    setRules((current) => {
      const next = current.filter((rule) => rule.id !== id);
      return next.length > 0 ? next : [newRule(searchable[0])];
    });
  };

  const apply = () => {
    if (draft.invalid) return;
    onApply(draft.expression);
    setOpen(false);
  };

  const clear = () => {
    setRules([newRule(searchable[0])]);
    onApply('');
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={searchable.length === 0}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5',
              appliedCount > 0 && 'border-indigo-500/40 text-indigo-600 dark:text-indigo-300',
            )}
          />
        }
      >
        <Filter size={12} aria-hidden="true" />
        {tr('条件过滤', 'Filters')}
        {appliedCount > 0 && (
          <span className="rounded-full bg-indigo-500/15 px-1.5 py-0.5 text-[10px] leading-none text-indigo-500 dark:text-indigo-300">
            {appliedCount}
          </span>
        )}
      </PopoverTrigger>

      <PopoverContent className="w-[min(46rem,calc(100vw-1rem))] max-h-[min(70vh,34rem)] overflow-y-auto p-3">
        <PopoverTitle className="mb-3 text-xs font-medium text-text">{tr('条件过滤', 'Filters')}</PopoverTitle>

        <div className="flex flex-col gap-2">
          {rules.map((rule, index) => {
            const attribute = rule.clause ? attributeByName.get(rule.clause.ref) : undefined;
            return (
              <RuleRow
                key={rule.id}
                rule={rule}
                index={index}
                attribute={attribute}
                attributes={searchable}
                models={models}
                onChangeConnector={(connector) => update(rule.id, { connector })}
                onChangeAttribute={(ref) => chooseAttribute(rule.id, ref)}
                onChangeOperator={(operator) => chooseOperator(rule.id, operator)}
                onChangeClause={(patch) => updateClause(rule.id, patch)}
                onCopy={() => copyRule(rule.id)}
                onDelete={() => deleteRule(rule.id)}
              />
            );
          })}
        </div>

        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={addRule}
          className="mt-2 inline-flex items-center gap-1 px-0 text-indigo-600 hover:bg-transparent dark:text-indigo-300"
        >
          <Plus size={12} aria-hidden="true" />
          {tr('新增', 'Add')}
        </Button>

        {draft.invalid && (
          <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-300">
            {tr('请补全条件后再应用。', 'Complete every condition before applying.')}
          </p>
        )}

        <div className="mt-3 flex items-center justify-end gap-2 border-t border-border/60 pt-3">
          <Button variant="outline" size="sm" type="button" onClick={clear}>
            {tr('清空', 'Clear')}
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={apply} disabled={draft.invalid}>
            {tr('确定', 'Apply')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The applied expression, shown below the toolbar with a save action. */
export function AppliedCondition({
  value,
  matches,
  onClear,
  onSave,
}: {
  value: string;
  matches: number;
  onClear(): void;
  onSave(): void;
}) {
  const { tr } = useI18n();
  if (!value.trim()) return null;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
      <CheckCircle2 size={12} className="shrink-0 text-emerald-500" aria-hidden="true" />
      <code title={value} className="min-w-0 max-w-full truncate rounded bg-card px-1.5 py-0.5 font-mono text-[11px] text-text-muted">
        q={value}
      </code>
      <span>{tr(`命中 ${matches} 条`, `${matches} matches`)}</span>
      <button
        type="button"
        onClick={onSave}
        className="rounded px-1 text-indigo-600 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:text-indigo-300"
      >
        {tr('保存条件', 'Save filter')}
      </button>
      <button
        type="button"
        onClick={onClear}
        className="rounded px-1 text-text-faint hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
      >
        {tr('清除条件', 'Clear filter')}
      </button>
    </span>
  );
}

function RuleRow({
  rule,
  index,
  attribute,
  attributes,
  models,
  onChangeConnector,
  onChangeAttribute,
  onChangeOperator,
  onChangeClause,
  onCopy,
  onDelete,
}: {
  rule: Rule;
  index: number;
  attribute?: TypeAttribute;
  attributes: TypeAttribute[];
  models: CIType[];
  onChangeConnector(connector: Connector): void;
  onChangeAttribute(ref: string): void;
  onChangeOperator(operator: Operator): void;
  onChangeClause(patch: Partial<Clause>): void;
  onCopy(): void;
  onDelete(): void;
}) {
  const { tr } = useI18n();
  const clause = rule.clause;
  if (!clause) return null;
  const operator = clause.operator;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Select
        aria-label={tr('连接方式', 'Connector')}
        value={rule.connector}
        onValueChange={(next) => onChangeConnector(next as Connector)}
        disabled={index === 0}
        options={(['and', 'or'] as Connector[]).map((connector) => ({
          value: connector,
          label: tr(CONNECTOR_LABELS[connector][0], CONNECTOR_LABELS[connector][1]),
        }))}
        className="h-8 w-16"
      />

      <Select
        aria-label={tr('属性', 'Attribute')}
        value={clause.ref}
        onValueChange={onChangeAttribute}
        options={attributes.map((item) => ({
          value: item.name,
          label: item.alias || item.name,
        }))}
        searchable
        className="h-8 w-40"
      />

      <Select
        aria-label={tr('条件', 'Condition')}
        value={operator}
        onValueChange={(next) => onChangeOperator(next as Operator)}
        options={operatorsFor(attribute).map((item) => ({
          value: item,
          label: tr(OPERATOR_LABELS[item][0], OPERATOR_LABELS[item][1]),
        }))}
        searchable
        className="h-8 w-32"
      />

      <div className="flex min-w-[12rem] flex-1 items-center gap-1.5">
        <RuleValue
          clause={clause}
          attribute={attribute}
          models={models}
          onChange={onChangeClause}
        />
      </div>

      <Button
        variant="ghost"
        size="sm"
        type="button"
        onClick={onCopy}
        aria-label={tr('复制条件', 'Copy condition')}
        title={tr('复制条件', 'Copy condition')}
        className="size-8 shrink-0 p-0 text-text-faint hover:text-text"
      >
        <Copy size={12} aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        onClick={onDelete}
        aria-label={tr('删除条件', 'Delete condition')}
        title={tr('删除条件', 'Delete condition')}
        className="size-8 shrink-0 p-0 text-text-faint hover:text-red-500"
      >
        <Trash2 size={12} aria-hidden="true" />
      </Button>
    </div>
  );
}

function RuleValue({
  clause,
  attribute,
  models,
  onChange,
}: {
  clause: Clause;
  attribute?: TypeAttribute;
  models: CIType[];
  onChange(patch: Partial<Clause>): void;
}) {
  const { tr } = useI18n();
  const pickerID = useId();
  const operator = clause.operator;

  if (!operatorNeedsValue(operator)) return null;

  if (operator === 'range' || operator === 'notRange') {
    const type = inputTypeFor(attribute);
    return (
      <>
        <Input
          aria-label={tr('下限', 'Lower bound')}
          type={type}
          value={clause.from ?? ''}
          onChange={(event) => onChange({ from: event.target.value })}
          className="h-8 min-w-0 flex-1"
        />
        <span className="text-xs text-text-faint">–</span>
        <Input
          aria-label={tr('上限', 'Upper bound')}
          type={type}
          value={clause.to ?? ''}
          onChange={(event) => onChange({ to: event.target.value })}
          className="h-8 min-w-0 flex-1"
        />
      </>
    );
  }

  if (operator === 'compare') {
    return (
      <>
        <Select
          aria-label={tr('比较', 'Comparison')}
          value={clause.compare ?? '>'}
          onValueChange={(next) => onChange({ compare: next as CompareOp })}
          options={COMPARE_OPS.map((op) => ({ value: op, label: op }))}
          className="h-8 w-20"
        />
        <Input
          aria-label={tr('比较值', 'Comparison value')}
          type={inputTypeFor(attribute)}
          value={clause.value ?? ''}
          onChange={(event) => onChange({ value: event.target.value })}
          className="h-8 min-w-0 flex-1"
        />
      </>
    );
  }

  const target =
    attribute?.is_reference && attribute.reference_type_id
      ? models.find((model) => Number(model.id) === Number(attribute.reference_type_id))
      : undefined;

  if (
    target &&
    attribute &&
    (operator === 'is' || operator === 'notIs' || operator === 'in' || operator === 'notIn')
  ) {
    const multiple = operator === 'in' || operator === 'notIn';
    const ids = (multiple ? clause.values ?? [] : clause.value ? [clause.value] : [])
      .map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    return (
      <div className="min-w-40 flex-1">
        <ReferencePicker
          id={pickerID}
          attribute={{ ...attribute, is_list: multiple }}
          target={target}
          labels={EMPTY_LABELS}
          value={multiple ? ids : ids[0] ?? null}
          onChange={(next) => {
            if (multiple) {
              const values = Array.isArray(next) ? next : [];
              onChange({ values: values.map(String) });
            } else {
              onChange({ value: next == null ? '' : String(next) });
            }
          }}
          placeholder={tr('选择实例', 'Choose an instance')}
        />
      </div>
    );
  }

  if ((operator === 'is' || operator === 'notIs') && attribute?.is_bool) {
    return (
      <Select
        aria-label={tr('值', 'Value')}
        value={clause.value || 'true'}
        onValueChange={(next) => onChange({ value: next })}
        options={[
          { value: 'true', label: tr('是', 'Yes') },
          { value: 'false', label: tr('否', 'No') },
        ]}
        className="h-8 min-w-32 flex-1"
      />
    );
  }

  if ((operator === 'is' || operator === 'notIs') && attribute?.is_choice) {
    const options = choiceOptions(attribute);
    if (options.length > 0) {
      return (
        <Select
          aria-label={tr('值', 'Value')}
          value={clause.value ?? ''}
          onValueChange={(next) => onChange({ value: next })}
          options={options}
          searchable
          className="h-8 min-w-32 flex-1"
        />
      );
    }
  }

  if (operator === 'in' || operator === 'notIn') {
    return (
      <Input
        aria-label={tr('候选值，用分号分隔', 'Candidates, separated by semicolons')}
        value={(clause.values ?? []).join(';')}
        onChange={(event) =>
          onChange({
            values: event.target.value
              .split(';')
              .map((item) => item.trim())
              .filter((item) => item !== ''),
          })
        }
        placeholder={tr('用分号分隔多个值', 'Separate values with semicolons')}
        className="h-8 min-w-0 flex-1"
      />
    );
  }

  return (
    <Input
      aria-label={tr('值', 'Value')}
      type={inputTypeFor(attribute)}
      value={clause.value ?? ''}
      onChange={(event) => onChange({ value: event.target.value })}
      className="h-8 min-w-0 flex-1"
      placeholder={tr('输入值', 'Value')}
    />
  );
}
