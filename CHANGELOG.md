# Changelog

## 1.0.0

First release.

- Records admin panel actions from `eventHub`: content, media, users, roles, permissions, content types, logins and logouts
- Append-only `audit_logs` table: Postgres and MySQL triggers, plus a Strapi lifecycle guard on every dialect
- Only the plugin can create entries; nothing can update or delete them through Strapi
- One-step install: no `config/plugins.ts` needed, settings from `AUDIT_LOG_*` env variables
- Retention with a 30-day minimum, in batches; runs on an internal timer when `server.cron` is disabled
- Streamed CSV export
- Content Manager list view configured on first install
- Table registered in `persisted_tables`, so uninstalling never drops it
- Startup stops before schema sync if an unmanaged `audit_logs` table already exists
- `plugin::users-permissions.user` always masked
- Tested end to end on Strapi 5.26 and 5.57 with Postgres 16 and MySQL 8
