import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { Button } from '@/components/ui';
import { Modal } from '@/components/Modal';
import { useI18n } from '@/i18n/locale';

import { listCITypes, type CIType } from '../api/citype';
import { listModelGroups, type ModelGroup } from '../api/preferences';
import { describeError } from '../api/http';
import { ModelTree } from './ModelTree';
import { ModelTreeRefreshContext } from './model-tree-context';

// The model configuration workspace.
//
// THE PAGE AND THE TREE LOAD SEPARATELY. The tree needs every model and its
// shared group; the page owns its own data and tabs. Keeping the two loaders
// separate means switching models does not refetch the tree, and a failed tree
// load does not blank the detail an operator is already reading.
//
// On narrow screens the tree moves into a modal. The page header keeps a
// "choose model" button, so a phone user can switch models without a
// permanent 264px rail consuming the viewport.

export function ModelConfigShell({ children }: { children: React.ReactNode }) {
  const { tr } = useI18n();
  const params = useParams<{ id?: string }>();
  const selectedID = params.id && /^\d+$/.test(params.id) ? Number(params.id) : undefined;
  const [models, setModels] = useState<CIType[]>([]);
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [gotModels, gotGroups] = await Promise.all([listCITypes(), listModelGroups().catch(() => [] as ModelGroup[])]);
      setModels(gotModels);
      setGroups(gotGroups);
    } catch (error) {
      setErr(describeError(error, tr('无法读取模型导航', 'Could not load model navigation')));
    } finally {
      setLoading(false);
    }
  }, [tr]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useMemo(() => ({ refresh: () => void load() }), [load]);
  const selected = models.find((model) => model.id === selectedID);

  return (
    <ModelTreeRefreshContext.Provider value={refresh}>
      <div className="flex h-full min-h-0 w-full min-w-0">
        <div className="hidden h-full min-h-0 lg:flex">
          <ModelTree
            models={models}
            groups={groups}
            selectedID={selectedID}
            loading={loading}
            error={err}
            onRetry={() => void load()}
          />
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2 lg:hidden">
            <Button variant="outline" size="sm" type="button" onClick={() => setMobileOpen(true)}>
              {tr('选择模型', 'Choose model')}
            </Button>
            <span className="min-w-0 truncate text-xs text-text-muted">
              {selected ? selected.alias || selected.name : tr('未选择模型', 'No model selected')}
            </span>
          </div>
          <div className="min-h-0 flex-1">{children}</div>
        </div>
      </div>

      <Modal
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        size="md"
        title={tr('选择模型', 'Choose model')}
      >
        <div className="h-[65vh]">
          <ModelTree
            models={models}
            groups={groups}
            selectedID={selectedID}
            loading={loading}
            error={err}
            onRetry={() => void load()}
            onSelect={() => setMobileOpen(false)}
          />
        </div>
      </Modal>
    </ModelTreeRefreshContext.Provider>
  );
}
