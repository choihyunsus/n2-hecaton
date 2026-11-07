// Decode the compiler AST and reject fields whose execution semantics are unsupported.
import { parse_n2_wasm, validate_n2_wasm } from 'n2-clotho';
import { object, plainJson, text } from './values';
import type { JsonObject, JsonValue } from './types';
const MAX_TIMEOUT_MS = 120000;

export function parseSource(source: unknown): JsonObject[] {
  const checked = text(source, 'N2R source', 65536);
  const report = object(plainJson(JSON.parse(validate_n2_wasm(checked)), 1048576, 32768));
  if (report.errorCount !== 0) throw new Error('N2R source failed compiler validation');
  const ast = object(plainJson(JSON.parse(parse_n2_wasm(checked)), 1048576, 32768));
  const blocks = list(ast.blocks).map(object);
  if (
    blocks.length > 128 ||
    blocks.some(
      (block) => !['Meta', 'Schema', 'Rule', 'Contract', 'Workflow'].includes(String(block.type)),
    )
  )
    throw new Error('Unsupported custom-tool block');
  return blocks;
}

export function list(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value)) throw new Error('Expected an AST array');
  return value;
}

export function fields(value: JsonValue | undefined, allowed: readonly string[]): JsonObject {
  const result: JsonObject = {};
  for (const raw of list(value)) {
    const field = object(raw);
    const key = text(field.key, 'AST field name', 128);
    if (!allowed.includes(key) || Object.hasOwn(result, key))
      throw new Error(`Unsupported or duplicate N2R field ${key}`);
    Object.defineProperty(result, key, { value: field.value, enumerable: true });
  }
  return result;
}

export function metadata(blocks: JsonObject[]): JsonObject {
  const matching = blocks.filter((block) => block.type === 'Meta');
  if (matching.length !== 1) throw new Error('Expected exactly one metadata block');
  const meta = fields(matching[0]!.fields, [
    'name',
    'version',
    'description',
    'category',
    'handler',
    'read_only',
    'idempotent',
    'triggers',
    'tags',
    'enforce',
    'input_schema_json',
    'param_descriptions',
    'source',
    'trust',
    'author',
  ]);
  if (meta.enforce !== 'strict') throw new Error('Custom-tool enforcement must be strict');
  return meta;
}

export function workflowTimeout(blocks: JsonObject[], handler: string): number {
  const workflows = blocks.filter((block) => block.type === 'Workflow');
  if (workflows.length === 0) return MAX_TIMEOUT_MS;
  if (workflows.length !== 1) throw new Error('Custom tools support one bound workflow');
  const workflow = workflows[0]!;
  const options = fields(workflow.fields, ['trigger']);
  if (options.trigger !== undefined && options.trigger !== 'tool_call')
    throw new Error('Unsupported workflow trigger');
  const steps = list(workflow.steps).map(object);
  if (steps.length !== 1) throw new Error('Custom tools support one bound handler step');
  const step = steps[0]!;
  if (list(step.expects).length || (step.output !== null && step.output !== '$RESULT'))
    throw new Error('Output transformations and expectation expressions are unsupported');
  const properties = fields(step.fields, ['action', 'required', 'timeout']);
  if (
    properties.action !== handler ||
    (properties.required !== undefined && properties.required !== true)
  )
    throw new Error('Workflow must require the metadata handler');
  if (properties.timeout === undefined) return MAX_TIMEOUT_MS;
  const match = /^(\d+)(ms|s)$/.exec(text(properties.timeout, 'tool duration', 32));
  const milliseconds = match ? Number(match[1]) * (match[2] === 's' ? 1000 : 1) : 0;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > MAX_TIMEOUT_MS)
    throw new Error('Tool duration must be between 1ms and 120s');
  return milliseconds;
}
