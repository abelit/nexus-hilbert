import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';

import { Button } from '@/components/ui';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Modal } from '@/components/Modal';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { useI18n } from '@/i18n/locale';

import type { CIType } from '../../api/citype';
import { describeError } from '../../api/http';
import {
  deleteAutoSubscription,
  setAutoSubscription,
  type AutoSubscription,
  type ModelGroup,
} from '../../api/preferences';

// --- auto subscription ---

export function AutoSubscriptionModal({
  current,
  groups,
  models,
  onClose,
  onSaved,
}: {
  current: AutoSubscription | null;
  groups: ModelGroup[];
  models: CIType[];
  onClose(): void;
  onSaved(message: string): void | Promise<void>;
}) {
  const { tr } = useI18n();
  const [enabled, setEnabled] = useState(current?.enabled ?? true);
  // cantor's form defaults to "all": an empty rule means "subscribe everything"
  // unless the operator explicitly picked the selective strategy.
  const [strategy, setStrategy] = useState(current?.base_strategy === 'none' ? 'none' : 'all');
  const [groupIDs, setGroupIDs] = useState<number[]>(current?.group_ids ?? []);
  const [typeIDs, setTypeIDs] = useState<number[]>(current?.type_ids ?? []);
  const [description, setDescription] = useState(current?.description ?? '');
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isAll = strategy === 'all';
  const term = search.trim().toLowerCase();
  const filteredModels = useMemo(
    () =>
      models
        .filter(
          (model) => !term || model.name.toLowerCase().includes(term) || (model.alias ?? '').toLowerCase().includes(term),
        )
        .sort((a, b) => (a.alias || a.name).localeCompare(b.alias || b.name, 'zh-Hans-CN')),
    [models, term],
  );

  const toggleID = (ids: number[], id: number, on: boolean) =>
    on ? [...ids, id] : ids.filter((item) => item !== id);

  const submit = async () => {
    setSaving(true);
    setErr(null);
    try {
      await setAutoSubscription({
        enabled,
        base_strategy: strategy,
        group_ids: groupIDs,
        type_ids: typeIDs,
        description,
      });
      await onSaved(tr('已保存', 'Saved'));
    } catch (error) {
      setErr(describeError(error, tr('保存失败', 'Could not save')));
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setErr(null);
    try {
      await deleteAutoSubscription();
      await onSaved(tr('已删除自动订阅规则', 'Auto-subscription rule removed'));
    } catch (error) {
      setErr(describeError(error, tr('删除失败', 'Could not remove it')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={tr('自动订阅', 'Auto subscribe')}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div>
            {current && (
              <Button variant="dangerGhost" type="button" onClick={() => void clear()} disabled={saving}>
                {tr('删除规则', 'Remove rule')}
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" type="button" onClick={onClose} disabled={saving}>
              {tr('取消', 'Cancel')}
            </Button>
            <Button variant="primary" type="button" onClick={() => void submit()} disabled={saving}>
              {saving ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
            </Button>
          </div>
        </div>
      }
    >
      {err && (
        <div role="alert" className="mb-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          {err}
        </div>
      )}

      <div className="flex flex-col gap-4">
        <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs">
          <span>
            <span className="font-medium text-text">{tr('启用自动订阅', 'Enable auto subscription')}</span>
            <span className="mt-0.5 block text-[11px] text-text-muted">
              {tr('启用后，模型列表只以规则结果为准，手动取消不会生效。', 'While enabled, the model list follows the rule; manual unsubscription has no effect.')}
            </span>
          </span>
          <Switch checked={enabled} onCheckedChange={(next) => setEnabled(next === true)} aria-label={tr('启用自动订阅', 'Enable auto subscription')} />
        </label>

        <div>
          <Label htmlFor="cmdb-autosub-strategy">{tr('订阅范围', 'Subscription scope')}</Label>
          <Select
            id="cmdb-autosub-strategy"
            label={tr('订阅范围', 'Subscription scope')}
            value={strategy}
            onValueChange={(value) => setStrategy(value === 'all' ? 'all' : 'none')}
            options={[
              { value: 'all', label: tr('订阅所有模型，排除所选', 'Subscribe every model except the selected') },
              { value: 'none', label: tr('只订阅所选分组和模型', 'Subscribe only the selected groups and models') },
            ]}
            className="mt-1 w-full"
          />
          <p className="mt-1 text-[11px] text-text-muted">
            {isAll
              ? tr('新建的模型也会自动订阅；选中的分组和模型会被排除。', 'Models created later are subscribed too; the selected groups and models are excluded.')
              : tr('只订阅选中的分组和模型，两者取并集。', 'Subscribe only the selected groups and models; the two lists are combined.')}
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-text">{isAll ? tr('排除分组', 'Exclude groups') : tr('订阅分组', 'Subscribe groups')}</span>
            <span className="text-[11px] text-text-faint">{tr(`已选 ${groupIDs.length} 个分组`, `${groupIDs.length} selected`)}</span>
          </div>
          <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border">
            {groups.length === 0 ? (
              <p className="py-4 text-center text-xs text-text-muted">{tr('还没有模型分组', 'No model group yet')}</p>
            ) : (
              groups.map((group) => (
                <label
                  key={group.id}
                  className="flex cursor-pointer items-center gap-2 border-b border-border px-2 py-1.5 text-xs last:border-0 hover:bg-card"
                >
                  <Checkbox
                    className="border-text-faint"
                    checked={group.id != null && groupIDs.includes(group.id)}
                    onCheckedChange={(next) => {
                      if (group.id != null) {
                        setGroupIDs((current) => toggleID(current, group.id as number, next === true));
                      }
                    }}
                    aria-label={group.name || tr('未命名分组', 'Untitled group')}
                  />
                  <span className="min-w-0 flex-1 truncate">{group.name || tr('未命名分组', 'Untitled group')}</span>
                  <span className="shrink-0 text-[11px] text-text-faint">
                    {tr(`${group.ci_types.length} 个模型`, `${group.ci_types.length} models`)}
                  </span>
                </label>
              ))
            )}
          </div>
        </div>

        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-text">{isAll ? tr('排除模型', 'Exclude models') : tr('订阅模型', 'Subscribe models')}</span>
            <span className="text-[11px] text-text-faint">{tr(`已选 ${typeIDs.length} 个模型`, `${typeIDs.length} selected`)}</span>
          </div>
          <div className="relative mt-1">
            <Search
              size={13}
              className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-text-faint"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={tr('搜索模型', 'Search models')}
              aria-label={tr('搜索模型', 'Search models')}
              className="ps-8"
            />
          </div>
          <div className="mt-1 max-h-52 overflow-y-auto rounded-md border border-border">
            {filteredModels.length === 0 ? (
              <p className="py-4 text-center text-xs text-text-muted">{tr('没有匹配的模型', 'No model matches')}</p>
            ) : (
              filteredModels.map((model) => (
                <label
                  key={model.id}
                  className="flex cursor-pointer items-center gap-2 border-b border-border px-2 py-1.5 text-xs last:border-0 hover:bg-card"
                >
                  <Checkbox
                    className="border-text-faint"
                    checked={typeIDs.includes(model.id)}
                    onCheckedChange={(next) => setTypeIDs((current) => toggleID(current, model.id, next === true))}
                    aria-label={model.alias || model.name}
                  />
                  <span className="min-w-0 flex-1 truncate">{model.alias || model.name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-text-faint">{model.name}</span>
                </label>
              ))
            )}
          </div>
        </div>

        <div>
          <Label htmlFor="cmdb-autosub-desc">{tr('说明', 'Description')}</Label>
          <Input
            id="cmdb-autosub-desc"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={tr('可选，便于以后识别这条规则', 'Optional, to recognise the rule later')}
            className="mt-1 w-full"
          />
        </div>
      </div>
    </Modal>
  );
}
