// The stdio host controls the exposed catalog and scope for every management operation.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Hecaton } from './hecaton';
import { chunk, receiptPreview, respond } from './mcp-output';
import { object, plainJson } from './values';
import { registerCatalog } from './mcp-tools-catalog';
import { registerDiscovery } from './mcp-tools-discovery';

const id = z.string().min(1).max(128);
const toolName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const page = {
  limit: z.int().min(1).max(100).default(20),
  offset: z.int().min(0).max(100000).default(0),
};
const request = {
  requestId: id,
  sessionId: id.optional(),
  tool: toolName,
  arguments: z.record(z.string(), z.unknown()),
};
export function createMcpServer(engine: Hecaton): McpServer {
  const server = new McpServer(
    { name: 'n2-hecaton', version: '1.0.0' },
    { maxToolInputElements: 8192 },
  );
  registerList(server, engine);
  registerRoute(server, engine);
  registerRead(server, engine);
  registerHistory(server, engine);
  registerStatus(server, engine);
  registerCall(server, engine);
  registerReconcile(server, engine);
  registerCatalog(server, engine);
  registerDiscovery(server, engine);
  return server;
}
function registerList(server: McpServer, engine: Hecaton): void {
  server.registerTool(
    'hecaton_list',
    {
      description: 'List available tool summaries. Read full schemas with hecaton_read.',
      inputSchema: z.object(page).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, offset }) =>
      respond(() => {
        const tools = engine.list();
        return {
          total: tools.length,
          tools: tools.slice(offset, offset + limit).map((tool) => ({
            name: tool.name,
            source: tool.source,
            version: tool.version,
            description: Array.from(tool.description).slice(0, 160).join(''),
            category: tool.category,
            readOnly: tool.readOnly,
            idempotent: tool.idempotent,
            definitionHash: tool.definitionHash,
          })),
          issueCount: engine.problems().length,
        };
      }),
  );
}
function registerRoute(server: McpServer, engine: Hecaton): void {
  server.registerTool(
    'hecaton_route',
    {
      description: 'Rank registered tools for a query and report estimated context bytes/tokens.',
      inputSchema: z
        .object({ query: z.string().max(4096), limit: z.int().min(1).max(32).default(3) })
        .strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) =>
      respond(() => {
        const result = engine.route(query, limit);
        return {
          ...result,
          matches: result.matches.map(({ tool, ...score }) => ({
            ...score,
            tool: { name: tool.name, definitionHash: tool.definitionHash },
          })),
        };
      }),
  );
}
function registerRead(server: McpServer, engine: Hecaton): void {
  server.registerTool(
    'hecaton_read',
    {
      description:
        'Read full tool, stored definition or execution JSON in Unicode-character chunks. Check sha256 across pages.',
      inputSchema: z
        .object({
          resource: z.enum(['tool', 'definition', 'call']),
          id,
          offset: z.int().min(0).max(1048576).default(0),
          limit: z.int().min(1).max(4096).default(2048),
        })
        .strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ resource, id, offset, limit }) =>
      respond(() => {
        const record =
          resource === 'tool'
            ? engine.list().find((tool) => tool.name === id)
            : resource === 'definition'
              ? engine.definitions().find((record) => record.name === id)
              : engine.status(id);
        if (!record) throw new Error('Requested record was not found in this scope');
        return chunk(record, offset, limit);
      }),
  );
}
function registerHistory(server: McpServer, engine: Hecaton): void {
  server.registerTool(
    'hecaton_history',
    {
      description: 'Read bounded durable execution summaries for this scope.',
      inputSchema: z.object(page).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, offset }) => respond(() => engine.history(limit, offset)),
  );
}
function registerStatus(server: McpServer, engine: Hecaton): void {
  server.registerTool(
    'hecaton_status',
    {
      description: 'Inspect one execution phase, active ownership and recovery requirements.',
      inputSchema: z.object({ requestId: id }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ requestId }) =>
      respond(() => {
        const status = engine.status(requestId);
        if (!status) return null;
        const { call, ...state } = status;
        return {
          ...state,
          requestId,
          tool: call.tool.name,
          state: call.state,
          attempts: call.attempts,
          experienceId: call.experienceId,
          reportedSuccess: call.result?.success ?? null,
          error: call.error,
          startedAt: call.startedAt,
          finishedAt: call.finishedAt,
        };
      }),
  );
}
function registerCall(server: McpServer, engine: Hecaton): void {
  server.registerTool(
    'hecaton_call',
    {
      description:
        'Execute one registered capability under a stable request ID and host policy. Read full results through hecaton_read.',
      inputSchema: z.object(request).strict(),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (input, extra) =>
      respond(async () =>
        receiptPreview(
          await engine.execute(
            {
              ...input,
              arguments: object(plainJson(input.arguments)),
            },
            extra.signal,
          ),
        ),
      ),
  );
}
function registerReconcile(server: McpServer, engine: Hecaton): void {
  server.registerTool(
    'hecaton_reconcile',
    {
      description:
        'Resolve an uncertain execution with the externally inspected outcome and evidence.',
      inputSchema: z
        .object({
          requestId: id,
          result: z.record(z.string(), z.unknown()),
          evidence: z.string().min(1).max(8192),
        })
        .strict(),
      annotations: { readOnlyHint: false },
    },
    async ({ requestId, result, evidence }) =>
      respond(() => receiptPreview(engine.reconcile(requestId, result, evidence))),
  );
}
