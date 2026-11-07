// Validate synchronous draft-07 input schemas with bounded, non-backtracking pattern checks.
import Ajv, { type ValidateFunction } from 'ajv';
import { RE2JS } from 're2js';
import { object, plainJson, text } from './values';
import type { JsonObject, JsonValue } from './types';

const MAPS = new Set(['properties', 'patternProperties', 'definitions', '$defs', 'dependencies']);
const SCHEMAS = new Set([
  'additionalProperties',
  'additionalItems',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
]);
const LISTS = new Set(['allOf', 'anyOf', 'oneOf']);

export class InputSchema {
  readonly value: JsonObject;
  private readonly validate: ValidateFunction;

  constructor(value: unknown) {
    this.value = object(plainJson(value, 32768, 2048));
    if (this.value.type !== 'object') throw new Error('Input schema must have object type');
    validateStructure(this.value);
    const engine = Object.assign(
      (pattern: string) => {
        text(pattern, 'schema pattern', 4096);
        return RE2JS.compile(RE2JS.translateRegExp(pattern));
      },
      { code: 'linearRegex' },
    );
    const ajv = new Ajv({
      strict: true,
      allowUnionTypes: true,
      ownProperties: true,
      allErrors: false,
      inlineRefs: false,
      loopRequired: 32,
      loopEnum: 32,
      code: { regExp: engine },
    });
    this.validate = ajv.compile(this.value);
  }

  check(value: unknown, maximum = 65536): JsonObject {
    const args = object(plainJson(value, maximum));
    if (!this.validate(args))
      throw new Error('Tool arguments do not match the registered input schema');
    return args;
  }
}

function validateStructure(root: JsonObject): void {
  let visited = 0;
  const walk = (value: JsonValue, ancestors: Set<JsonValue>): void => {
    if (++visited > 4096 || ancestors.size > 32)
      throw new Error('Schema reference expansion exceeds its limit');
    if (typeof value === 'boolean') return;
    const schema = object(value);
    if (ancestors.has(schema)) throw new Error('Recursive input schemas are unsupported');
    const next = new Set(ancestors).add(schema);
    if ('$async' in schema || '$id' in schema)
      throw new Error('Async and externally identified schemas are unsupported');
    if (
      schema.$schema !== undefined &&
      schema.$schema !== 'http://json-schema.org/draft-07/schema#'
    )
      throw new Error('Input schema must use JSON Schema draft-07');
    if (schema.$ref !== undefined) walk(resolveReference(root, schema.$ref), next);
    for (const [key, child] of Object.entries(schema)) {
      if (MAPS.has(key)) {
        for (const nested of Object.values(object(child))) {
          if (key !== 'dependencies' || !Array.isArray(nested)) walk(nested, next);
        }
      } else if (LISTS.has(key) || (key === 'items' && Array.isArray(child))) {
        if (!Array.isArray(child) || child.length > 64)
          throw new Error('Invalid schema alternative list');
        for (const nested of child) walk(nested, next);
      } else if (SCHEMAS.has(key) || key === 'items') walk(child, next);
    }
  };
  walk(root, new Set());
}

function resolveReference(root: JsonObject, raw: JsonValue): JsonValue {
  const reference = text(raw, 'schema reference', 512);
  if (!reference.startsWith('#/'))
    throw new Error('Only local JSON Pointer references are supported');
  let current: JsonValue = root;
  for (const part of reference.slice(2).split('/')) {
    if (/~(?![01])/u.test(part)) throw new Error('Malformed schema reference');
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    const item = object(current);
    if (!Object.hasOwn(item, key)) throw new Error('Unresolved local schema reference');
    current = item[key]!;
  }
  return current;
}
