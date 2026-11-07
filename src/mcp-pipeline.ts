// Discover, analyze and compile selected remote capabilities before an atomic registration batch.
import { discover } from './mcp-discovery';
import { planTool, type McpPlan } from './mcp-proxy';
import { identity, name, object, plainJson } from './values';
import { hashValue } from './store';
import type { McpPool } from './mcp-pool';
import type {
  McpAnalysis,
  McpDiscovery,
  McpImportOptions,
  McpToolAnalysis,
  RemoteTool,
} from './mcp-types';

export async function analyzeMcp(
  pool: McpPool,
  serverId: string,
  signal: AbortSignal,
): Promise<McpAnalysis> {
  const discovered = await discover(pool, serverId, signal);
  return {
    ...discovered,
    tools: discovered.tools.map((remote) => analyzeTool(pool, discovered, remote)),
  };
}

export async function prepareImport(
  pool: McpPool,
  options: McpImportOptions,
  signal: AbortSignal,
): Promise<{
  serverId: string;
  plans: McpPlan[];
  expected: Record<string, string | null>;
}> {
  const serverId = name(options.serverId, 'MCP server ID');
  if (!Array.isArray(options.names) || !options.names.length || options.names.length > 128)
    throw new Error('Select between 1 and 128 remote tool names');
  const names = options.names.map((value) => identity(value, 'remote tool name'));
  if (new Set(names).size !== names.length)
    throw new Error('Remote tool selections must be distinct');
  const expected = expectedHashes(options.expectedHashes);
  const discovered = await discover(pool, serverId, signal);
  const plans = names.map((name) => {
    const remote = discovered.tools.find((tool) => tool.name === name);
    if (!remote) throw new Error('A selected MCP tool is absent from discovery');
    return planTool(pool, discovered, remote);
  });
  if (Object.keys(expected).some((key) => !plans.some((plan) => plan.name === key)))
    throw new Error('Expected hashes refer to an unselected imported tool');
  return { serverId, plans, expected };
}

function analyzeTool(pool: McpPool, discovered: McpDiscovery, remote: RemoteTool): McpToolAnalysis {
  const permission = pool.permission(discovered.serverId, remote.name);
  try {
    const plan = planTool(pool, discovered, remote);
    return {
      remote,
      publicName: plan.name,
      supported: true,
      reason: null,
      readOnly: permission.readOnly,
      idempotent: permission.idempotent,
      source: plan.source,
    };
  } catch (error) {
    return {
      remote,
      publicName: null,
      supported: false,
      reason:
        error instanceof Error
          ? Array.from(error.message).slice(0, 500).join('')
          : 'Unsupported MCP tool definition',
      readOnly: permission.readOnly,
      idempotent: permission.idempotent,
      source: null,
    };
  }
}
function expectedHashes(value: McpImportOptions['expectedHashes']): Record<string, string | null> {
  const input = object(plainJson(value ?? {}, 32768));
  return Object.fromEntries(
    Object.entries(input).map(([key, hash]) => [
      name(key, 'imported tool name'),
      hash === null ? null : hashValue(hash),
    ]),
  );
}
