// CLI commands share the same engine entry points and immutable execution receipts as library callers.
import type { Hecaton } from './hecaton';
import type { McpImportOptions } from './mcp-types';
import { required, jsonOption, numberOption, type CliValues } from './cli-options';
import { readSource } from './cli-files';
import { object } from './values';

export async function executeCli(
  engine: Hecaton,
  command: string,
  values: CliValues,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  switch (command) {
    case 'list':
      return { tools: engine.list(), issues: engine.problems() };
    case 'route':
      return engine.route(required(values, 'query'), numberOption(values, 'limit', 3));
    case 'call':
      return engine.execute({ ...request(values), tool: required(values, 'tool') }, signal);
    case 'auto':
      return engine.auto({ ...request(values), query: required(values, 'query') }, signal);
    case 'install':
      return engine.installSource(
        readSource(required(values, 'source')),
        values.get('expected-hash') ?? null,
      );
    case 'remove':
      engine.removeDefinition(required(values, 'tool'), required(values, 'expected-hash'));
      return { removed: required(values, 'tool') };
    case 'servers':
      return engine.mcpServers();
    case 'discover':
      return engine.discoverMcp(required(values, 'server'), signal);
    case 'import':
      return engine.importMcp(importOptions(values), signal);
    case 'reconcile':
      return engine.reconcile(
        required(values, 'request-id'),
        jsonOption(values, 'result-json', 131072),
        required(values, 'evidence'),
      );
    default:
      throw new Error('Unknown engine command');
  }
}
function request(values: CliValues) {
  return {
    requestId: required(values, 'request-id'),
    sessionId: values.get('session-id'),
    arguments: object(jsonOption(values, 'args-json')),
  };
}
function importOptions(values: CliValues): McpImportOptions {
  const names = jsonOption(values, 'names-json');
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string'))
    throw new Error('Expected an array of remote tool names');
  return {
    serverId: required(values, 'server'),
    names: names as string[],
    expectedHashes: values.has('expected-hashes-json')
      ? (object(jsonOption(values, 'expected-hashes-json')) as Record<string, string | null>)
      : undefined,
  };
}
