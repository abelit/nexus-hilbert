import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';

import { server } from '@/test/msw-server';

import { createInstance, updateInstance } from './instance';

// The server's write body is flat (see decodeWrite): a nested `values` key is
// not an attribute name, so it is ignored and the call still answers 200. These
// tests pin the request shape because a regression here is silent — the UI sees
// success while nothing is written.
it('sends attribute values flat when creating an instance', async () => {
  let body: unknown;
  server.use(
    http.post('/api/v1/cmdb/instances', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ ci_id: 7, created: true });
    }),
  );

  await createInstance({
    ci_type: 'demo',
    values: { demofile: '[{"file_id":"a1"}]', hostname: 'demo111' },
    exist_policy: 'reject',
  });

  expect(body).toEqual({
    ci_type: 'demo',
    exist_policy: 'reject',
    demofile: '[{"file_id":"a1"}]',
    hostname: 'demo111',
  });
});

it('sends a single edited attribute flat when updating an instance', async () => {
  let body: unknown;
  server.use(
    http.put('/api/v1/cmdb/instances/3865', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ ci_id: 3865, created: false });
    }),
  );

  await updateInstance(3865, { values: { demofile: '[{"file_id":"a1"}]' } });

  expect(body).toEqual({ demofile: '[{"file_id":"a1"}]' });
});
