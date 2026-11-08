import type { AssistantPage } from './assistantPage';

/**
 * A request from a page to open the floating assistant with a prepared
 * question. The panel owns its local state; this store is the only way a page
 * can reach it without duplicating the chat session/SSE logic.
 *
 * `snapshot` optionally overrides the page context for this question;
 * `autoSend` is reserved for future one-click actions and is not used yet.
 */
export type AssistantIntent = {
  id: number;
  prompt: string;
  snapshot?: AssistantPage;
  autoSend?: boolean;
};

type Listener = (intent: AssistantIntent) => void;

let sequence = 0;
const listeners = new Set<Listener>();

export function openAssistant(intent: Omit<AssistantIntent, 'id'>): void {
  const next: AssistantIntent = { ...intent, id: ++sequence };
  for (const listener of listeners) {
    listener(next);
  }
}

export function subscribeAssistantIntent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
