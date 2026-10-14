import { AUDIT_LOG_UID } from '../lib/constants';

/** Admin routes are prefixed with the plugin name: GET /audit-log/export */
export default {
  admin: {
    type: 'admin',
    routes: [
      {
        method: 'GET',
        path: '/export',
        handler: 'audit-log.exportCsv',
        config: {
          policies: [
            'admin::isAuthenticatedAdmin',
            {
              name: 'admin::hasPermissions',
              config: {
                actions: [['plugin::content-manager.explorer.read', AUDIT_LOG_UID]],
              },
            },
          ],
        },
      },
    ],
  },
};
