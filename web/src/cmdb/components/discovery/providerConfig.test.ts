import { describe, expect, it } from 'vitest';

import {
  accountReference,
  boolValue,
  numberValue,
  snmpNodes,
  stringList,
  withSnmpNodes,
} from './providerConfig';

describe('provider config helpers', () => {
  it('normalizes scalar values without inventing them', () => {
    expect(numberValue('5', 3)).toBe(5);
    expect(numberValue('x', 3)).toBe(3);
    expect(numberValue(undefined, 3)).toBe(3);
    expect(boolValue(false, true)).toBe(false);
    expect(boolValue(undefined, true)).toBe(true);
    expect(accountReference({ _reference: 7 })).toBe('7');
    expect(accountReference({})).toBe('');
  });

  it('accepts SNMP cidr as an array and components cidr as a string', () => {
    expect(stringList(['10.0.0.0/8', '', ' 192.168.0.0/16 '])).toEqual([
      '10.0.0.0/8',
      '192.168.0.0/16',
    ]);
    expect(stringList('10.0.0.0/8')).toEqual(['10.0.0.0/8']);
  });

  it('always leaves one editable SNMP node', () => {
    expect(snmpNodes({})).toEqual([{ ip: '', version: '2c' }]);
    const nodes = snmpNodes({
      nodes: [
        { ip: '10.0.0.1', version: '1', has_community: true },
        { ip: '', version: '' },
      ],
    });
    expect(nodes).toEqual([
      { ip: '10.0.0.1', version: '1', has_community: true },
      { ip: '', version: '2c' },
    ]);
    expect(withSnmpNodes({ region: 'cn' }, nodes)).toEqual({ region: 'cn', nodes });
  });
});
