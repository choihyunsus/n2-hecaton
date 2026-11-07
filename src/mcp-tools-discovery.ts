// Discovery can only reach MCP endpoints and executables registered by the local host adapter.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Hecaton } from './hecaton';
import { chunk, respond } from './mcp-output';

const serverId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const remoteName = z.string().min(1).max(128);
export function registerDiscovery(server: McpServer, engine: Hecaton): void {
  server.registerTool(
    'hecaton_servers',
    {
      description: 'List configured MCP server identities and connection state.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    async () => respond(() => engine.mcpServers()),
  );
  registerDiscover(server, engine);
  registerRemoteRead(server, engine);
  registerImport(server, engine);
}
function registerDiscover(server: McpServer, engine: Hecaton): void {
  server.registerTool(
    'hecaton_discover',
    {
      description: 'Discover and analyze a configured MCP catalog, with bounded summary pages.',
      inputSchema: z
        .object({
          serverId,
          limit: z.int().min(1).max(20).default(20),
          offset: z.int().min(0).max(128).default(0),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ serverId, limit, offset }, extra) =>
      respond(async () => {
        const { tools, ...metadata } = await engine.discoverMcp(serverId, extra.signal);
        return {
          ...metadata,
          total: tools.length,
          tools: tools.slice(offset, offset + limit).map(({ remote, source, ...analysis }) => ({
            ...analysis,
            remoteName: remote.name,
            generatedSource: source !== null,
          })),
        };
      }),
  );
}
function registerRemoteRead(server: McpServer, engine: Hecaton): void {
  server.registerTool(
    'hecaton_read_remote',
    {
      description:
        'Read current remote analysis and generated source in JSON chunks. Check the content hash across repeated discovery.',
      inputSchema: z
        .object({
          serverId,
          name: remoteName,
          offset: z.int().min(0).max(1048576).default(0),
          limit: z.int().min(1).max(4096).default(2048),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ serverId, name, offset, limit }, extra) =>
      respond(async () => {
        const analysis = await engine.discoverMcp(serverId, extra.signal);
        const tool = analysis.tools.find((tool) => tool.remote.name === name);
        if (!tool) throw new Error('Remote tool was not found');
        return chunk(tool, offset, limit);
      }),
  );
}
function registerImport(server: McpServer, engine: Hecaton): void {
  server.registerTool(
    'hecaton_import',
    {
      description:
        'Atomically register selected supported remote tools. Registration verification is recorded separately from execution.',
      inputSchema: z
        .object({
          serverId,
          names: z.array(remoteName).min(1).max(128),
          expectedHashes: z
            .record(
              z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
              z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .nullable(),
            )
            .optional(),
        })
        .strict(),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (input, extra) =>
      respond(async () => {
        const { issues, ...receipt } = await engine.importMcp(input, extra.signal);
        return { ...receipt, issueCount: issues.length };
      }),
  );
}
