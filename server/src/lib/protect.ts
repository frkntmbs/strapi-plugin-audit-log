import {
  AUDIT_LOG_TABLE,
  AUDIT_LOG_UID,
  MYSQL_PURGE_VARIABLE,
  MYSQL_TRIGGER_VERSION,
  PG_PURGE_SESSION_FLAG,
  PURGE_BATCH_SIZE,
} from './constants';
import type { Strapi } from './types';
import { isAuditWriter } from './write-scope';

export type Dialect = 'postgres' | 'mysql' | 'sqlite' | 'other';

export const getDialect = (strapi: Strapi): Dialect => {
  const client = strapi.db.config.connection.client;
  if (client === 'postgres' || client === 'pg') return 'postgres';
  if (client === 'mysql' || client === 'mysql2') return 'mysql';
  if (client === 'sqlite' || client === 'better-sqlite3' || client === 'sqlite3') return 'sqlite';
  return 'other';
};

const INDEXED_COLUMNS = ['created_at', 'action', 'user_email', 'content_type'] as const;

const PG_TRIGGER_NAME = `${AUDIT_LOG_TABLE}_protect_trg`;
const PG_FUNCTION_NAME = `${AUDIT_LOG_TABLE}_protect`;

const MYSQL_TRIGGER_PREFIX = `${AUDIT_LOG_TABLE}_protect_`;
const mysqlTriggerNames = {
  update: `${MYSQL_TRIGGER_PREFIX}update_v${MYSQL_TRIGGER_VERSION}`,
  delete: `${MYSQL_TRIGGER_PREFIX}delete_v${MYSQL_TRIGGER_VERSION}`,
};

/** Trigger error message; points to the docs when a bulk delete such as strapi import hits it. */
const blockedMessage = (op: string) =>
  `${AUDIT_LOG_TABLE} is append-only: ${op} is not allowed (strapi import: see strapi-plugin-audit-log README)`;

/** "Already exists" errors raised when instances booting in parallel create the same object. */
const isAlreadyExistsError = (err: unknown): boolean => {
  const { code, errno } = (err ?? {}) as { code?: string; errno?: number };
  return code === '42710' || code === '42P07' || code === '23505' || errno === 1359 || errno === 1061;
};

/** knex.raw returns a different shape per dialect. */
const rawRows = (result: any): any[] => {
  if (Array.isArray(result)) return Array.isArray(result[0]) ? result[0] : result;
  return result?.rows ?? [];
};

const ignoreAlreadyExists = async (fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
  } catch (err) {
    if (!isAlreadyExistsError(err)) throw err;
  }
};

const ensureIndexes = async (knex: any, dialect: Dialect): Promise<void> => {
  for (const column of INDEXED_COLUMNS) {
    const name = `${AUDIT_LOG_TABLE}_${column}_idx`;
    if (dialect === 'mysql') {
      // MySQL has no CREATE INDEX IF NOT EXISTS.
      const existing = rawRows(
        await knex.raw(
          'SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1',
          [AUDIT_LOG_TABLE, name]
        )
      );
      if (!existing.length) {
        await ignoreAlreadyExists(() => knex.raw(`CREATE INDEX ${name} ON ${AUDIT_LOG_TABLE} (${column})`));
      }
    } else {
      await ignoreAlreadyExists(() => knex.raw(`CREATE INDEX IF NOT EXISTS ${name} ON ${AUDIT_LOG_TABLE} (${column})`));
    }
  }
};

const postgresTriggerExists = async (knex: any): Promise<boolean> =>
  rawRows(
    await knex.raw(
      'SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = ? AND c.relname = ? LIMIT 1',
      [PG_TRIGGER_NAME, AUDIT_LOG_TABLE]
    )
  ).length > 0;

/**
 * The function is replaced on every startup (atomic); the trigger is created only when missing:
 * there is no unprotected window between DROP and CREATE, and parallel startups do not collide.
 */
const installPostgresTrigger = async (knex: any): Promise<boolean> => {
  try {
    await knex.raw(`
      CREATE OR REPLACE FUNCTION ${PG_FUNCTION_NAME}() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND current_setting('${PG_PURGE_SESSION_FLAG}', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION '${blockedMessage('%')}', TG_OP
          USING ERRCODE = 'insufficient_privilege';
      END;
      $$ LANGUAGE plpgsql;
    `);
  } catch (err) {
    // Parallel startups may hit "tuple concurrently updated"; continue if the function exists.
    const exists = rawRows(await knex.raw('SELECT 1 FROM pg_proc WHERE proname = ? LIMIT 1', [PG_FUNCTION_NAME]));
    if (!exists.length) throw err;
  }

  if (await postgresTriggerExists(knex)) return false;

  await ignoreAlreadyExists(() =>
    knex.raw(`
      CREATE TRIGGER ${PG_TRIGGER_NAME}
      BEFORE UPDATE OR DELETE ON ${AUDIT_LOG_TABLE}
      FOR EACH ROW EXECUTE FUNCTION ${PG_FUNCTION_NAME}()
    `)
  );
  return true;
};

const dropPostgresTrigger = async (knex: any): Promise<boolean> => {
  const existed = await postgresTriggerExists(knex);
  await knex.raw(`DROP TRIGGER IF EXISTS ${PG_TRIGGER_NAME} ON ${AUDIT_LOG_TABLE}`);
  return existed;
};

const listMysqlTriggers = async (knex: any): Promise<string[]> => {
  const rows = rawRows(
    await knex.raw(
      'SELECT trigger_name AS name FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND event_object_table = ?',
      [AUDIT_LOG_TABLE]
    )
  );
  return rows
    .map((row: any) => String(row.name ?? row.NAME ?? row.TRIGGER_NAME))
    .filter((name: string) => name.startsWith(MYSQL_TRIGGER_PREFIX));
};

/**
 * MySQL: created only when missing. With binary logging on, CREATE TRIGGER may require SUPER or
 * log_bin_trust_function_creators=1, so triggers are not recreated on every startup.
 * Outdated trigger versions are dropped after the new ones are in place.
 */
const installMysqlTriggers = async (knex: any): Promise<boolean> => {
  const existing = await listMysqlTriggers(knex);
  const wanted = Object.values(mysqlTriggerNames);

  let installed = false;
  if (!existing.includes(mysqlTriggerNames.update)) {
    await ignoreAlreadyExists(() =>
      knex.raw(`
        CREATE TRIGGER ${mysqlTriggerNames.update} BEFORE UPDATE ON ${AUDIT_LOG_TABLE}
        FOR EACH ROW
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${blockedMessage('UPDATE')}'
      `)
    );
    installed = true;
  }
  if (!existing.includes(mysqlTriggerNames.delete)) {
    await ignoreAlreadyExists(() =>
      knex.raw(`
        CREATE TRIGGER ${mysqlTriggerNames.delete} BEFORE DELETE ON ${AUDIT_LOG_TABLE}
        FOR EACH ROW
        BEGIN
          IF COALESCE(${MYSQL_PURGE_VARIABLE}, 0) <> 1 THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${blockedMessage('DELETE')}';
          END IF;
        END
      `)
    );
    installed = true;
  }

  for (const name of existing.filter((n) => !wanted.includes(n))) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${name}`);
  }
  return installed;
};

const dropMysqlTriggers = async (knex: any): Promise<boolean> => {
  const existing = await listMysqlTriggers(knex);
  for (const name of existing) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${name}`);
  }
  return existing.length > 0;
};

const forbiddenError = (message: string): Error => {
  try {
    // Strapi's own error class shows up in the admin panel as a 403 with a readable message, not a 500.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { errors } = require('@strapi/utils');
    return new errors.ForbiddenError(message);
  } catch {
    return new Error(message);
  }
};

/**
 * Second, application-level layer on every dialect:
 * - update / delete: never possible through Strapi (admin panel, service code).
 * - create: only the plugin writes rows; no forged entries from the Content Manager.
 * Retention deletes through knex directly, so it is not affected by lifecycles.
 * strapi import / transfer disable lifecycles, so this layer does not affect them.
 */
export const guardAuditLogLifecycles = (strapi: Strapi): void => {
  const rejectChange = () => {
    throw forbiddenError('Audit log entries cannot be modified or deleted.');
  };
  const rejectForeignCreate = () => {
    if (!isAuditWriter()) {
      throw forbiddenError('Audit log entries cannot be created manually.');
    }
  };
  strapi.db.lifecycles.subscribe({
    models: [AUDIT_LOG_UID],
    beforeCreate: rejectForeignCreate,
    beforeCreateMany: rejectForeignCreate,
    beforeUpdate: rejectChange,
    beforeUpdateMany: rejectChange,
    beforeDelete: rejectChange,
    beforeDeleteMany: rejectChange,
  });
};

/** DB errors may have an empty message (mysql2); include sqlMessage and the code. */
export const describeDbError = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);
  const { code, errno, sqlMessage } = err as Error & { code?: string; errno?: number; sqlMessage?: string };
  const text = sqlMessage || err.message || 'unknown error';
  return code ? `${text} (${code}${errno ? ` ${errno}` : ''})` : text;
};

const MYSQL_TRIGGER_PRIVILEGE_ERRNO = 1419;

export const isMysqlTriggerPrivilegeError = (err: unknown): boolean =>
  (err as { errno?: number })?.errno === MYSQL_TRIGGER_PRIVILEGE_ERRNO;

/**
 * If the plugin is removed or disabled, Strapi's schema sync would DROP the table.
 * Adding it to persisted_tables (what Strapi EE uses for its own audit log table) prevents that.
 */
export const persistAuditLogTable = async (strapi: Strapi): Promise<void> => {
  const current = ((await strapi.store.get({ type: 'core', key: 'persisted_tables' })) ?? []) as Array<
    string | { name: string }
  >;
  const names = current.map((table) => (typeof table === 'string' ? table : table.name));
  if (names.includes(AUDIT_LOG_TABLE)) return;

  await strapi.store.set({
    type: 'core',
    key: 'persisted_tables',
    value: [...current, { name: AUDIT_LOG_TABLE }],
  });
  strapi.log.info(`[AUDIT-LOG] ${AUDIT_LOG_TABLE} added to persisted tables`);
};

/**
 * Database-level protection and indexes. Idempotent, runs on every startup.
 *
 * Postgres / MySQL: a trigger on audit_logs rejecting UPDATE and DELETE.
 * Nobody, super admins included, can modify or delete rows from the admin panel;
 * only the retention job (via a session flag) can delete old rows.
 * ALTER/TRUNCATE/DROP are not affected, so Strapi's schema sync keeps working.
 */
export const hardenAuditLogTable = async (strapi: Strapi, appendOnly: boolean): Promise<void> => {
  const knex = strapi.db.connection;
  const dialect = getDialect(strapi);

  const hasTable = await knex.schema.hasTable(AUDIT_LOG_TABLE);
  if (!hasTable) {
    strapi.log.warn(`[AUDIT-LOG] table ${AUDIT_LOG_TABLE} not found, skipping hardening`);
    return;
  }

  await ensureIndexes(knex, dialect);

  if (dialect !== 'postgres' && dialect !== 'mysql') {
    strapi.log.info(`[AUDIT-LOG] append-only trigger skipped (client: ${strapi.db.config.connection.client})`);
    return;
  }

  if (!appendOnly) {
    const dropped = dialect === 'postgres' ? await dropPostgresTrigger(knex) : await dropMysqlTriggers(knex);
    if (dropped) strapi.log.warn('[AUDIT-LOG] appendOnly disabled, append-only trigger removed');
    return;
  }

  if (dialect === 'postgres') {
    const installed = await installPostgresTrigger(knex);
    strapi.log.info(`[AUDIT-LOG] append-only trigger ${installed ? 'installed' : 'already present'}`);
    return;
  }

  try {
    const installed = await installMysqlTriggers(knex);
    strapi.log.info(`[AUDIT-LOG] append-only triggers ${installed ? 'installed' : 'already present'}`);
  } catch (err) {
    if (!isMysqlTriggerPrivilegeError(err)) throw err;
    strapi.log.warn(
      '[AUDIT-LOG] MySQL append-only trigger could not be installed: binary logging is on and the DB user ' +
        'has no SUPER privilege. Set log_bin_trust_function_creators=ON (Azure: server parameters) and restart. ' +
        'Until then only the application-level guard protects audit_logs.'
    );
  }
};

/**
 * Retention delete: in batches, each in its own short transaction,
 * so large backlogs never hold long locks.
 * The MySQL user variable sticks to the connection, so it is reset before the connection returns to the pool.
 */
export const deleteOlderThan = async (strapi: Strapi, cutoff: Date): Promise<number> => {
  const dialect = getDialect(strapi);
  let total = 0;

  while (true) {
    const deleted: number = await strapi.db.connection.transaction(async (trx: any) => {
      if (dialect === 'postgres') {
        await trx.raw(`SET LOCAL ${PG_PURGE_SESSION_FLAG} = 'on'`);
      }
      if (dialect === 'mysql') {
        await trx.raw(`SET ${MYSQL_PURGE_VARIABLE} = 1`);
      }
      try {
        const ids: number[] = (
          await trx(AUDIT_LOG_TABLE).select('id').where('created_at', '<', cutoff).orderBy('id').limit(PURGE_BATCH_SIZE)
        ).map((row: { id: number }) => row.id);
        if (!ids.length) return 0;
        const count = await trx(AUDIT_LOG_TABLE).whereIn('id', ids).delete();
        return Number(count) || 0;
      } finally {
        if (dialect === 'mysql') {
          await trx.raw(`SET ${MYSQL_PURGE_VARIABLE} = NULL`);
        }
      }
    });

    total += deleted;
    if (deleted < PURGE_BATCH_SIZE) return total;
  }
};
