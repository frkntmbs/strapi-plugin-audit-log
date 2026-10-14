/**
 * The part of the Strapi API this plugin uses. Not importing @strapi/strapi types is deliberate:
 * the peer range is wide (5.26+) and building the package should not require Strapi.
 */
export type Strapi = {
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  config: { get: <T = unknown>(path: string, defaultValue?: T) => T };
  db: {
    connection: any;
    config: { connection: { client: string } };
    query: (uid: string) => any;
    lifecycles: { subscribe: (subscriber: Record<string, unknown>) => void };
  };
  store: {
    get: (params: { type: string; key: string }) => Promise<unknown>;
    set: (params: { type: string; key: string; value: unknown }) => Promise<void>;
  };
  eventHub: { subscribe: (fn: (event: string, ...args: unknown[]) => unknown) => () => void };
  requestContext: { get: () => unknown };
  server: { use: (middleware: (ctx: any, next: () => Promise<void>) => Promise<void>) => void };
  cron: { add: (tasks: Record<string, unknown>) => void; remove?: (name: string) => void };
  hook: (name: string) => { register: (fn: (...args: unknown[]) => unknown) => void };
  getModel: (uid: string) => { attributes?: Record<string, unknown> } | undefined;
  plugin: (name: string) => { service: (name: string) => any; config: <T = unknown>(path: string) => T };
};

export type AuditRecord = {
  action: string;
  userEmail?: string;
  userName?: string;
  userId?: number;
  label?: string;
  contentType?: string;
  targetDocumentId?: string;
  entryId?: number;
  entryLocale?: string;
  ip?: string;
  payload?: unknown;
};

export type ExportFilters = {
  from: Date;
  to: Date;
  action?: string;
  userEmail?: string;
  contentType?: string;
};

export type ExportCsvResult = { tooLarge: true } | { stream: NodeJS.ReadableStream; filename: string };
