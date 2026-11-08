import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { AssistantRoute, useAssistantSource } from '@/lib/assistantPage';
import { PageShell } from './routes';

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
});
