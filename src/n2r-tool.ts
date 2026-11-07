// Bind validated custom-tool source to an existing host capability without permission escalation.
import { createHash } from 'node:crypto';
import { metadata, parseSource, workflowTimeout } from './n2r-ast';
import { customSchema } from './n2r-schema';
import { CustomGuards } from './n2r-guards';
import { hostEntry, type ToolEntry } from './tool-entry';
import { fingerprint, text } from './values';
import type { JsonValue } from './types';

export function compileTool(source: string, resolve: (bindingId: string) => ToolEntry): ToolEntry {
  const blocks = parseSource(source);
  const meta = metadata(blocks);
  const reference = text(meta.handler, 'handler reference', 512);
  const bindingId = reference.startsWith('native:') ? `host:${reference.slice(7)}` : reference;
  const binding = resolve(bindingId);
  const schema = customSchema(blocks, meta) ?? binding.view.inputSchema;
  const readOnly = flag(meta.read_only, false);
  const idempotent = flag(meta.idempotent, readOnly && binding.view.idempotent);
  if ((readOnly && !binding.view.readOnly) || (idempotent && !binding.view.idempotent))
    throw new Error('Custom metadata cannot upgrade the bound capability');
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const entry = hostEntry({
    name: text(meta.name, 'custom-tool name', 64),
    version: text(meta.version ?? sourceHash, 'custom-tool version', 128),
    description: text(
      meta.description ?? binding.view.description,
      'custom-tool description',
      4096,
    ),
    category: text(meta.category ?? binding.view.category, 'custom-tool category', 64),
    triggers: metadataStrings(meta.triggers),
    tags: metadataStrings(meta.tags),
    readOnly,
    idempotent,
    timeoutMs: Math.min(workflowTimeout(blocks, reference), binding.view.timeoutMs),
    inputSchema: schema,
    execute: binding.execute,
  });
  const guards = new CustomGuards(blocks);
  entry.view.source = 'n2r';
  entry.view.bindingId = binding.view.bindingId;
  entry.view.definitionHash = fingerprint({ sourceHash, bindingHash: binding.view.definitionHash });
  entry.capabilityHash = binding.capabilityHash;
  entry.predicateCount = guards.count;
  entry.guard = (args) => {
    binding.schema.check(args);
    binding.guard?.(args);
    guards.check(args);
  };
  entry.dispose = () => guards.dispose();
  return entry;
}

function flag(value: JsonValue | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('Custom capability flags must be booleans');
  return value;
}
function metadataStrings(value: JsonValue | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Custom tags and triggers must be arrays');
  return value.map((item) => text(item, 'custom metadata string', 256));
}
