export const PLUGIN_ID = 'audit-log' as const;
export const AUDIT_LOG_UID = 'plugin::audit-log.audit-log' as const;
export const AUDIT_LOG_TABLE = 'audit_logs' as const;

/** Postgres session setting the retention job uses to lift the DELETE ban for its own transaction. */
export const PG_PURGE_SESSION_FLAG = 'app.audit_log_purge' as const;
/** MySQL user variable with the same purpose, scoped to the connection. */
export const MYSQL_PURGE_VARIABLE = '@audit_log_purge' as const;

/** Bump when the trigger body changes; outdated triggers are replaced on startup. */
export const MYSQL_TRIGGER_VERSION = 1 as const;

export const RETENTION_CRON_NAME = 'auditLogRetention' as const;
/** Retention interval for apps that run with server.cron disabled. */
export const RETENTION_FALLBACK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Lower bound so a misconfigured value cannot wipe almost the whole log. */
export const MIN_RETENTION_DAYS = 30;

/**
 * Types logged through media.* events instead of entry.* events.
 * Strapi's own Enterprise audit log skips them for the same reason.
 */
export const ALWAYS_IGNORED_ENTRY_UIDS: readonly string[] = [
  AUDIT_LOG_UID,
  'plugin::upload.file',
  'plugin::upload.folder',
];

/** Always masked: end-user personal data. */
export const ALWAYS_MASKED_UIDS: readonly string[] = ['plugin::users-permissions.user'];

/** Recorded events: the Strapi Enterprise Audit Logs set plus draft-discard and failed logins. */
export const DEFAULT_EVENTS: readonly string[] = [
  'entry.create',
  'entry.update',
  'entry.delete',
  'entry.publish',
  'entry.unpublish',
  'entry.draft-discard',
  'media.create',
  'media.update',
  'media.delete',
  'media-folder.create',
  'media-folder.update',
  'media-folder.delete',
  'user.create',
  'user.update',
  'user.delete',
  'role.create',
  'role.update',
  'role.delete',
  'permission.create',
  'permission.update',
  'permission.delete',
  'content-type.create',
  'content-type.update',
  'content-type.delete',
  'component.create',
  'component.update',
  'component.delete',
  'admin.auth.success',
  'admin.auth.error',
  'admin.logout',
];

export const MAX_TEXT_LENGTH = 500;
export const MAX_ARRAY_ITEMS = 25;
export const MAX_PAYLOAD_BYTES = 32 * 1024;

export const MAX_EXPORT_ROWS = 100_000;
export const EXPORT_PAGE_SIZE = 1_000;
export const PURGE_BATCH_SIZE = 5_000;
