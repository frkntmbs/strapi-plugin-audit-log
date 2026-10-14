import { DEFAULT_EVENTS, MIN_RETENTION_DAYS } from './lib/constants';

export type AuditLogConfig = {
  /** false → nothing is recorded and retention does not run; the table and existing rows stay. */
  enabled: boolean;
  /** Rows older than this many days are purged. At least MIN_RETENTION_DAYS. */
  retentionDays: number;
  /** Retention schedule when server.cron is enabled; false → never purge. */
  retentionCron: string | false;
  /** Types holding personal data: only identifiers and changed field names are stored. */
  maskedContentTypes: string[];
  /** Content types that are never logged (entry.* events). */
  ignoredContentTypes: string[];
  /** Events removed from the default list (e.g. 'admin.auth.success'). */
  excludedEvents: string[];
  /** Database triggers on Postgres / MySQL that reject UPDATE and DELETE. */
  appendOnly: boolean;
  /** Also writes each row to stdout as [AUDIT] {...}. */
  logToStdout: boolean;
};

type Env = {
  bool: (key: string, defaultValue: boolean) => boolean;
  int: (key: string, defaultValue: number) => number;
  array: (key: string, defaultValue: string[]) => string[];
};

/**
 * Defaults come from env so the plugin works without config/plugins.ts.
 * Values given in config/plugins.ts override them.
 */
const defaults = ({ env }: { env: Env }): AuditLogConfig => ({
  enabled: env.bool('AUDIT_LOG_ENABLED', true),
  retentionDays: env.int('AUDIT_LOG_RETENTION_DAYS', 365),
  retentionCron: '15 3 * * *',
  maskedContentTypes: env.array('AUDIT_LOG_MASKED_CONTENT_TYPES', []),
  ignoredContentTypes: [],
  excludedEvents: [],
  appendOnly: env.bool('AUDIT_LOG_APPEND_ONLY', true),
  logToStdout: true,
});

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const validator = (config: AuditLogConfig): void => {
  if (typeof config.enabled !== 'boolean') {
    throw new Error('[audit-log] enabled must be a boolean');
  }
  if (!Number.isInteger(config.retentionDays) || config.retentionDays < MIN_RETENTION_DAYS) {
    // A wrong env value (e.g. 1) must not purge nearly the whole log.
    throw new Error(`[audit-log] retentionDays must be an integer >= ${MIN_RETENTION_DAYS}`);
  }
  if (config.retentionCron !== false && (typeof config.retentionCron !== 'string' || !config.retentionCron.trim())) {
    throw new Error('[audit-log] retentionCron must be a cron expression or false');
  }
  for (const key of ['maskedContentTypes', 'ignoredContentTypes', 'excludedEvents'] as const) {
    if (!isStringArray(config[key])) {
      throw new Error(`[audit-log] ${key} must be an array of strings`);
    }
  }
  const unknownEvents = config.excludedEvents.filter((event) => !DEFAULT_EVENTS.includes(event));
  if (unknownEvents.length) {
    throw new Error(`[audit-log] excludedEvents contains unknown events: ${unknownEvents.join(', ')}`);
  }
  for (const key of ['appendOnly', 'logToStdout'] as const) {
    if (typeof config[key] !== 'boolean') {
      throw new Error(`[audit-log] ${key} must be a boolean`);
    }
  }
};

export default { default: defaults, validator };
