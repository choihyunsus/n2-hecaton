// Public MCP contracts contain serializable metadata without transport SDK declaration dependencies.
import type { JsonObject } from './types';
import type { DefinitionIssue } from './registry';

export class McpOperationError extends Error {
  constructor(readonly code: 'failed' | 'cancelled' | 'timeout') {
    super(`MCP operation ${code}`);
    this.name = 'McpOperationError';
  }
}

export interface McpToolPermission {
  readOnly?: boolean;
  idempotent?: boolean;
  timeoutMs?: number;
}
interface ServerIdentity {
  id: string;
  version: string;
  toolPermissions?: Record<string, McpToolPermission>;
}
export interface McpStdioServer extends ServerIdentity {
  transport: 'stdio';
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}
export interface McpHttpServer extends ServerIdentity {
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
}
export type McpServer = McpStdioServer | McpHttpServer;
export interface McpServerStatus {
  id: string;
  version: string;
  transport: 'stdio' | 'http';
  connected: boolean;
  processId: number | null;
}
export interface RemoteTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject | null;
  annotations: JsonObject;
  execution: JsonObject;
}
export interface McpDiscovery {
  serverId: string;
  configurationVersion: string;
  serverInfo: { name: string; version: string };
  tools: RemoteTool[];
}
export interface McpToolAnalysis {
  remote: RemoteTool;
  publicName: string | null;
  supported: boolean;
  reason: string | null;
  readOnly: boolean;
  idempotent: boolean;
  source: string | null;
}
export interface McpAnalysis extends Omit<McpDiscovery, 'tools'> {
  tools: McpToolAnalysis[];
}
export interface McpImportOptions {
  serverId: string;
  names: string[];
  expectedHashes?: Record<string, string | null>;
}
export interface McpImportResult {
  serverId: string;
  installed: { name: string; remoteName: string; contentHash: string; revision: number }[];
  registrationVerified: boolean;
  executionVerified: false;
  issues: DefinitionIssue[];
}
