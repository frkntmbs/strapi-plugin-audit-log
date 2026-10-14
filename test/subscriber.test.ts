import { describe, expect, it } from 'vitest';
import type { AuditLogConfig } from '../server/src/config';
import { buildRecord, buildRecordOptions } from '../server/src/lib/subscriber';
import type { Strapi } from '../server/src/lib/types';
import { defaultConfig } from './env';

const adminUser = { id: 7, email: 'editor@example.com', firstname: 'Jane', lastname: 'Doe' };

const makeStrapi = (ctx: unknown, attributes: Record<string, unknown> = {}): Strapi =>
  ({
    requestContext: { get: () => ctx },
    getModel: () => ({ attributes }),
  }) as unknown as Strapi;

const adminCtx = (user: unknown = adminUser, extra: Record<string, unknown> = {}) => ({
  state: { user, route: { info: { type: 'admin' } }, auditIp: '10.0.0.1' },
  request: { headers: {}, ...extra },
});

const options = (overrides: Partial<AuditLogConfig> = {}) => buildRecordOptions({ ...defaultConfig(), ...overrides });

describe('buildRecord', () => {
  it('records an admin entry update with user, ip and compacted payload', () => {
    const strapi = makeStrapi(adminCtx(), {
      title: { type: 'string' },
      cover: { type: 'media' },
      blocks: { type: 'dynamiczone' },
    });
    const record = buildRecord(
      strapi,
      'entry.update',
      {
        uid: 'api::article.article',
        entry: {
          id: 12,
          documentId: 'doc1',
          locale: 'tr',
          title: 'Hello world',
          cover: { id: 3, name: 'cover.png', url: '/uploads/cover.png', size: 120 },
          blocks: [{ id: 1, __component: 'shared.rich-text', body: 'long text' }],
        },
      },
      options()
    );

    expect(record).toMatchObject({
      action: 'entry.update',
      userEmail: 'editor@example.com',
      userName: 'Jane Doe',
      userId: 7,
      ip: '10.0.0.1',
      contentType: 'api::article.article',
      targetDocumentId: 'doc1',
      entryId: 12,
      entryLocale: 'tr',
      label: 'Hello world',
    });
    expect(record?.payload).toEqual({
      id: 12,
      documentId: 'doc1',
      locale: 'tr',
      title: 'Hello world',
      cover: { id: 3, name: 'cover.png' },
      blocks: { count: 1, items: [{ id: 1, __component: 'shared.rich-text' }] },
    });
  });

  it('skips events outside admin routes (cron, public API)', () => {
    const strapi = makeStrapi({ state: { user: adminUser, route: { info: { type: 'content-api' } } } });
    expect(buildRecord(strapi, 'entry.create', { uid: 'api::article.article', entry: {} }, options())).toBeNull();
    expect(buildRecord(makeStrapi(undefined), 'entry.create', { uid: 'api::a.a', entry: {} }, options())).toBeNull();
  });

  it('masks configured content types', () => {
    const strapi = makeStrapi(adminCtx());
    const record = buildRecord(
      strapi,
      'entry.update',
      { uid: 'api::contact.contact', entry: { id: 1, documentId: 'd', email: 'person@example.com', phone: '555' } },
      options({ maskedContentTypes: ['api::contact.contact'] })
    );
    expect(record?.label).toBe('d');
    expect(record?.payload).toEqual({ masked: true, id: 1, documentId: 'd', locale: undefined, fields: ['email', 'phone'] });
  });

  it('ignores the audit log itself, upload entries and configured types', () => {
    const strapi = makeStrapi(adminCtx());
    const opts = options({ ignoredContentTypes: ['api::noise.noise'] });
    for (const uid of ['plugin::audit-log.audit-log', 'plugin::upload.file', 'api::noise.noise']) {
      expect(buildRecord(strapi, 'entry.create', { uid, entry: { id: 1 } }, opts)).toBeNull();
    }
  });

  it('drops excluded events', () => {
    const strapi = makeStrapi(adminCtx());
    const opts = options({ excludedEvents: ['admin.auth.success'] });
    expect(buildRecord(strapi, 'admin.auth.success', { provider: 'local' }, opts)).toBeNull();
    expect(buildRecord(strapi, 'admin.logout', {}, opts)).not.toBeNull();
  });

  it('records failed logins without a user, using the attempted email', () => {
    const strapi = makeStrapi(adminCtx(undefined, { body: { email: 'attacker@example.com', password: 'p' } }));
    const record = buildRecord(strapi, 'admin.auth.error', { provider: 'local', error: new Error('Invalid credentials') }, options());
    expect(record).toMatchObject({
      action: 'admin.auth.error',
      userEmail: 'attacker@example.com',
      payload: { provider: 'local', error: 'Invalid credentials' },
    });
    expect(JSON.stringify(record)).not.toContain('"p"');
  });

  it('falls back to x-forwarded-for when the early ip is missing', () => {
    const ctx = adminCtx();
    delete (ctx.state as Record<string, unknown>).auditIp;
    (ctx.request as Record<string, unknown>).headers = { 'x-forwarded-for': '1.2.3.4, 10.0.0.2' };
    const record = buildRecord(makeStrapi(ctx), 'admin.logout', {}, options());
    expect(record?.ip).toBe('1.2.3.4');
  });
});

describe('defaults', () => {
  it('always masks users-permissions users', () => {
    const record = buildRecord(
      makeStrapi(adminCtx()),
      'entry.update',
      { uid: 'plugin::users-permissions.user', entry: { id: 3, documentId: 'u', email: 'member@example.com', username: 'member' } },
      options()
    );
    expect(record?.payload).toMatchObject({ masked: true, fields: ['email', 'username'] });
    expect(JSON.stringify(record)).not.toContain('member@example.com');
  });
});
