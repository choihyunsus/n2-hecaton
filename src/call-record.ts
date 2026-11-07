// Check hashes and bounded SQLite values before accepting historical execution or replay data.
import { column, hashValue, type ReadConnection } from './store';
import { fingerprint, identity, integer, name, object, plainJson, text } from './values';
import { checkedResult, type ToolEntry } from './tool-entry';
import type { CallInput, CallRecord, CallState, ExecutionRequest } from './call-types';
import type { JsonObject, JsonValue, ToolView } from './types';

export function callInput(
  request: ExecutionRequest,
  entry: ToolEntry,
  policyVersion: string,
): CallInput {
  if (name(request.tool) !== entry.view.name)
    throw new Error('Request tool differs from its registered capability');
  const input = {
    requestId: identity(request.requestId, 'request ID'),
    sessionId: identity(request.sessionId ?? request.requestId, 'session ID'),
    tool: metadata(plainJson(entry.view, 65536, 8192, 24)),
    arguments: object(plainJson(request.arguments)),
    capabilityHash: hashValue(entry.capabilityHash),
    policyVersion: identity(policyVersion, 'policy version'),
    metadataHash: fingerprint(plainJson(entry.view, 65536, 8192, 24)),
  };
  return { ...input, requestHash: callHash(input) };
}

export function callHash(input: Omit<CallInput, 'requestHash'>): string {
  return fingerprint({
    protocol: 1,
    requestId: input.requestId,
    sessionId: input.sessionId,
    tool: input.tool.name,
    definitionHash: input.tool.definitionHash,
    metadataHash: input.metadataHash,
    capabilityHash: input.capabilityHash,
    policyVersion: input.policyVersion,
    arguments: input.arguments,
  });
}

export function readCall(row: Record<string, unknown>): CallRecord {
  const tool = metadata(parse(row.metadata_json, 65536, 8192, 24));
  const metadataHash = hashValue(row.metadata_hash);
  if (
    fingerprint(tool as unknown as JsonValue) !== metadataHash ||
    tool.definitionHash !== row.definition_hash ||
    tool.bindingId !== row.binding_id ||
    tool.name !== row.tool_name
  )
    throw new Error('Stored tool metadata hash mismatch');
  const input: CallInput = {
    requestId: identity(row.request_id, 'stored request ID'),
    sessionId: identity(row.session_id, 'stored session ID'),
    tool,
    arguments: object(parse(row.arguments_json, 65536)),
    capabilityHash: hashValue(row.capability_hash),
    policyVersion: identity(row.policy_version, 'stored policy version'),
    metadataHash,
    requestHash: hashValue(row.request_hash),
  };
  if (input.requestHash !== callHash(input)) throw new Error('Stored request hash mismatch');
  const result =
    row.result_json === null ? null : checkedResult(parse(row.result_json, 131072), tool.readOnly);
  if (
    (result === null && row.result_hash !== null) ||
    (result !== null && fingerprint(result as unknown as JsonValue) !== hashValue(row.result_hash))
  )
    throw new Error('Stored result hash mismatch');
  const state = text(row.state, 'stored call state', 16) as CallState;
  if (!['prepared', 'pending', 'completed', 'unknown', 'blocked'].includes(state))
    throw new Error('Invalid stored call state');
  const record: CallRecord = {
    ...input,
    state,
    result,
    error: nullableText(row.error, 4096),
    evidence: nullableText(row.evidence, 8192),
    experienceId: row.experience_id === null ? null : identity(row.experience_id, 'experience ID'),
    attempts: integer(row.attempts, 'attempt count', 0, 32),
    circuitEpoch: integer(row.circuit_epoch, 'circuit epoch', 0, Number.MAX_SAFE_INTEGER),
    circuitProbe: integer(row.circuit_probe, 'probe flag', 0, 1) === 1,
    startedAt: integer(row.started_at, 'call start time', 0, Number.MAX_SAFE_INTEGER),
    finishedAt:
      row.finished_at === null
        ? null
        : integer(row.finished_at, 'call finish time', 0, Number.MAX_SAFE_INTEGER),
  };
  validateState(record);
  return record;
}

export function findCall(
  db: ReadConnection,
  scope: readonly string[],
  requestId: string,
): CallRecord | undefined {
  identity(requestId, 'request ID');
  const row = db.query<Record<string, unknown>>(
    `SELECT ${CALL_COLUMNS} FROM hecaton_calls WHERE project=? AND agent=? AND request_id=?`,
    [...scope, requestId],
  )[0];
  return row ? readCall(row) : undefined;
}

function validateState(row: CallRecord): void {
  const completed = row.state === 'completed' || row.state === 'blocked';
  if (completed !== (row.result !== null) || completed !== (row.experienceId !== null))
    throw new Error('Stored completion receipt is inconsistent');
  if ((row.state === 'prepared' || row.state === 'pending') !== (row.finishedAt === null))
    throw new Error('Stored execution timestamps are inconsistent');
  if ((row.state === 'prepared' || row.state === 'blocked') !== (row.attempts === 0))
    throw new Error('Stored attempt state is inconsistent');
  if (row.state === 'blocked' && row.result?.success)
    throw new Error('Blocked calls cannot be successful');
}
function metadata(value: JsonValue): ToolView {
  const item = object(value);
  name(item.name);
  identity(item.version, 'stored tool version');
  identity(item.bindingId, 'stored binding ID', 512);
  hashValue(item.definitionHash);
  if (typeof item.readOnly !== 'boolean' || typeof item.idempotent !== 'boolean')
    throw new Error('Stored capability flags are invalid');
  integer(item.timeoutMs, 'stored tool timeout', 1, 120000);
  return item as unknown as ToolView;
}
function parse(value: unknown, maximum: number, elements = 4096, depth = 16): JsonValue {
  return plainJson(JSON.parse(text(value, 'stored JSON', maximum)), maximum, elements, depth);
}
function nullableText(value: unknown, maximum: number): string | null {
  return value === null ? null : text(value, 'stored text', maximum);
}

const TEXT_COLUMNS: Record<string, number> = {
  request_id: 128,
  session_id: 128,
  tool_name: 64,
  definition_hash: 64,
  binding_id: 512,
  capability_hash: 64,
  policy_version: 128,
  request_hash: 64,
  arguments_json: 65536,
  metadata_json: 65536,
  metadata_hash: 64,
  state: 16,
  result_json: 131072,
  result_hash: 64,
  error: 4096,
  evidence: 8192,
  experience_id: 128,
};
export const CALL_COLUMNS = [
  ...Object.entries(TEXT_COLUMNS).map(([key, maximum]) => column(key, maximum)),
  'attempts',
  'circuit_epoch',
  'circuit_probe',
  'started_at',
  'finished_at',
].join(',');
