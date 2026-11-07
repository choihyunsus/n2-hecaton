// Discover bounded paginated catalogs without compiling arbitrary remote output schemas in the SDK.
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { object, plainJson, text, identity, fingerprint } from './values';
import type { McpPool } from './mcp-pool';
import type { JsonValue } from './types';
import type { RemoteTool, McpDiscovery } from './mcp-types';
const DISCOVERY_TIMEOUT_MS = 15000;
const MAX_METADATA_TEXT = 4096;

export async function discover(
  pool: McpPool,
  serverId: string,
  signal: AbortSignal,
): Promise<McpDiscovery> {
  const configurationVersion = pool.version(serverId);
  return pool.run(
    serverId,
    async (client, current) => ({
      serverId,
      configurationVersion,
      ...(await readCatalog(client, current)),
    }),
    signal,
    DISCOVERY_TIMEOUT_MS,
  );
}

export async function readCatalog(
  client: Client,
  signal: AbortSignal,
): Promise<Pick<McpDiscovery, 'serverInfo' | 'tools'>> {
  const server = client.getServerVersion();
  if (!server) throw new Error('MCP server did not complete initialization');
  const serverInfo = {
    name: text(server.name, 'remote server name', 256),
    version: text(server.version, 'remote server version', 128),
  };
  const tools: RemoteTool[] = [],
    names = new Set<string>(),
    cursors = new Set<string>();
  let cursor: string | undefined,
    bytes = 0;
  for (let page = 0; page < 32; page++) {
    const result = await client.request(
      { method: 'tools/list', params: cursor === undefined ? {} : { cursor } },
      ListToolsResultSchema,
      { signal, timeout: DISCOVERY_TIMEOUT_MS, maxTotalTimeout: DISCOVERY_TIMEOUT_MS },
    );
    bytes += Buffer.byteLength(JSON.stringify(result));
    if (bytes > 4 * 1024 * 1024 || tools.length + result.tools.length > 128)
      throw new Error('MCP discovery exceeds its catalog limit');
    for (const raw of result.tools) {
      const tool = remoteTool(raw);
      if (names.has(tool.name)) throw new Error('MCP catalog repeats a tool name');
      names.add(tool.name);
      tools.push(tool);
    }
    if (result.nextCursor === undefined) return { serverInfo, tools };
    cursor = text(result.nextCursor, 'MCP cursor', 512);
    if (cursors.has(cursor)) throw new Error('MCP discovery repeated a pagination cursor');
    cursors.add(cursor);
  }
  throw new Error('MCP discovery exceeds its page limit');
}

export function remoteTool(raw: unknown): RemoteTool {
  const value = object(plainJson(raw, 131072, 16384, 24));
  return {
    name: identity(value.name, 'remote tool name'),
    description: text(value.description ?? '', 'remote tool description', MAX_METADATA_TEXT),
    inputSchema: object(plainJson(value.inputSchema, 32768, 2048)),
    outputSchema:
      value.outputSchema === undefined || value.outputSchema === null
        ? null
        : object(plainJson(value.outputSchema, 32768, 2048)),
    annotations: object(plainJson(value.annotations ?? {}, MAX_METADATA_TEXT)),
    execution: object(plainJson(value.execution ?? {}, MAX_METADATA_TEXT)),
  };
}
export function remoteHash(tool: RemoteTool, serverInfo: McpDiscovery['serverInfo']): string {
  return fingerprint({ tool: tool as unknown as JsonValue, serverInfo });
}
