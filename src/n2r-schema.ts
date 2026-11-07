// Preserve legacy typed fields and descriptions or accept one explicit JSON input schema.
import { list } from './n2r-ast';
import { object, plainJson, text } from './values';
import type { JsonObject } from './types';

export function customSchema(blocks: JsonObject[], meta: JsonObject): JsonObject | undefined {
  const definitions = blocks
    .filter((block) => block.type === 'Schema')
    .flatMap((block) => list(block.definitions))
    .map(object);
  if (definitions.length > 1 || (meta.input_schema_json !== undefined && definitions.length))
    throw new Error('Declare one input schema using typed fields or input_schema_json');
  if (meta.input_schema_json !== undefined) {
    if (meta.param_descriptions !== undefined)
      throw new Error('JSON schemas include their own parameter descriptions');
    return object(
      plainJson(JSON.parse(text(meta.input_schema_json, 'input schema JSON', 32768)), 32768),
    );
  }
  if (!definitions.length) {
    if (meta.param_descriptions !== undefined)
      throw new Error('Parameter descriptions require a typed schema');
    return undefined;
  }
  const definition = definitions[0]!;
  if (definition.is_enum !== false) throw new Error('Custom-tool input must be an object schema');
  const descriptions =
    meta.param_descriptions === undefined
      ? {}
      : object(
          plainJson(
            JSON.parse(text(meta.param_descriptions, 'parameter descriptions', 32768)),
            32768,
          ),
        );
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const raw of list(definition.fields)) {
    const field = object(raw);
    const key = text(field.name, 'input property name', 64);
    if (!key || key.startsWith('__') || Object.hasOwn(properties, key))
      throw new Error('Invalid or duplicate input property');
    const attributes = list(field.attributes);
    if (attributes.some((value) => value !== 'required'))
      throw new Error('Unsupported typed schema constraint');
    const value = schemaType(text(field.type_expr, 'input type', 128).trim());
    if (Object.hasOwn(descriptions, key))
      value.description = text(descriptions[key], 'parameter description', 4096);
    Object.defineProperty(properties, key, { value, enumerable: true });
    if (attributes.includes('required')) required.push(key);
  }
  if (Object.keys(descriptions).some((key) => !Object.hasOwn(properties, key)))
    throw new Error('Parameter description names an unknown field');
  return { type: 'object', properties, required };
}

function schemaType(value: string): JsonObject {
  if (value.endsWith('[]')) return { type: 'array', items: schemaType(value.slice(0, -2)) };
  const types: Record<string, string> = {
    string: 'string',
    str: 'string',
    int: 'integer',
    integer: 'integer',
    float: 'number',
    number: 'number',
    bool: 'boolean',
    boolean: 'boolean',
  };
  const type = types[value.toLowerCase()];
  if (!type) throw new Error('Unsupported typed schema field');
  return { type };
}
