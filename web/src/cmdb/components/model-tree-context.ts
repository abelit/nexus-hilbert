import { createContext, useContext } from 'react';

// The model tree and the page beside it load the model list independently. A
// write on the page (create, rename, enable/disable, delete) has to refresh the
// tree too, or the navigation goes stale. The shell owns the tree's loader and
// publishes it here; pages call it after a successful model write.
export type ModelTreeRefresh = { refresh(): void };

export const ModelTreeRefreshContext = createContext<ModelTreeRefresh | null>(null);

export function useModelTreeRefresh(): ModelTreeRefresh | null {
  return useContext(ModelTreeRefreshContext);
}

// A grouping write can start in the tree and needs the page beside it to
// reload: the tree's loader and the page's loader are separate by design. The
// shell owns the version; the tree bumps it after a drag, and a page that
// renders groups watches it.
export type ModelGroupsSync = { version: number; notify(): void };

export const ModelGroupsSyncContext = createContext<ModelGroupsSync | null>(null);

export function useModelGroupsSync(): ModelGroupsSync | null {
  return useContext(ModelGroupsSyncContext);
}
