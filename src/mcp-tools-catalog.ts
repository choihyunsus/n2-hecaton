// Catalog mutations return compact receipts so a successful commit always fits the response budget.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Hecaton } from './hecaton';
import { respond } from './mcp-output';

const name = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const page = {
  limit: z.int().min(1).max(20).default(20),
  offset: z.int().min(0).max(512).default(0),
};
export function registerCatalog(server: McpServer, engine: Hecaton): void {
  registerDefinitions(server, engine);
  registerInstall(server, engine);
  registerRemove(server, engine);
  registerIssues(server, engine);
  registerReload(server, engine);
}
function registerDefinitions(server: McpServer, engine: Hecaton): void {
  server.registerTool(
    'hecaton_definitions',
    {
      description: 'List saved tool-definition identities and revision hashes.',
      inputSchema: z.object(page).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, offset }) =>
      respond(() => {
        const records = engine.definitions();
        return {
          total: records.length,
          definitions: records
            .slice(offset, offset + limit)
            .map(({ content, ...metadata }) => ({
              ...metadata,
              contentBytes: Buffer.byteLength(content),
            })),
        };
      }),
  );
}
function registerInstall(server: McpServer, engine: Hecaton): void {
  server.registerTool(
    'hecaton_install',
    {
      description:
        'Validate and install strict N2R tool data bound to an existing capability. Replacements require the current content hash.',
      inputSchema: z
        .object({ source: z.string().max(65536), expectedHash: hash.nullable().default(null) })
        .strict(),
      annotations: { readOnlyHint: false },
    },
    async ({ source, expectedHash }) =>
      respond(() => {
        const { content, ...record } = engine.installSource(source, expectedHash);
        return { ...record, contentBytes: Buffer.byteLength(content) };
      }),
  );
}
function registerRemove(server: McpServer, engine: Hecaton): void {
  server.registerTool(
    'hecaton_remove',
    {
      description:
        'Remove a saved definition at its expected content hash while retaining execution history.',
      inputSchema: z.object({ name, expectedHash: hash }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ name, expectedHash }) =>
      respond(() => {
        engine.removeDefinition(name, expectedHash);
        return { removed: name };
      }),
  );
}
function registerIssues(server: McpServer, engine: Hecaton): void {
  server.registerTool(
    'hecaton_issues',
    {
      description: 'Read unavailable or invalid saved-definition diagnostics.',
      inputSchema: z.object(page).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, offset }) =>
      respond(() => ({
        total: engine.problems().length,
        issues: engine.problems().slice(offset, offset + limit),
      })),
  );
}
function registerReload(server: McpServer, engine: Hecaton): void {
  server.registerTool(
    'hecaton_reload',
    {
      description: 'Reload saved definitions after another host changed the catalog.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: false },
    },
    async () =>
      respond(() => ({ issueCount: engine.reload().length, toolCount: engine.list().length })),
  );
}
