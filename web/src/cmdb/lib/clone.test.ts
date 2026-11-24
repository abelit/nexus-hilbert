import { describe, expect, it } from 'vitest';

import { cloneDraft } from './clone';

const attribute = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  is_unique: false,
  is_file: false,
  is_password: false,
  is_computed: false,
  ...extra,
});

describe('cloneDraft', () => {
  it('drops the identifying and unique values so the clone can be saved', () => {
    const draft = cloneDraft(
      { hostname: 'web-01', serial: 'SN-1', note: 'rack A' },
      'hostname',
      [attribute('hostname'), attribute('serial', { is_unique: true }), attribute('note')],
    );

    expect(draft).toEqual({ note: 'rack A' });
  });

  it('drops attachments, secrets and computed values', () => {
    const draft = cloneDraft(
      { hostname: 'web-01', manual: '[{"file_id":"f1"}]', secret: 'x', asset_no: 'A-1', note: 'rack A' },
      'hostname',
      [
        attribute('hostname'),
        attribute('manual', { is_file: true }),
        attribute('secret', { is_password: true }),
        attribute('asset_no', { is_computed: true }),
        attribute('note'),
      ],
    );

    expect(draft).toEqual({ note: 'rack A' });
  });

  it('keeps values that the attribute list does not know', () => {
    // A stale attribute may still be in the stored row; the clone keeps it so
    // the form shows what the instance actually holds.
    expect(cloneDraft({ hostname: 'web-01', legacy: 'kept' }, 'hostname', [attribute('hostname')])).toEqual({
      legacy: 'kept',
    });
  });
});
