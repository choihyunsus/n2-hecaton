// Public host contracts separate execution identity from model-supplied arguments.
import type { JsonValue, ToolResult } from 'n2-gumiho';
export type { JsonValue, ToolResult } from 'n2-gumiho';
export type JsonObject = { [key: string]: JsonValue };

export interface ToolContext {
  readonly project: string;
  readonly agent: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly bindingId: string;
  readonly signal: AbortSignal;
}

export interface ToolMetadata {
  name: string;
  version: string;
  description: string;
  category?: string;
  triggers?: string[];
  tags?: string[];
  readOnly?: boolean;
  idempotent?: boolean;
  timeoutMs?: number;
  inputSchema: JsonObject;
}

export interface ToolDefinition extends ToolMetadata {
  execute(args: JsonObject, context: ToolContext): ToolResult | Promise<ToolResult>;
}

export interface ToolView {
  name: string;
  version: string;
  description: string;
  category: string;
  triggers: string[];
  tags: string[];
  readOnly: boolean;
  idempotent: boolean;
  timeoutMs: number;
  inputSchema: JsonObject;
  source: 'host' | 'n2r' | 'mcp';
  bindingId: string;
  definitionHash: string;
  bitfield: number;
  dna: string;
  card: string;
}

export interface ToolStatistics {
  usageCount: number;
  successes: number;
  lastUsedAt?: number | null;
}

export interface RouteMatch {
  name: string;
  score: number;
  scores: { trigger: number; keyword: number; dna: number; usage: number; success: number };
  tool: ToolView;
}

export interface RouteResult {
  matches: RouteMatch[];
  candidates: { total: number; domain: number; ranked: number };
  budget: { fullCatalogBytes: number; selectedBytes: number; estimatedTokens: number };
}
