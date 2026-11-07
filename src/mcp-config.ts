// Snapshot operator-selected MCP endpoints and keep credentials outside persisted tool metadata.
import fs from 'node:fs';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { identity, integer, name, text } from './values';
import type { McpServer, McpStdioServer, McpHttpServer, McpToolPermission } from './mcp-types';
const MAX_CONFIG_TEXT = 8192;

export type ResolvedPermission = Required<McpToolPermission>;
export const DEFAULT_MCP_PERMISSION: ResolvedPermission = {
  readOnly: false,
  idempotent: false,
  timeoutMs: 120000,
};
export type ResolvedMcpServer =
  | (McpStdioServer & {
      args: string[];
      env: Record<string, string>;
      toolPermissions: Record<string, ResolvedPermission>;
    })
  | (McpHttpServer & {
      headers: Record<string, string>;
      toolPermissions: Record<string, ResolvedPermission>;
    });

export function servers(values: McpServer[] = []): Map<string, ResolvedMcpServer> {
  if (!Array.isArray(values) || values.length > 16)
    throw new Error('Register at most 16 MCP servers');
  const result = new Map<string, ResolvedMcpServer>();
  for (const value of values) {
    if (!value) throw new Error('Invalid MCP server configuration');
    const id = name(value.id, 'MCP server ID'),
      version = identity(value.version, 'MCP server version');
    if ([...result.keys()].some((key) => key.toLowerCase() === id.toLowerCase()))
      throw new Error('MCP server IDs collide');
    if (value.transport === 'stdio') result.set(id, stdioServer(value, id, version));
    else if (value.transport === 'http')
      result.set(id, {
        id,
        version,
        transport: 'http',
        url: endpoint(value.url),
        headers: headers(value.headers),
        toolPermissions: permissions(value.toolPermissions),
      });
    else throw new Error('Unsupported MCP transport');
  }
  return result;
}

function stdioServer(value: McpStdioServer, id: string, version: string): ResolvedMcpServer {
  if (!Array.isArray(value.args ?? []) || (value.args?.length ?? 0) > 128)
    throw new Error('Invalid MCP executable arguments');
  const args = (value.args ?? []).map((arg) =>
    text(arg, 'MCP executable argument', MAX_CONFIG_TEXT),
  );
  if (Buffer.byteLength(JSON.stringify(args)) > 65536)
    throw new Error('MCP executable arguments exceed their limit');
  const env = environment(value.env);
  let cwd: string | undefined;
  if (value.cwd !== undefined) {
    cwd = fs.realpathSync.native(identity(value.cwd, 'MCP working directory', MAX_CONFIG_TEXT));
    if (!fs.statSync(cwd).isDirectory())
      throw new Error('MCP working directory must be a directory');
  }
  return {
    id,
    version,
    transport: 'stdio',
    command: identity(value.command, 'MCP executable', MAX_CONFIG_TEXT),
    args,
    cwd,
    env,
    toolPermissions: permissions(value.toolPermissions),
  };
}
function permissions(
  value: Record<string, McpToolPermission> = {},
): Record<string, ResolvedPermission> {
  const entries = Object.entries(value);
  if (entries.length > 128) throw new Error('MCP tool permission map exceeds its count limit');
  return Object.fromEntries(
    entries.map(([tool, raw]) => {
      identity(tool, 'remote tool permission name');
      if (
        !raw ||
        Object.keys(raw).some((key) => !['readOnly', 'idempotent', 'timeoutMs'].includes(key))
      )
        throw new Error('Unsupported MCP tool permission field');
      const readOnly = raw.readOnly === undefined ? false : raw.readOnly,
        idempotent = raw.idempotent === undefined ? readOnly : raw.idempotent;
      if (typeof readOnly !== 'boolean' || typeof idempotent !== 'boolean')
        throw new Error('MCP capability grants must be booleans');
      return [
        tool,
        {
          readOnly,
          idempotent,
          timeoutMs: integer(
            raw.timeoutMs === undefined ? DEFAULT_MCP_PERMISSION.timeoutMs : raw.timeoutMs,
            'MCP tool timeout',
            1,
            DEFAULT_MCP_PERMISSION.timeoutMs,
          ),
        },
      ];
    }),
  );
}
function environment(value: Record<string, string> = {}): Record<string, string> {
  const entries = Object.entries(value);
  if (entries.length > 64) throw new Error('MCP environment exceeds its variable limit');
  const seen = new Set<string>(),
    result = { ...getDefaultEnvironment() };
  for (const [key, raw] of entries) {
    const normalized = process.platform === 'win32' ? key.toUpperCase() : key;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || seen.has(normalized))
      throw new Error('Invalid or duplicate MCP environment name');
    seen.add(normalized);
    Object.defineProperty(result, normalized, {
      value: text(raw, 'MCP environment value', MAX_CONFIG_TEXT),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 65536)
    throw new Error('MCP environment exceeds its byte limit');
  return result;
}
function headers(value: Record<string, string> = {}): Record<string, string> {
  const entries = Object.entries(value);
  if (entries.length > 32) throw new Error('MCP headers exceed their count limit');
  const result = new Headers();
  for (const [key, raw] of entries) {
    const normalized = key.toLowerCase();
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(key) ||
      result.has(normalized) ||
      [
        'host',
        'connection',
        'content-length',
        'content-type',
        'accept',
        'mcp-session-id',
        'mcp-protocol-version',
        'last-event-id',
      ].includes(normalized)
    )
      throw new Error('Invalid, duplicate or transport-managed MCP header');
    const item = text(raw, 'MCP header value', MAX_CONFIG_TEXT);
    if (/[\r\n]/u.test(item)) throw new Error('MCP header values must occupy one line');
    result.set(normalized, item);
  }
  const copied = Object.fromEntries(result.entries());
  if (Buffer.byteLength(JSON.stringify(copied)) > 32768)
    throw new Error('MCP headers exceed their byte limit');
  return copied;
}
function endpoint(value: unknown): string {
  const raw = identity(value, 'MCP endpoint', 4096);
  const url = new URL(raw);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (
    raw !== raw.trim() ||
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  )
    throw new Error(
      'MCP endpoints require HTTPS or literal loopback HTTP without URL credentials or fragments',
    );
  return url.href;
}
