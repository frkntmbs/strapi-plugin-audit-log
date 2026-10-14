import { describe, expect, it } from 'vitest';
import config from '../server/src/config';
import { defaultConfig } from './env';
import { capPayload } from '../server/src/lib/compact';
import { escapeCsvField, toCsvRow } from '../server/src/lib/csv';
import { describeDbError, isMysqlTriggerPrivilegeError } from '../server/src/lib/protect';

describe('config validator', () => {
  const valid = defaultConfig();

  it('accepts defaults', () => {
    expect(() => config.validator(valid)).not.toThrow();
  });

  it('accepts retentionCron false', () => {
    expect(() => config.validator({ ...valid, retentionCron: false })).not.toThrow();
  });

  it.each([
    [{ retentionDays: 0 }, /retentionDays/],
    [{ retentionDays: 7 }, /retentionDays/],
    [{ retentionDays: '365' }, /retentionDays/],
    [{ retentionCron: '' }, /retentionCron/],
    [{ maskedContentTypes: 'api::a.a' }, /maskedContentTypes/],
    [{ excludedEvents: ['entry.nope'] }, /unknown events/],
    [{ appendOnly: 'yes' }, /appendOnly/],
  ])('rejects %o', (override, message) => {
    expect(() => config.validator({ ...valid, ...(override as object) } as typeof valid)).toThrow(message);
  });
});

describe('env defaults', () => {
  it('reads settings from env so no plugins.ts is needed', () => {
    expect(
      defaultConfig({
        AUDIT_LOG_ENABLED: 'false',
        AUDIT_LOG_RETENTION_DAYS: '730',
        AUDIT_LOG_APPEND_ONLY: 'false',
        AUDIT_LOG_MASKED_CONTENT_TYPES: 'api::a.a, api::b.b',
      })
    ).toMatchObject({ enabled: false, retentionDays: 730, appendOnly: false, maskedContentTypes: ['api::a.a', 'api::b.b'] });
    expect(defaultConfig()).toMatchObject({ enabled: true, retentionDays: 365, appendOnly: true, maskedContentTypes: [] });
  });
});

describe('capPayload', () => {
  it('keeps small payloads and replaces oversized ones with keys', () => {
    expect(capPayload({ a: 1 })).toEqual({ a: 1 });
    const big = { a: 'x'.repeat(40 * 1024), b: 1 };
    expect(capPayload(big)).toMatchObject({ truncated: true, keys: ['a', 'b'] });
  });
});

describe('csv', () => {
  it('quotes fields and neutralizes formula injection', () => {
    expect(escapeCsvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(escapeCsvField('-1')).toBe(`"'-1"`);
    expect(escapeCsvField(null)).toBe('""');
    expect(escapeCsvField(new Date('2026-01-02T03:04:05.000Z'))).toBe('"2026-01-02T03:04:05.000Z"');
  });

  it('serializes rows in column order with json payload', () => {
    const row = toCsvRow({ action: 'entry.update', payload: { id: 1 }, createdAt: '2026-01-01' });
    expect(row.startsWith('"2026-01-01","entry.update"')).toBe(true);
    expect(row.endsWith('"{""id"":1}"')).toBe(true);
  });
});

describe('describeDbError', () => {
  it('prefers sqlMessage and appends code', () => {
    const err = Object.assign(new Error(''), { code: 'ER_X', errno: 1419, sqlMessage: 'no SUPER' });
    expect(describeDbError(err)).toBe('no SUPER (ER_X 1419)');
    expect(isMysqlTriggerPrivilegeError(err)).toBe(true);
    expect(describeDbError(new Error('plain'))).toBe('plain');
  });
});
