// Bound JSON structure and preserve Unicode before hashing, validating or storing host input.
import { createHash } from 'node:crypto';
import type { JsonObject, JsonValue } from './types';

export function text(value: unknown, label: string, maximum = 65536): string {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    value.includes('\0') ||
    Buffer.byteLength(value) > maximum ||
    Buffer.from(value).toString('utf8') !== value
  )
    throw new Error(`Invalid ${label}`);
  return value;
}

export function name(value: unknown, label = 'tool name'): string {
  const result = text(value, label, 64);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(result)) throw new Error(`Invalid ${label}`);
  return result;
}

export function identity(value: unknown, label: string, maximum = 128): string {
  const result = text(value, label, maximum);
  if (!result.trim()) throw new Error(`An explicit ${label} is required`);
  return result;
}

export function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new Error(`Invalid ${label}`);
  return value;
}

export function plainJson(
  value: unknown,
  maximum = 65536,
  maximumElements = 4096,
  maximumDepth = 16,
): JsonValue {
  let elements = 0;
  let bytes = 0;
  const checkedText = (value: unknown): string => {
    const result = text(value, 'JSON text', maximum);
    bytes += Buffer.byteLength(result);
    if (bytes > maximum) throw new Error('JSON exceeds its byte limit');
    return result;
  };
  const visit = (item: unknown, depth: number): JsonValue => {
    if (++elements > maximumElements || depth > maximumDepth)
      throw new Error('JSON exceeds its element or nesting limit');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') return checkedText(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))
        throw new Error('JSON numbers must preserve finite integer precision');
      return item;
    }
    if (Array.isArray(item)) {
      if (item.length > maximumElements) throw new Error('JSON array exceeds its element limit');
      return Array.from(item, (child) => visit(child, depth + 1));
    }
    if (
      item &&
      typeof item === 'object' &&
      [Object.prototype, null].includes(Object.getPrototypeOf(item))
    )
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [checkedText(key), visit(child, depth + 1)]),
      );
    throw new Error('Expected a plain JSON value');
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maximum)
    throw new Error('JSON exceeds its byte limit');
  return result;
}

export function object(value: JsonValue): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object');
  return value;
}

export function fingerprint(value: JsonValue): string {
  const canonical = (item: JsonValue): JsonValue => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, canonical(item[key]!)]),
      );
    return item;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
