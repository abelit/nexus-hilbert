import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { AssistantRoute, useAssistantSource } from '@/lib/assistantPage';
import { useCMDBAssistantFacts } from './lib/assistantFacts';
import { PageShell } from './routes';

function FactsChild() {
  useCMDBAssistantFacts({ model_id: 7, filter: 'host' });
  return <div />;
}

beforeEach(() => {
  localStorage.setItem('ongrid-locale', 'zh-CN');
  useAssistantSource.setState({ route: '', snapshot: null });
});

describe('CMDB assistant page context', () => {
  it('registers the current page so the assistant can send', async () => {
    render(
      <MemoryRouter initialEntries={['/cmdb/models']}>
        <AssistantRoute.Provider value="route-key">
          <PageShell>
            <div>page</div>
          </PageShell>
        </AssistantRoute.Provider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(useAssistantSource.getState().snapshot?.page).toBe('模型配置'));
    expect(useAssistantSource.getState().snapshot?.fields.route).toBe('/cmdb/models');
  });

  it('merges page-specific facts into the snapshot', async () => {
    render(
      <MemoryRouter initialEntries={['/cmdb/models']}>
        <AssistantRoute.Provider value="route-key">
          <PageShell>
            <FactsChild />
          </PageShell>
        </AssistantRoute.Provider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(useAssistantSource.getState().snapshot?.fields.model_id).toBe('7'));
    expect(useAssistantSource.getState().snapshot?.fields.filter).toBe('host');
    expect(useAssistantSource.getState().snapshot?.fields.route).toBe('/cmdb/models');
  });
});
