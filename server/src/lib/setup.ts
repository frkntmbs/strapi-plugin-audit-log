import { AUDIT_LOG_TABLE, AUDIT_LOG_UID, PLUGIN_ID, RETENTION_CRON_NAME, RETENTION_FALLBACK_INTERVAL_MS } from './constants';
import { describeDbError } from './protect';
import type { Strapi } from './types';

const CORE_STORE_TABLE = 'strapi_core_store_settings';
const SCHEMA_TABLE = 'strapi_database_schema';

const parseJson = (value: unknown): any => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

/** Tables recorded by Strapi's last schema sync. */
const trackedTables = async (knex: any): Promise<string[]> => {
  if (!(await knex.schema.hasTable(SCHEMA_TABLE))) return [];
  const row = await knex(SCHEMA_TABLE).select('schema').orderBy('id', 'desc').first();
  const schema = parseJson(row?.schema);
  return Array.isArray(schema?.tables) ? schema.tables.map((t: { name: string }) => t.name) : [];
};

const persistedTables = async (knex: any): Promise<string[]> => {
  if (!(await knex.schema.hasTable(CORE_STORE_TABLE))) return [];
  const row = await knex(CORE_STORE_TABLE).select('value').where('key', 'core_persisted_tables').first();
  const value = parseJson(row?.value);
  return Array.isArray(value) ? value.map((t: string | { name: string }) => (typeof t === 'string' ? t : t.name)) : [];
};

/**
 * Runs right before schema sync. If the database has an audit_logs table that Strapi does not manage
 * (an unrelated table of the app), startup stops: the sync would alter its columns and retention
 * would delete its rows. A table Strapi already managed (e.g. a previous in-app api::audit-log
 * content type, or this plugin after being disabled and re-enabled) is adopted as is.
 */
export const assertTableIsOurs = async (strapi: Strapi): Promise<void> => {
  const knex = strapi.db.connection;
  if (!(await knex.schema.hasTable(AUDIT_LOG_TABLE))) return;

  const [tracked, persisted] = await Promise.all([trackedTables(knex), persistedTables(knex)]);
  if (tracked.includes(AUDIT_LOG_TABLE) || persisted.includes(AUDIT_LOG_TABLE)) return;

  throw new Error(
    `[audit-log] A table named "${AUDIT_LOG_TABLE}" already exists and is not managed by Strapi. ` +
      'Startup stopped before any schema change so its data is not altered. ' +
      'Rename or move that table, or uninstall @frkntmbs/strapi-plugin-audit-log.'
  );
};

const LIST_LAYOUT = ['id', 'createdAt', 'action', 'userEmail', 'contentType', 'label', 'ip'];
const LAYOUT_FLAG = 'content-manager-layout-v1';

/**
 * Content Manager list view: newest first, readable columns. Applied once on first install;
 * later changes made in the admin panel are never overwritten.
 */
export const applyContentManagerLayout = async (strapi: Strapi): Promise<void> => {
  const store = strapi.store as unknown as {
    get: (p: { type: string; name: string; key: string }) => Promise<unknown>;
    set: (p: { type: string; name: string; key: string; value: unknown }) => Promise<void>;
  };
  const flag = { type: 'plugin', name: PLUGIN_ID, key: LAYOUT_FLAG };
  if (await store.get(flag)) return;

  const service = (strapi.plugin('content-manager') as { service?: (n: string) => unknown } | undefined)?.service?.(
    'content-types'
  ) as
    | {
        findConfiguration: (ct: { uid: string }) => Promise<any>;
        updateConfiguration: (ct: { uid: string }, config: unknown) => Promise<unknown>;
      }
    | undefined;
  if (!service) return;

  const contentType = { uid: AUDIT_LOG_UID };
  const current = await service.findConfiguration(contentType);
  // If the Content Manager has not created its default configuration yet, retry on next startup.
  if (!current?.layouts?.list) return;

  await service.updateConfiguration(contentType, {
    settings: { ...current.settings, defaultSortBy: 'createdAt', defaultSortOrder: 'DESC', mainField: 'action' },
    metadatas: current.metadatas,
    layouts: { ...current.layouts, list: LIST_LAYOUT },
  });
  await store.set({ ...flag, value: true });
  strapi.log.info('[AUDIT-LOG] Content Manager list view configured');
};

/**
 * Retention: registered with Strapi cron when server.cron is enabled; otherwise it runs on
 * an internal timer every few hours, without requiring any app change.
 */
export const scheduleRetention = (strapi: Strapi, rule: string): (() => void) => {
  const run = async () => {
    try {
      await strapi.plugin(PLUGIN_ID).service('audit-log').purgeExpired();
    } catch (err) {
      strapi.log.error(`[AUDIT-LOG] retention purge failed: ${describeDbError(err)}`);
    }
  };

  if (strapi.config.get<boolean>('server.cron.enabled', false)) {
    strapi.cron.add({ [RETENTION_CRON_NAME]: { task: run, options: { rule } } });
    return () => strapi.cron.remove?.(RETENTION_CRON_NAME);
  }

  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, RETENTION_FALLBACK_INTERVAL_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
};
