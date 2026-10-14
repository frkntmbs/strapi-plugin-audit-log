import config, { type AuditLogConfig } from './config';
import contentTypes from './content-types';
import auditLogController from './controllers/audit-log';
import { PLUGIN_ID } from './lib/constants';
import { describeDbError, guardAuditLogLifecycles, hardenAuditLogTable, persistAuditLogTable } from './lib/protect';
import { applyContentManagerLayout, assertTableIsOurs, scheduleRetention } from './lib/setup';
import { buildRecordOptions, registerAuditLogSubscriber } from './lib/subscriber';
import type { Strapi } from './lib/types';
import routes from './routes';
import auditLogService from './services/audit-log';

const readConfig = (strapi: Strapi): AuditLogConfig => strapi.config.get<AuditLogConfig>(`plugin::${PLUGIN_ID}`);

let cleanups: Array<() => void> = [];

export default {
  config,
  contentTypes,
  controllers: { 'audit-log': auditLogController },
  services: { 'audit-log': auditLogService },
  routes,

  register({ strapi }: { strapi: Strapi }) {
    // Before schema sync: stop without touching a foreign audit_logs table.
    strapi.hook('strapi::content-types.beforeSync').register(() => assertTableIsOurs(strapi));

    const settings = readConfig(strapi);
    if (!settings.enabled) {
      strapi.log.warn('[AUDIT-LOG] disabled by config, admin actions are not recorded');
      return;
    }

    cleanups.push(registerAuditLogSubscriber(strapi, buildRecordOptions(settings)));
    strapi.log.info('[AUDIT-LOG] subscriber registered');
  },

  async bootstrap({ strapi }: { strapi: Strapi }) {
    const settings = readConfig(strapi);

    // Table protection runs even when disabled, so existing rows are never dropped.
    try {
      await persistAuditLogTable(strapi);
    } catch (err) {
      strapi.log.error(`[AUDIT-LOG] persisting table failed: ${describeDbError(err)}`);
    }
    try {
      await hardenAuditLogTable(strapi, settings.appendOnly);
    } catch (err) {
      strapi.log.error(`[AUDIT-LOG] hardening failed: ${describeDbError(err)}`);
    }
    if (settings.appendOnly) {
      guardAuditLogLifecycles(strapi);
    }
    try {
      await applyContentManagerLayout(strapi);
    } catch (err) {
      strapi.log.warn(`[AUDIT-LOG] Content Manager layout not applied: ${describeDbError(err)}`);
    }

    if (settings.enabled && settings.retentionCron !== false) {
      cleanups.push(scheduleRetention(strapi, settings.retentionCron));
    }
  },

  destroy() {
    cleanups.forEach((cleanup) => cleanup());
    cleanups = [];
  },
};
