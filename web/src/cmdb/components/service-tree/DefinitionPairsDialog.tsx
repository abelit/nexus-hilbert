import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui';
import { Checkbox } from '@/components/ui/Checkbox';
import { Chip } from '@/components/ui/Chip';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Modal } from '@/components/Modal';
import { useI18n } from '@/i18n/locale';

import type { ModelRelation } from '../../api/citype';
import type { ServiceTree, TypePair } from '../../api/preferences';
import { pairKey } from '../../lib/model-relation-graph';

/**
 * The exact-pair editor for a definition.
 *
 * The canvas derives pairs from a model selection, which is quick but cannot
 * express "keep this branch and drop that one". This dialog is the advanced
 * path: every live model relation is listed, stored pairs start ticked, and a
 * pair whose relation has since disappeared is called out before it is dropped.
 *
 * The dialog is presentational; the page owns the request and the toast so the
 * visual and exact paths share one save/refresh flow.
 */
export function DefinitionPairsDialog({
  tree,
  relations,
  initialPairs,
  saving,
  error,
  onClose,
  onSubmit,
}: {
  tree: ServiceTree | null;
  relations: ModelRelation[];
  initialPairs: TypePair[];
  saving: boolean;
  error: string | null;
  onClose(): void;
  onSubmit(name: string, isPublic: boolean, pairs: TypePair[]): void;
}) {
  const { tr } = useI18n();
  const [name, setName] = useState(tree?.name ?? '');
  const [isPublic, setIsPublic] = useState(tree?.is_public ?? false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>(() => [...new Set(initialPairs.map(pairKey))]);
  const [localError, setLocalError] = useState<string | null>(null);

  const options = useMemo(() => {
    const seen = new Set<string>();
    const rows: Array<{ key: string; label: string }> = [];
    for (const relation of relations) {
      const parent = relation.parent.type;
      const child = relation.child.type;
      if (parent.id === child.id) continue;
      const key = `${parent.id}:${child.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        key,
        label: `${parent.alias || parent.name} → ${child.alias || child.name}`,
      });
    }
    return rows.sort((left, right) => left.label.localeCompare(right.label));
  }, [relations]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return options;
    return options.filter((option) => option.label.toLowerCase().includes(term));
  }, [options, query]);

  const available = useMemo(() => new Set(options.map((option) => option.key)), [options]);
  const missing = initialPairs.filter((pair) => !available.has(pairKey(pair)));
  const selectedLive = selected.filter((key) => available.has(key));
  const selectedCount = selectedLive.length;

  const submit = (): void => {
    const trimmed = name.trim();
    if (!trimmed) {
      setLocalError(tr('名称不能为空', 'A name is required'));
      return;
    }
    if (selectedLive.length === 0) {
      setLocalError(
        missing.length > 0
          ? tr('至少保留一对有效的模型关系', 'Keep at least one live model relation')
          : tr('至少选一对模型关系', 'Pick at least one model relation'),
      );
      return;
    }
    const pairs = selectedLive.map((key) => {
      const [parent, child] = key.split(':').map(Number);
      return { parent_id: parent, child_id: child };
    });
    setLocalError(null);
    onSubmit(trimmed, isPublic, pairs);
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={tree ? tr('编辑服务树定义', 'Edit tree definition') : tr('新建服务树定义', 'New tree definition')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose} disabled={saving}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button variant="primary" type="button" onClick={submit} disabled={saving}>
            {saving ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
          </Button>
        </div>
      }
    >
      {(error || localError) && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300"
        >
          {error || localError}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <div>
          <Label htmlFor="cmdb-relation-pairs-name">{tr('名称', 'Name')}</Label>
          <Input
            id="cmdb-relation-pairs-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 w-full"
          />
        </div>

        <label className="flex items-center gap-2 text-xs text-text-muted">
          <Checkbox checked={isPublic} onCheckedChange={(next) => setIsPublic(next === true)} />
          {tr('所有人可见', 'Visible to everyone')}
        </label>

        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-text-muted">
              {tr('用哪些模型关系搭出这棵树', 'Which model relations make up the tree')}
            </p>
            <Chip dense>{tr(`已选 ${selectedCount} 对`, `${selectedCount} selected`)}</Chip>
          </div>

          {missing.length > 0 && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                {tr(
                  `${missing.length} 对模型关系已失效，保存时会从定义中移除。`,
                  `${missing.length} ${missing.length === 1 ? 'pair has' : 'pairs have'} gone stale and will be removed when you save.`,
                )}
              </span>
            </div>
          )}

          <div className="mt-2">
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tr('搜索模型关系', 'Search model relations')}
              aria-label={tr('搜索模型关系', 'Search model relations')}
            />
          </div>

          <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-border">
            {filtered.length === 0 ? (
              <p className="py-6 text-center text-xs text-text-muted">
                {options.length === 0
                  ? tr('还没有模型关系。先去「模型关系」里挂几个。', 'No model relations yet. Add some under “Relations” first.')
                  : tr('没有匹配的模型关系', 'No matching model relation')}
              </p>
            ) : (
              filtered.map((option) => (
                <label
                  key={option.key}
                  className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-xs last:border-0 hover:bg-card"
                >
                  <Checkbox
                    checked={selected.includes(option.key)}
                    onCheckedChange={(next) =>
                      setSelected((current) =>
                        next === true ? [...current, option.key] : current.filter((item) => item !== option.key),
                      )
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                </label>
              ))
            )}
          </div>
          <p className="mt-1 text-[11px] text-text-faint">
            {tr(
              '每一对是一条边；连起来就是一层层展开的树。画布上的快速选择仍会推导所有选中模型之间的关系。',
              'Each pair is one edge; chained together they make the levels of the tree. Quick selection on the canvas still derives every relation between the models you tick.',
            )}
          </p>
        </div>
      </div>
    </Modal>
  );
}
