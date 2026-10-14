# strapi-plugin-audit-log

Append-only admin audit log for **Strapi 5 Community Edition**: who did what, and when, in the admin panel.

It listens to the same `eventHub` events as Strapi Enterprise's Audit Logs and stores them in a table that
nobody can edit or delete from, super admins included.

- Content: create, update, delete, publish, unpublish, discard draft
- Media library files and folders
- Admin users, roles and permissions
- Content-Type Builder changes
- Successful and failed logins, logouts
- CSV export
- Retention: old entries are purged automatically (default 365 days)

Requires Strapi **5.26+** and Node 20+. Works with Postgres, MySQL 8 and SQLite. Strapi 4 is not supported.

## Install

```bash
npm install @frkntmbs/strapi-plugin-audit-log
```

That's it. Strapi picks the plugin up automatically. On startup it creates the table, the protections,
the retention job and the Content Manager list view (newest first). No `config/plugins.ts`, no cron
setting, nothing to click in the admin panel.

Entries appear under **Content Manager → Audit Log** and are visible to super admins only. To show them
to another role: *Settings → Roles → Audit Log → Read*.

## Configuration

The defaults fit most apps. Use environment variables to change them:

| Env | Default | Description |
|---|---|---|
| `AUDIT_LOG_ENABLED` | `true` | `false` stops recording. The table and existing entries are kept. |
| `AUDIT_LOG_RETENTION_DAYS` | `365` | Entries older than this are purged. Minimum 30. |
| `AUDIT_LOG_MASKED_CONTENT_TYPES` | – | Comma-separated content types holding personal data, e.g. `api::contact.contact,api::order.order`. Only ids and the names of changed fields are stored. `plugin::users-permissions.user` is always masked. |
| `AUDIT_LOG_APPEND_ONLY` | `true` | Tamper protection. Only turn it off for `strapi import`, see below. |

For finer control use `config/plugins.ts`. Set a value in one place only; lists given both via env and in
the file are merged.

```ts
export default () => ({
  'audit-log': {
    config: {
      ignoredContentTypes: ['api::view-counter.view-counter'], // never logged
      excludedEvents: ['admin.auth.success'],                  // skip successful logins
      retentionCron: '15 3 * * *',                             // false = never purge
      logToStdout: true,                                       // also print [AUDIT] {...} lines
    },
  },
});
```

### MySQL

On MySQL with binary logging enabled (the default on most managed services, e.g. Azure Database for MySQL,
AWS RDS), creating triggers requires the server parameter `log_bin_trust_function_creators = ON`. Without it
Strapi logs a warning at startup and only the application-level protection is active; recording is not
affected. Once the parameter is on, restart Strapi and the triggers are installed automatically.

## What gets recorded

| Column | Content |
|---|---|
| `action` | Event name (`entry.update`, `media.delete`, `admin.auth.error`, ...) |
| `userEmail` / `userName` / `userId` | The admin who acted (for failed logins: the email that was tried) |
| `label` | Readable label: title, file name, email, role name |
| `contentType` | `api::article.article`, `plugin::upload.file`, `admin::user`, ... |
| `targetDocumentId` / `entryId` / `entryLocale` | The affected entry |
| `ip` | Client IP. Behind a proxy, enable `proxy: true` in `config/server.ts`. |
| `payload` | A compact copy of the entry: relations as id + name, texts cut at 500 characters, at most 32 KB |

Only actions taken in the admin panel are recorded. Changes made by your own services, cron jobs, scripts or
the public API are not admin actions and are skipped, the same rule Strapi Enterprise follows.

Notes:
- **Publish** in the Content Manager saves and then publishes, which produces an `entry.update` and an `entry.publish`.
- Deleting a published entry produces two `entry.delete` rows: one for the draft, one for the published version.

## Tamper protection

| Layer | Postgres | MySQL | SQLite |
|---|---|---|---|
| Update / delete through Strapi (admin panel, API, services) → 403 | ✓ | ✓ | ✓ |
| Manual creation from the Content Manager → 403 (only the plugin writes) | ✓ | ✓ | ✓ |
| Database trigger: `UPDATE` / `DELETE` in SQL are rejected | ✓ | ✓ (see [MySQL](#mysql)) | – |

The retention job is the only thing allowed to delete. It does so in batches of 5,000 rows, in short
transactions, using a session flag the trigger accepts. Triggers are created only when missing, so several
instances can start at the same time against the same database.

## Data safety

The plugin never touches your app's data. It writes only to the `audit_logs` table, plus one key
(`persisted_tables`) in Strapi's core store.

- **Existing table with the same name:** if the database already contains an `audit_logs` table that Strapi
  does not manage, startup stops **before** the schema sync and the table is left untouched. The error
  message explains what to do.
- **Uninstalling or disabling the plugin:** Strapi normally drops the table of a removed content type. The
  plugin registers `audit_logs` in Strapi's `persisted_tables`, so the entries stay and are picked up again
  when the plugin is reinstalled.
- **Retention** only deletes from `audit_logs`, and never anything newer than 30 days.

## CSV export

```
GET /audit-log/export?from=2026-01-01&to=2026-01-31
Authorization: Bearer <admin JWT>
```

Optional filters: `action`, `userEmail`, `contentType`. Requires *Read* permission on Audit Log. When `to` is a
date only, the whole day is included. At most 100,000 rows; narrow the range for more. The file is streamed,
starts with a UTF-8 BOM so spreadsheet apps read non-ASCII text correctly, and cells starting with `= + - @`
are escaped against formula injection.

## `strapi import` / `strapi transfer`

`strapi import --force` first deletes **all** content in the target. Tamper protection rejects deleting the audit
log, so the import stops with:

```
audit_logs is append-only: DELETE is not allowed (strapi import: see strapi-plugin-audit-log README)
```

The import runs in a transaction and is rolled back, so nothing is lost. To run it:

**If your Strapi has `--exclude-content-types` (recommended):** leave the audit log out of the import. The
target keeps its own entries.

```bash
strapi import -f export.tar.gz --force --exclude-content-types plugin::audit-log.audit-log
```

**Older Strapi versions** (the option is missing from `strapi import --help`):

```bash
AUDIT_LOG_APPEND_ONLY=false strapi import -f export.tar.gz --force
```

The target's audit log is then replaced by the source's and the trigger is removed. Strapi reinstalls the
trigger on its next normal start. The same applies to `strapi transfer`.

## Migrating from an in-app audit log

If your app already has its own audit log content type stored in a table named `audit_logs` (for example
`api::audit-log.audit-log`), the plugin adopts that table and its rows as they are, as long as the columns
match the [recorded columns](#what-gets-recorded).

In **one** deploy:
1. Install the plugin.
2. Remove the old content type and its code.

Doing step 2 without step 1 makes Strapi drop the table. Role permissions are not carried over because the
content type UID changes.

## Troubleshooting

**A Strapi upgrade fails with `audit_logs is append-only`.** A migration in that Strapi version may update
every table. Drop the trigger, finish the upgrade, and Strapi reinstalls it on the next start:

```sql
-- Postgres
DROP TRIGGER IF EXISTS audit_logs_protect_trg ON audit_logs;
-- MySQL
DROP TRIGGER IF EXISTS audit_logs_protect_update_v1;
DROP TRIGGER IF EXISTS audit_logs_protect_delete_v1;
```

**Nothing is recorded.** Check the startup log for `[AUDIT-LOG] subscriber registered`. Only admin panel
requests are recorded.

**Every entry shows the same IP (your load balancer).** Set `proxy: true` in `config/server.ts` so Koa trusts
`X-Forwarded-For`.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Releasing: bump `version` in `package.json`, update `CHANGELOG.md`, push a `vX.Y.Z` tag. GitHub Actions
publishes to npm (needs an `NPM_TOKEN` repository secret).

## License

MIT
