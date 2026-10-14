import type { AuditLogConfig } from '../config';
import { capPayload, compactEntry, pickLabel } from './compact';
import { ALWAYS_IGNORED_ENTRY_UIDS, ALWAYS_MASKED_UIDS, DEFAULT_EVENTS, PLUGIN_ID } from './constants';
import type { AuditRecord, Strapi } from './types';

type AdminUser = { id?: number; email?: string; firstname?: string; lastname?: string; username?: string };

type RequestState = {
  user?: AdminUser;
  route?: { info?: { type?: string } };
  auditIp?: string;
};

type RequestLike = { ip?: string; headers?: Record<string, string | string[] | undefined>; body?: any };

export type RecordOptions = {
  events: ReadonlySet<string>;
  ignoredUids: ReadonlySet<string>;
  maskedUids: ReadonlySet<string>;
};

export const buildRecordOptions = (config: AuditLogConfig): RecordOptions => ({
  events: new Set(DEFAULT_EVENTS.filter((event) => !config.excludedEvents.includes(event))),
  ignoredUids: new Set([...ALWAYS_IGNORED_ENTRY_UIDS, ...config.ignoredContentTypes]),
  maskedUids: new Set([...ALWAYS_MASKED_UIDS, ...config.maskedContentTypes]),
});

/**
 * Client IP. entry.* events may fire after the response is sent, when the socket may already be
 * closed: first the value captured early by the middleware, then the header, then Koa.
 */
const resolveIp = (state?: RequestState, request?: RequestLike): string | undefined => {
  if (state?.auditIp) return state.auditIp;
  const forwarded = request?.headers?.['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || request?.ip || undefined;
};

const fullName = (user?: AdminUser): string | undefined => {
  if (!user) return undefined;
  const name = [user.firstname, user.lastname].filter(Boolean).join(' ').trim();
  return name || user.username || undefined;
};

/**
 * Builds the row from the event name and payload. null means the event is not logged.
 * requestContext must be read synchronously: the event is emitted in the admin request's async chain.
 */
export const buildRecord = (
  strapi: Strapi,
  event: string,
  arg: unknown,
  options: RecordOptions
): AuditRecord | null => {
  if (!options.events.has(event)) return null;

  const ctx = strapi.requestContext.get() as { state?: RequestState; request?: RequestLike } | undefined;
  const state = ctx?.state;
  const isAdminRoute = state?.route?.info?.type === 'admin';
  const user = state?.user;

  // System changes (cron, scripts, public API) are out of scope; same rule as Strapi EE.
  if (!isAdminRoute) return null;
  if (!user && event !== 'admin.auth.error') return null;

  const base: AuditRecord = {
    action: event,
    userEmail: user?.email,
    userName: fullName(user),
    userId: user?.id,
    ip: resolveIp(state, ctx?.request),
  };

  const data = (arg ?? {}) as Record<string, any>;

  if (event.startsWith('entry.')) {
    const uid: string = data.uid;
    if (!uid || options.ignoredUids.has(uid)) return null;
    const entry = data.entry ?? {};
    const masked = options.maskedUids.has(uid);
    return {
      ...base,
      contentType: uid,
      targetDocumentId: entry.documentId,
      entryId: typeof entry.id === 'number' ? entry.id : undefined,
      entryLocale: entry.locale ?? undefined,
      label: pickLabel(entry, masked),
      payload: capPayload(compactEntry(strapi, uid, entry, masked)),
    };
  }

  if (event.startsWith('media.')) {
    const media = data.media ?? {};
    return {
      ...base,
      contentType: 'plugin::upload.file',
      targetDocumentId: media.documentId,
      entryId: typeof media.id === 'number' ? media.id : undefined,
      label: media.name,
      payload: capPayload({
        id: media.id,
        name: media.name,
        mime: media.mime,
        size: media.size,
        url: media.url,
        folderPath: media.folderPath,
        alternativeText: media.alternativeText,
        caption: media.caption,
      }),
    };
  }

  if (event.startsWith('media-folder.')) {
    const folder = data.folder ?? data.media ?? {};
    return {
      ...base,
      contentType: 'plugin::upload.folder',
      entryId: typeof folder.id === 'number' ? folder.id : undefined,
      label: folder.name,
      payload: capPayload({ id: folder.id, name: folder.name, path: folder.path }),
    };
  }

  if (event.startsWith('user.')) {
    const users = Array.isArray(data.users) ? data.users : [data.user].filter(Boolean);
    const summary = users.map((u: AdminUser & { isActive?: boolean; roles?: any[] }) => ({
      id: u.id,
      email: u.email,
      firstname: u.firstname,
      lastname: u.lastname,
      isActive: u.isActive,
      roles: Array.isArray(u.roles) ? u.roles.map((r) => (typeof r === 'object' ? r.name ?? r.id : r)) : undefined,
    }));
    return {
      ...base,
      contentType: 'admin::user',
      entryId: summary.length === 1 ? summary[0].id : undefined,
      label: summary.map((u: { email?: string }) => u.email).filter(Boolean).join(', ') || undefined,
      payload: capPayload(summary.length === 1 ? summary[0] : { users: summary }),
    };
  }

  if (event.startsWith('role.')) {
    const role = data.role ?? {};
    return {
      ...base,
      contentType: 'admin::role',
      entryId: typeof role.id === 'number' ? role.id : undefined,
      label: role.name,
      payload: capPayload({ id: role.id, name: role.name, code: role.code, description: role.description }),
    };
  }

  if (event.startsWith('permission.')) {
    const permissions = Array.isArray(data.permissions) ? data.permissions : [data.permission].filter(Boolean);
    return {
      ...base,
      contentType: 'admin::permission',
      label: `${permissions.length} permission`,
      payload: capPayload({
        count: permissions.length,
        actions: [...new Set(permissions.map((p: any) => p?.action).filter(Boolean))].slice(0, 100),
        roleIds: [...new Set(permissions.map((p: any) => p?.role?.id ?? p?.role).filter(Boolean))],
      }),
    };
  }

  if (event.startsWith('content-type.') || event.startsWith('component.')) {
    const model = data.contentType ?? data.component ?? {};
    return {
      ...base,
      contentType: model.uid,
      label: model.uid ?? model.info?.displayName,
      payload: capPayload({ uid: model.uid, kind: model.kind, displayName: model.info?.displayName }),
    };
  }

  if (event === 'admin.auth.success') {
    return { ...base, contentType: 'admin::user', entryId: user?.id, label: user?.email, payload: { provider: data.provider } };
  }

  if (event === 'admin.auth.error') {
    const attemptedEmail = typeof ctx?.request?.body?.email === 'string' ? ctx.request.body.email : undefined;
    return {
      ...base,
      userEmail: attemptedEmail,
      contentType: 'admin::user',
      label: attemptedEmail,
      payload: { provider: data.provider, error: data.error?.message ?? String(data.error ?? '') },
    };
  }

  if (event === 'admin.logout') {
    return { ...base, contentType: 'admin::user', entryId: user?.id, label: user?.email };
  }

  return { ...base, payload: capPayload(data) };
};

/**
 * eventHub subscription. The row is built synchronously, the DB write is not awaited:
 * nothing is added to the admin request's response time and a failure never affects the action.
 */
export const registerAuditLogSubscriber = (strapi: Strapi, options: RecordOptions): (() => void) => {
  // Capture the IP at request start: Koa request.ip can be empty once the socket closes.
  strapi.server.use(async (ctx, next) => {
    ctx.state.auditIp = ctx.request.ip;
    await next();
  });

  return strapi.eventHub.subscribe(async (event: string, ...args: unknown[]) => {
    let record: AuditRecord | null = null;
    try {
      record = buildRecord(strapi, event, args[0], options);
    } catch (err) {
      strapi.log.warn(`[AUDIT-LOG] build failed for ${event}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!record) return;

    // Deliberately not awaited: emit() awaits subscribers in turn, the DB write must not delay the request.
    const service = strapi.plugin(PLUGIN_ID).service('audit-log') as { record: (r: AuditRecord) => Promise<void> };
    void service.record(record).catch((err: unknown) => {
      strapi.log.error(`[AUDIT-LOG] write failed for ${event}: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
};
