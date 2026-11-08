import { createContext, useContext, useEffect } from 'react';

/**
 * Page-specific facts a CMDB page contributes to the floating assistant's
 * snapshot. The shell owns the route label; pages add the values they already
 * hold (selected model, open CI, filters, counts) without re-registering the
 * page.
 */
export type CMDBAssistantFacts = Record<string, string | number | boolean | null | undefined>;

export const CMDBAssistantFactsContext =
  createContext<((facts: CMDBAssistantFacts) => void) | null>(null);

export function useCMDBAssistantFacts(facts: CMDBAssistantFacts) {
  const setFacts = useContext(CMDBAssistantFactsContext);
  const serialized = JSON.stringify(facts);
  useEffect(() => {
    if (!setFacts) return;
    setFacts(JSON.parse(serialized) as CMDBAssistantFacts);
    return () => setFacts({});
  }, [serialized, setFacts]);
}
