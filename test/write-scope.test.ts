import { describe, expect, it } from 'vitest';
import { isAuditWriter, runAsAuditWriter } from '../server/src/lib/write-scope';

describe('write scope', () => {
  it('is only active inside runAsAuditWriter, across awaits', async () => {
    expect(isAuditWriter()).toBe(false);
    const inside = await runAsAuditWriter(async () => {
      await new Promise((r) => setTimeout(r, 1));
      return isAuditWriter();
    });
    expect(inside).toBe(true);
    expect(isAuditWriter()).toBe(false);
  });
});
