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
