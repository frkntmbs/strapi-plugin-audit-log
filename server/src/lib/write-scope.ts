import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Rows written by the plugin itself are created inside this scope.
 * The lifecycle guard rejects every other create (e.g. a manual entry from the Content Manager).
 */
const scope = new AsyncLocalStorage<true>();

export const runAsAuditWriter = <T>(fn: () => Promise<T>): Promise<T> => scope.run(true, fn);

export const isAuditWriter = (): boolean => scope.getStore() === true;
