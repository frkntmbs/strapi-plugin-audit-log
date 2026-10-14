import { MAX_ARRAY_ITEMS, MAX_PAYLOAD_BYTES, MAX_TEXT_LENGTH } from './constants';
import type { Strapi } from './types';

type AnyRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is AnyRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const truncateText = (value: string): string =>
  value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH)}… [+${value.length - MAX_TEXT_LENGTH}]` : value;

/** For relations / media keep only identifiers and a readable name. */
const summarizeRef = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  const out: AnyRecord = {};
  for (const key of ['id', 'documentId', 'name', 'title', 'slug', 'locale']) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
};

const summarizeRefs = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map(summarizeRef);
    return value.length > MAX_ARRAY_ITEMS ? { count: value.length, items } : items;
  }
  return summarizeRef(value);
};

/** Components / dynamic zones: component name and id are enough. */
const summarizeComponents = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return {
      count: value.length,
      items: value.slice(0, MAX_ARRAY_ITEMS).map((item) =>
        isRecord(item) ? { id: item.id, __component: item.__component } : item
      ),
    };
  }
  return isRecord(value) ? { id: value.id, __component: value.__component } : value;
};

/**
 * Shrinks a populated entry so it fits in a log row.
 * Without a known schema (plugin types) only top-level scalars are kept.
 * masked → content is not stored, only identifiers and changed field names (personal data).
 */
export const compactEntry = (strapi: Strapi, uid: string, entry: unknown, masked: boolean): unknown => {
  if (!isRecord(entry)) return entry;

  if (masked) {
    return {
      masked: true,
      id: entry.id,
      documentId: entry.documentId,
      locale: entry.locale,
      fields: Object.keys(entry).filter((key) => !['id', 'documentId', 'locale'].includes(key)),
    };
  }

  let attributes: AnyRecord = {};
  try {
    attributes = (strapi.getModel(uid)?.attributes ?? {}) as AnyRecord;
  } catch {
    attributes = {};
  }

  const out: AnyRecord = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value === null || value === undefined) continue;
    const attr = attributes[key] as { type?: string } | undefined;
    const type = attr?.type;

    if (type === 'relation' || type === 'media') {
      out[key] = summarizeRefs(value);
    } else if (type === 'component' || type === 'dynamiczone') {
      out[key] = summarizeComponents(value);
    } else if (type === 'blocks' || type === 'richtext' || type === 'json') {
      out[key] = truncateText(typeof value === 'string' ? value : JSON.stringify(value));
    } else if (typeof value === 'string') {
      out[key] = truncateText(value);
    } else if (isRecord(value) || Array.isArray(value)) {
      // Object fields not defined in the schema (e.g. localizations, createdBy)
      out[key] = summarizeRefs(value);
    } else {
      out[key] = value;
    }
  }
  return out;
};

/** Last line of defence: cap the row size no matter what. */
export const capPayload = (payload: unknown): unknown => {
  try {
    const json = JSON.stringify(payload ?? {});
    if (Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES) return payload;
    return {
      truncated: true,
      bytes: Buffer.byteLength(json, 'utf8'),
      keys: isRecord(payload) ? Object.keys(payload) : undefined,
    };
  } catch {
    return { unserializable: true };
  }
};

/** Builds a readable label so the entry stands out in the list. */
export const pickLabel = (entry: unknown, masked: boolean): string | undefined => {
  if (!isRecord(entry)) return undefined;
  if (masked) return entry.documentId ? String(entry.documentId) : undefined;
  for (const key of ['title', 'name', 'heading', 'slug', 'displayName', 'email']) {
    const value = entry[key];
    if (typeof value === 'string' && value.trim()) return value.slice(0, 120);
  }
  return entry.documentId ? String(entry.documentId) : undefined;
};
