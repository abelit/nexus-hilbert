import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { Button } from '@/components/ui';
import { Modal } from '@/components/Modal';
import { useI18n } from '@/i18n/locale';

import { listCITypes, type CIType } from '../api/citype';
import { listModelGroups, type ModelGroup } from '../api/preferences';
import { describeError } from '../api/http';
import { ModelTree } from './ModelTree';
import { ModelGroupsSyncContext, ModelTreeRefreshContext } from './model-tree-context';
import { WorkspaceBar } from './WorkspaceBar';

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
//
// THE BAR BELONGS TO THE WORKSPACE, NOT TO A PAGE. Model configuration reads as
// its own product surface: a full-width bar carries the CMDB mark, the page's
// breadcrumb and its actions, and the tree starts underneath it. If the bar
// lived inside the content column the tree would start above the breadcrumb and
// the two left rails would fight for the first line.

/** The workspace bar's page-specific slots. */
export type ModelConfigHeader = {
  /** Breadcrumb, ending in the page's own heading. */
  leading: React.ReactNode;
  /** Counters and page actions, right-aligned when they fit. */
  actions?: React.ReactNode;
};

export function ModelConfigShell({ header, children }: { header: ModelConfigHeader; children: React.ReactNode }) {
  const { tr } = useI18n();
  const params = useParams<{ id?: string }>();
  const selectedID = params.id && /^\d+$/.test(params.id) ? Number(params.id) : undefined;
  const [models, setModels] = useState<CIType[]>([]);
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [groupsVersion, setGroupsVersion] = useState(0);

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
  const groupsSync = useMemo(
    () => ({ version: groupsVersion, notify: () => setGroupsVersion((current) => current + 1) }),
    [groupsVersion],
  );
  const selected = models.find((model) => model.id === selectedID);

  return (
    <ModelTreeRefreshContext.Provider value={refresh}>
      <ModelGroupsSyncContext.Provider value={groupsSync}>
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
        <WorkspaceBar leading={header.leading} actions={header.actions} />

        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="hidden h-full min-h-0 lg:flex">
            <ModelTree
              models={models}
              groups={groups}
              selectedID={selectedID}
              loading={loading}
              error={err}
              onRetry={() => void load()}
              compact
            />
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* THE LIST IS NOT A MODEL DETAIL. On /cmdb/models there is no
                selected model, so the narrow-screen picker would offer a choice
                the page itself already shows. Detail pages keep it. */}
            {selectedID !== undefined && (
              <div className="flex items-center gap-2 border-b border-border px-4 py-2 lg:hidden">
                <Button variant="outline" size="sm" type="button" onClick={() => setMobileOpen(true)}>
                  {tr('选择模型', 'Choose model')}
                </Button>
                <span className="min-w-0 truncate text-xs text-text-muted">
                  {selected ? selected.alias || selected.name : tr('未选择模型', 'No model selected')}
                </span>
              </div>
            )}
            <div className="min-h-0 flex-1">{children}</div>
          </div>
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
            compact
          />
        </div>
      </Modal>
      </ModelGroupsSyncContext.Provider>
    </ModelTreeRefreshContext.Provider>
  );
}
