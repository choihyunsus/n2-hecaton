// Snapshot host metadata while preserving class-bound callback receivers.
import { InputSchema } from './schema';
import { fingerprint, identity, integer, name, plainJson, text } from './values';
import { quantize } from './taxonomy';
import type { JsonObject, ToolContext, ToolDefinition, ToolResult, ToolView } from './types';

export interface ToolEntry {
  view: ToolView;
  schema: InputSchema;
  capabilityHash: string;
  predicateCount: number;
  execute(args: JsonObject, context: ToolContext): ToolResult | Promise<ToolResult>;
  guard?(args: JsonObject): void;
  dispose?(): void;
}

export function hostEntry(value: ToolDefinition): ToolEntry {
  if (!value || typeof value.execute !== 'function')
    throw new Error('A host tool callback is required');
  const schema = new InputSchema(value.inputSchema);
  const metadata = {
    name: name(value.name),
    version: identity(value.version, 'tool version'),
    description: text(value.description, 'tool description', 4096),
    category: identity(value.category ?? 'mcp', 'tool category', 64),
    triggers: strings(value.triggers ?? []),
    tags: strings(value.tags ?? []),
    readOnly: boolean(value.readOnly, false),
    idempotent: boolean(value.idempotent, value.readOnly ?? false),
    timeoutMs: integer(value.timeoutMs ?? 120000, 'tool timeout', 1, 120000),
    inputSchema: schema.value,
  };
  const bindingId = `host:${metadata.name}`;
  const view: ToolView = {
    ...metadata,
    source: 'host',
    bindingId,
    definitionHash: fingerprint({ ...metadata, bindingId }),
    ...quantize(metadata),
  };
  return {
    view,
    schema,
    capabilityHash: view.definitionHash,
    predicateCount: 0,
    execute: value.execute.bind(value),
  };
}

export function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32)
    throw new Error('Expected at most 32 metadata strings');
  return [...new Set(value.map((item) => identity(item, 'metadata string', 256)))];
}

function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('Tool capability flags must be booleans');
  return value;
}

export function checkedResult(value: unknown, readOnly: boolean): ToolResult {
  const result = plainJson(value, 131072);
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    typeof result.success !== 'boolean' ||
    typeof result.output !== 'string'
  )
    throw new Error('Tool results require a success boolean and output text');
  const keys = Object.keys(result);
  if (keys.some((key) => !['success', 'output', 'data', 'modifiedFiles'].includes(key)))
    throw new Error('Unsupported tool result field');
  if (result.modifiedFiles !== undefined) {
    if (!Array.isArray(result.modifiedFiles) || result.modifiedFiles.length > 1024)
      throw new Error('Invalid modified file list');
    for (const file of result.modifiedFiles) identity(file, 'modified file path', 4096);
    if (readOnly && result.modifiedFiles.length)
      throw new Error('A read-only tool reported mutations');
  }
  return result as unknown as ToolResult;
}
