import { useState } from 'react';

import { Button } from '@/components/ui';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Modal } from '@/components/Modal';
import { useI18n } from '@/i18n/locale';

import type { ServiceTree, TypePair } from '../../api/preferences';
import { serviceTreeChainTokens } from '../../lib/model-relation-graph';

/** Name and visibility for the model selection already made on the canvas. */
export function DefinitionDialog({
  tree,
  pairs,
  label,
  saving,
  error,
  onClose,
  onSubmit,
}: {
  tree: ServiceTree | null;
  pairs: TypePair[];
  label(id: number): string;
  saving: boolean;
  error: string | null;
  onClose(): void;
  onSubmit(name: string, isPublic: boolean): void;
}) {
  const { tr } = useI18n();
  const [name, setName] = useState(tree?.name ?? '');
  const [isPublic, setIsPublic] = useState(tree?.is_public ?? false);
  const tokens = serviceTreeChainTokens(pairs, label);

  return (
    <Modal
      open
      onClose={onClose}
      title={tree ? tr('编辑服务树定义', 'Edit tree definition') : tr('新建服务树定义', 'New tree definition')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose} disabled={saving}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            type="button"
            onClick={() => onSubmit(name, isPublic)}
            disabled={saving}
          >
            {saving ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
          </Button>
        </div>
      }
    >
      {error && (
        <div role="alert" className="mb-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <div>
          <Label htmlFor="cmdb-relation-definition-name">{tr('名称', 'Name')}</Label>
          <Input
            id="cmdb-relation-definition-name"
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
          <p className="text-[11px] font-medium text-text-faint">
            {tr(
              `将保存 ${pairs.length} 对模型关系`,
              `${pairs.length} model ${pairs.length === 1 ? 'pair' : 'pairs'} will be saved`,
            )}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1 rounded-md border border-dashed border-border/60 bg-card/50 px-2 py-2">
            {tokens.length === 0 ? (
              <span className="text-[11px] text-text-faint">
                {tr('还没有选择模型关系', 'No model relation selected yet')}
              </span>
            ) : (
              tokens.map((token, index) => (
                <span key={`${token}-${index}`} className="flex items-center gap-1">
                  {index > 0 && <span className="text-text-faint">→</span>}
                  <span className="rounded border border-border bg-card px-1.5 py-0.5 text-[11px] text-text">
                    {token}
                  </span>
                </span>
              ))
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
