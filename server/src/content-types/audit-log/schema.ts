import { AUDIT_LOG_TABLE } from '../../lib/constants';

/**
 * WARNING: Strapi's schema sync drops the column of any attribute removed or renamed here,
 * in every app using the plugin. Only add attributes; removing or renaming one loses data.
 */

export default {
  kind: 'collectionType',
  collectionName: AUDIT_LOG_TABLE,
  info: {
    singularName: 'audit-log',
    pluralName: 'audit-logs',
    displayName: 'Audit Log',
    description: 'Immutable record of admin panel actions (who, when, what)',
  },
  options: {
    draftAndPublish: false,
  },
  pluginOptions: {
    'content-manager': { visible: true },
    'content-type-builder': { visible: false },
  },
  attributes: {
    action: { type: 'string', required: true },
    userEmail: { type: 'string' },
    userName: { type: 'string' },
    userId: { type: 'integer' },
    label: { type: 'string' },
    contentType: { type: 'string' },
    targetDocumentId: { type: 'string' },
    entryId: { type: 'integer' },
    entryLocale: { type: 'string' },
    ip: { type: 'string' },
    payload: { type: 'json' },
  },
};
