export const CSV_COLUMNS = [
  'createdAt', 'action', 'userEmail', 'userName', 'contentType',
  'targetDocumentId', 'entryId', 'entryLocale', 'label', 'ip', 'payload',
] as const;

const toCsvStr = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

/** Cells starting with =, +, -, @ are prefixed with ' to prevent spreadsheet formula injection. */
export const escapeCsvField = (value: unknown): string => {
  const str = toCsvStr(value);
  const safe = /^[=+\-@\t\r]/.test(str) ? "'" + str : str;
  return '"' + safe.replace(/"/g, '""') + '"';
};

export const toCsvRow = (row: Record<string, unknown>): string =>
  CSV_COLUMNS.map((col) => escapeCsvField(row[col])).join(',');

export const CSV_HEADER = CSV_COLUMNS.map(escapeCsvField).join(',');
