import { MAX_EXPORT_ROWS, PLUGIN_ID } from '../lib/constants';
import type { ExportCsvResult, ExportFilters, Strapi } from '../lib/types';

type Ctx = {
  query: Record<string, unknown>;
  status: number;
  body: unknown;
  set: (key: string, value: string) => void;
};

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export default ({ strapi }: { strapi: Strapi }) => ({
  async exportCsv(ctx: Ctx) {
    const from = asString(ctx.query.from);
    const to = asString(ctx.query.to);

    if (!from || !to) {
      ctx.status = 400;
      ctx.body = { error: 'from and to are required (ISO date).' };
      return;
    }

    const fromDate = new Date(from);
    const toDate = /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(to + 'T23:59:59.999Z') : new Date(to);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      ctx.status = 400;
      ctx.body = { error: 'from and to must be valid ISO dates.' };
      return;
    }

    const filters: ExportFilters = { from: fromDate, to: toDate };
    const action = asString(ctx.query.action);
    const userEmail = asString(ctx.query.userEmail);
    const contentType = asString(ctx.query.contentType);
    if (action) filters.action = action;
    if (userEmail) filters.userEmail = userEmail;
    if (contentType) filters.contentType = contentType;

    const service = strapi.plugin(PLUGIN_ID).service('audit-log') as {
      exportCsv: (f: ExportFilters) => Promise<ExportCsvResult>;
    };
    const result = await service.exportCsv(filters);

    if ('tooLarge' in result) {
      ctx.status = 400;
      ctx.body = {
        error: `The result exceeds ${MAX_EXPORT_ROWS.toLocaleString('en-US')} rows. Narrow the date range.`,
      };
      return;
    }

    ctx.status = 200;
    ctx.set('Content-Type', 'text/csv; charset=utf-8');
    ctx.set('Content-Disposition', `attachment; filename="${result.filename}"`);
    ctx.body = result.stream;
  },
});
