/**
 * Rows are written with strapi.db.query: it bypasses the Document Service, so it
 * does not emit its own entry.create event (no loop) and is lighter.
 */
import { Readable } from 'node:stream';
import type { AuditLogConfig } from '../config';
import { AUDIT_LOG_UID, EXPORT_PAGE_SIZE, MAX_EXPORT_ROWS, PLUGIN_ID } from '../lib/constants';
import { CSV_HEADER, toCsvRow } from '../lib/csv';
import { deleteOlderThan } from '../lib/protect';
import type { AuditRecord, ExportCsvResult, ExportFilters, Strapi } from '../lib/types';
import { runAsAuditWriter } from '../lib/write-scope';

export default ({ strapi }: { strapi: Strapi }) => {
  const config = <K extends keyof AuditLogConfig>(key: K): AuditLogConfig[K] =>
    strapi.plugin(PLUGIN_ID).config<AuditLogConfig[K]>(key);

  return {
    async record(entry: AuditRecord): Promise<void> {
      const { payload, ...rest } = entry;
      await runAsAuditWriter(() =>
        strapi.db.query(AUDIT_LOG_UID).create({
          data: { ...rest, payload: payload ?? null },
        })
      );

      if (!config('logToStdout')) return;

      // Second copy: container stdout → central logging. A trace remains even if the DB row is lost.
      strapi.log.info(
        `[AUDIT] ${JSON.stringify({
          action: rest.action,
          user: rest.userEmail,
          contentType: rest.contentType,
          documentId: rest.targetDocumentId,
          entryId: rest.entryId,
          locale: rest.entryLocale,
          label: rest.label,
          ip: rest.ip,
        })}`
      );
    },

    /**
     * The CSV is produced page by page and streamed; 100,000 rows are never buffered in memory.
     * The row count is checked first; nothing starts if the limit is exceeded.
     */
    async exportCsv(filters: ExportFilters): Promise<ExportCsvResult> {
      const where: Record<string, unknown> = {
        createdAt: { $gte: filters.from, $lte: filters.to },
      };
      if (filters.action) where.action = filters.action;
      if (filters.userEmail) where.userEmail = filters.userEmail;
      if (filters.contentType) where.contentType = filters.contentType;

      const total = await strapi.db.query(AUDIT_LOG_UID).count({ where });
      if (total > MAX_EXPORT_ROWS) {
        return { tooLarge: true };
      }

      async function* rows() {
        yield '﻿' + CSV_HEADER + '\r\n';
        let lastId = 0;
        while (true) {
          // Keyset pagination on id: faster than offset, and rows added during the export do not shift pages.
          const page: Record<string, unknown>[] = await strapi.db.query(AUDIT_LOG_UID).findMany({
            where: { ...where, id: { $gt: lastId } },
            orderBy: [{ id: 'asc' as const }],
            limit: EXPORT_PAGE_SIZE,
          });
          if (!page.length) return;
          yield page.map((row) => toCsvRow(row) + '\r\n').join('');
          lastId = Number(page[page.length - 1].id);
          if (page.length < EXPORT_PAGE_SIZE) return;
        }
      }

      const today = new Date().toISOString().slice(0, 10);
      return { stream: Readable.from(rows()), filename: `audit-log_${today}.csv` };
    },

    /** Retention: deletes only old rows of audit_logs, never app content. */
    async purgeExpired(): Promise<number> {
      const retentionDays = config('retentionDays');
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      const deleted = await deleteOlderThan(strapi, cutoff);

      if (deleted > 0) {
        strapi.log.info(`[AUDIT-LOG] purged ${deleted} rows older than ${retentionDays} days`);
      }
      return deleted;
    },
  };
};
