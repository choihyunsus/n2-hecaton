// Build real remote proxies from pinned metadata and host-owned capability grants.
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { InputSchema } from './schema';
import { hostEntry, checkedResult, type ToolEntry } from './tool-entry';
import { compileTool } from './n2r-tool';
import { classify } from './taxonomy';
import { fingerprint, identity, name, object, plainJson, text } from './values';
import { readCatalog, remoteHash, remoteTool } from './mcp-discovery';
import type { McpDiscovery, RemoteTool } from './mcp-types';
import type { McpPool } from './mcp-pool';
import type { DefinitionRecord } from './store';
import type { JsonObject, JsonValue, ToolContext, ToolResult } from './types';

export interface McpImportContent {
  protocol: 1;
  serverId: string;
  configurationVersion: string;
  serverInfo: McpDiscovery['serverInfo'];
  remote: RemoteTool;
  remoteHash: string;
  source: string;
}
export interface McpPlan {
  name: string;
  remoteName: string;
  content: string;
  source: string;
  readOnly: boolean;
  idempotent: boolean;
}

export function planTool(pool: McpPool, discovery: McpDiscovery, remote: RemoteTool): McpPlan {
  const toolName = publicName(discovery.serverId, remote.name),
    bindingId = remoteBinding(discovery.serverId, remote.name);
  const permission = pool.permission(discovery.serverId, remote.name);
  const hash = remoteHash(remote, discovery.serverInfo);
  const source = `@meta { name: ${JSON.stringify(toolName)} handler: ${JSON.stringify(bindingId)} enforce: strict
  version: ${JSON.stringify(hash)} read_only: ${permission.readOnly} idempotent: ${permission.idempotent} triggers: [${JSON.stringify(remote.name)}] }
@workflow Invoke { step call { action: ${JSON.stringify(bindingId)} timeout: ${permission.timeoutMs}ms output -> $RESULT } }`;
  const content = JSON.stringify({
    protocol: 1,
    serverId: discovery.serverId,
    configurationVersion: discovery.configurationVersion,
    serverInfo: discovery.serverInfo,
    remote,
    remoteHash: hash,
    source,
  });
  text(content, 'MCP definition', 131072);
  const compiled = importedEntry(pool, { name: toolName, content });
  compiled.dispose?.();
  return {
    name: toolName,
    remoteName: remote.name,
    content,
    source,
    readOnly: permission.readOnly,
    idempotent: permission.idempotent,
  };
}

export function importedEntry(
  pool: McpPool,
  record: Pick<DefinitionRecord, 'name' | 'content'>,
): ToolEntry {
  const content = decodeImport(record.content);
  if (pool.version(content.serverId) !== content.configurationVersion)
    throw new Error('Registered MCP configuration version changed');
  const remote = content.remote;
  if (remote.execution.taskSupport === 'required')
    throw new Error('Required task-based MCP tools need a task-capable host');
  const output = remote.outputSchema === null ? undefined : new InputSchema(remote.outputSchema);
  const permission = pool.permission(content.serverId, remote.name);
  const base = hostEntry({
    name: name(record.name),
    version: content.remoteHash,
    description: remote.description,
    category: classify({ name: remote.name, description: remote.description }).domain,
    inputSchema: remote.inputSchema,
    ...permission,
    execute: (args, context) => invokeRemote(pool, content, output, args, context),
  });
  base.view.bindingId = remoteBinding(content.serverId, remote.name);
  base.capabilityHash = fingerprint({
    protocol: 1,
    serverId: content.serverId,
    configurationVersion: content.configurationVersion,
    remoteHash: content.remoteHash,
    permission,
  });
  base.view.definitionHash = fingerprint({
    capabilityHash: base.capabilityHash,
    metadata: base.view as unknown as JsonValue,
  });
  const entry = compileTool(content.source, (id) => {
    if (id !== base.view.bindingId)
      throw new Error('Imported source refers to a different MCP binding');
    return base;
  });
  if (entry.view.name !== record.name) {
    entry.dispose?.();
    throw new Error('Imported source name differs from its record');
  }
  entry.view.source = 'mcp';
  return entry;
}

function decodeImport(raw: string): McpImportContent {
  const value = object(
    plainJson(JSON.parse(text(raw, 'MCP import record', 131072)), 131072, 16384, 24),
  );
  if (value.protocol !== 1) throw new Error('Unsupported MCP import record');
  const info = object(value.serverInfo!);
  const serverInfo = {
    name: text(info.name, 'remote server name', 256),
    version: text(info.version, 'remote server version', 128),
  };
  const remote = remoteTool(value.remote);
  const hash = remoteHash(remote, serverInfo);
  if (value.remoteHash !== hash) throw new Error('Stored remote tool metadata hash mismatch');
  return {
    protocol: 1,
    serverId: name(value.serverId, 'MCP server ID'),
    configurationVersion: identity(value.configurationVersion, 'MCP configuration version'),
    serverInfo,
    remote,
    remoteHash: hash,
    source: text(value.source, 'generated N2R source'),
  };
}

async function invokeRemote(
  pool: McpPool,
  content: McpImportContent,
  output: InputSchema | undefined,
  args: JsonObject,
  context: ToolContext,
): Promise<ToolResult> {
  let invoked = false;
  try {
    return await pool.run(
      content.serverId,
      async (client, signal) => {
        const catalog = await readCatalog(client, signal);
        const listed = catalog.tools.find((tool) => tool.name === content.remote.name);
        if (!listed || remoteHash(listed, catalog.serverInfo) !== content.remoteHash)
          return {
            success: false,
            output: 'Remote MCP metadata changed; inspect and import its new definition',
          };
        signal.throwIfAborted();
        invoked = true;
        const result = await client.callTool(
          { name: content.remote.name, arguments: args },
          CallToolResultSchema,
          { signal, timeout: 120000, maxTotalTimeout: 120000 },
        );
        return normalizeResult(result, output);
      },
      context.signal,
      120000,
    );
  } catch (error) {
    if (!invoked)
      return { success: false, output: 'MCP preparation failed before tool invocation' };
    throw error;
  }
}

function normalizeResult(value: unknown, output: InputSchema | undefined): ToolResult {
  const result = CallToolResultSchema.parse(value);
  if (output && result.structuredContent !== undefined)
    output.check(result.structuredContent, 131072);
  else if (output && !result.isError)
    throw new Error('MCP tool omitted its declared structured output');
  const raw = object(plainJson(result, 131072, 8192, 24));
  const fullText = result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  const preview = Array.from(fullText).slice(0, 1000).join('');
  return checkedResult(
    {
      success: !result.isError,
      output: preview || (result.isError ? 'MCP tool returned an error' : 'MCP tool completed'),
      data: { mcp: raw, outputTruncated: preview.length !== fullText.length },
    },
    false,
  );
}

function publicName(serverId: string, remoteName: string): string {
  const direct = `${serverId}_${remoteName}`;
  return /^[A-Za-z0-9_-]{1,64}$/.test(direct)
    ? direct
    : `mcp_${fingerprint({ serverId, remoteName }).slice(0, 48)}`;
}
function remoteBinding(serverId: string, remoteName: string): string {
  return `mcp:${serverId}|${encodeURIComponent(remoteName)}`;
}
