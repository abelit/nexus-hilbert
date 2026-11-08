import { createContext, useContext, useEffect, useMemo } from 'react';

/**
 * Page-specific facts a CMDB page contributes to the floating assistant's
 * snapshot. The shell owns the route label; pages add the values they already
 * hold (selected model, open CI, filters, counts) without re-registering the
 * page.
 */
export type CMDBAssistantFacts = Record<string, string | number | boolean | null | undefined>;

/**
 * Facts are MERGED, not replaced. A modal form inside a page registers its own
 * form_kind/form_mode while the page's model/CI facts stay visible; the form's
 * cleanup removes only the keys it added.
 */
export type CMDBAssistantFactsUpdate =
  | CMDBAssistantFacts
  | ((previous: CMDBAssistantFacts) => CMDBAssistantFacts);

export const CMDBAssistantFactsContext = createContext<
  ((update: CMDBAssistantFactsUpdate) => void) | null
>(null);

export function useCMDBAssistantFacts(facts: CMDBAssistantFacts) {
  const setFacts = useContext(CMDBAssistantFactsContext);
  const serialized = JSON.stringify(facts);
  const keys = useMemo(() => Object.keys(JSON.parse(serialized) as CMDBAssistantFacts), [serialized]);
  useEffect(() => {
    if (!setFacts) return;
    const own = JSON.parse(serialized) as CMDBAssistantFacts;
    setFacts((previous) => ({ ...previous, ...own }));
    return () => {
      setFacts((previous) => {
        const next = { ...previous };
        for (const key of keys) delete next[key];
        return next;
      });
    };
  }, [serialized, keys, setFacts]);
}
