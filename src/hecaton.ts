// Public engine composes registered capabilities, scoped persistence and guarded execution.
import { randomUUID } from 'node:crypto';
import type { GumihoTool } from 'n2-gumiho';
import { HecatonStore, type DefinitionRecord, type StoreOptions } from './store';
import { Registry, type DefinitionIssue } from './registry';
import { CallLease } from './lease';
import { CallStore } from './call-store';
import { callInput } from './call-record';
import { callStatus } from './call-status';
import { Execution, receipt, type ExecutionPolicy } from './execution';
import { Circuit, type CircuitStatus } from './circuit';
import { history, type HistoryItem } from './history';
import { fingerprint, identity, integer } from './values';
import { McpPool } from './mcp-pool';
import { importedEntry } from './mcp-proxy';
import { analyzeMcp, prepareImport } from './mcp-pipeline';
import type {
  McpServer,
  McpServerStatus,
  McpAnalysis,
  McpImportOptions,
  McpImportResult,
} from './mcp-types';
import type { CallStatus, ExecutionReceipt, ExecutionRequest } from './call-types';
export type { CallStatus } from './call-types';
import type { JsonObject, RouteResult, ToolDefinition, ToolStatistics, ToolView } from './types';

export interface HecatonOptions extends StoreOptions {
  tools: ToolDefinition[];
  policy?: ExecutionPolicy;
  policyTimeoutMs?: number;
  mcpServers?: McpServer[];
}

export class Hecaton {
  private readonly store: HecatonStore;
  private readonly registry: Registry;
  private readonly calls: CallStore;
  private readonly execution: Execution;
  private readonly policy: ExecutionPolicy;
  private readonly mcpPool: McpPool;
  private readonly controller = new AbortController();
  private readonly active = new Set<Promise<ExecutionReceipt>>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(options: HecatonOptions) {
    this.policy = checkedPolicy(options.policy);
    const timeout = integer(options.policyTimeoutMs ?? 30000, 'authorization timeout', 1, 120000);
    this.mcpPool = new McpPool(options.mcpServers);
    this.store = new HecatonStore(options);
    try {
      this.registry = new Registry(this.store, options.tools, (record) =>
        importedEntry(this.mcpPool, record),
      );
      this.calls = new CallStore(this.store);
      this.execution = new Execution(this.store, this.policy, timeout);
    } catch (error) {
      this.store.close();
      throw error;
    }
  }

  async execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionReceipt> {
    this.assertOpen();
    if (this.active.size >= 4) throw new Error('Local Hecaton execution slots are busy');
    const entry = this.registry.get(request.tool);
    const input = callInput(request, entry, this.policy.version);
    let preflight: string | null = null;
    try {
      entry.schema.check(input.arguments);
      entry.guard?.(input.arguments);
    } catch (error) {
      preflight =
        error instanceof Error
          ? Array.from(error.message).slice(0, 1000).join('')
          : 'Input checks failed';
    }
    const combined = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
    const task = Promise.resolve().then(() =>
      this.execution.run(input, entry, preflight, combined),
    );
    this.active.add(task);
    try {
      return await task;
    } finally {
      this.active.delete(task);
    }
  }

  mcpServers(): McpServerStatus[] {
    this.assertOpen();
    return this.mcpPool.information();
  }
  async discoverMcp(serverId: string, signal?: AbortSignal): Promise<McpAnalysis> {
    this.assertOpen();
    const combined = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
    const analysis = await analyzeMcp(this.mcpPool, serverId, combined);
    this.assertOpen();
    return analysis;
  }
  async importMcp(options: McpImportOptions, signal?: AbortSignal): Promise<McpImportResult> {
    this.assertOpen();
    const combined = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
    const prepared = await prepareImport(this.mcpPool, options, combined);
    combined.throwIfAborted();
    return this.configure(() => {
      const records = this.registry.installImported(
        prepared.plans.map((plan) => ({
          name: plan.name,
          content: plan.content,
          expectedHash: Object.hasOwn(prepared.expected, plan.name)
            ? prepared.expected[plan.name]!
            : null,
        })),
      );
      const views = new Map(this.registry.list().map((view) => [view.name, view]));
      const stored = new Map(this.store.definitions().map((record) => [record.name, record]));
      const result: McpImportResult = {
        serverId: prepared.serverId,
        installed: records.map((record, index) => ({
          name: record.name,
          remoteName: prepared.plans[index]!.remoteName,
          contentHash: record.contentHash,
          revision: record.revision,
        })),
        registrationVerified: records.every(
          (record) =>
            views.get(record.name)?.source === 'mcp' &&
            stored.get(record.name)?.contentHash === record.contentHash,
        ),
        executionVerified: false,
        issues: this.registry.problems(),
      };
      return result;
    });
  }

  list(): ToolView[] {
    this.assertOpen();
    return this.registry.list();
  }
  problems(): DefinitionIssue[] {
    this.assertOpen();
    return this.registry.problems();
  }
  definitions(): DefinitionRecord[] {
    this.assertOpen();
    return this.store.definitions();
  }
  route(query: string, limit = 3): RouteResult {
    this.assertOpen();
    const statistics = new Map(
      this.list().map((tool) => [tool.name, this.calls.statistics(tool.name, tool.definitionHash)]),
    );
    return this.registry.route(query, limit, statistics);
  }
  async auto(
    request: Omit<ExecutionRequest, 'tool'> & { query: string },
    signal?: AbortSignal,
  ): Promise<{ route: RouteResult; execution: ExecutionReceipt }> {
    const route = this.route(request.query, 1);
    const selected = route.matches[0];
    if (!selected) throw new Error('No registered tool matches this routing query');
    return { route, execution: await this.execute({ ...request, tool: selected.name }, signal) };
  }

  installSource(source: string, expectedHash: string | null = null): DefinitionRecord {
    return this.configure(() => this.registry.installSource(source, expectedHash));
  }
  removeDefinition(name: string, expectedHash: string): void {
    this.configure(() => this.registry.remove(name, expectedHash));
  }
  reload(): DefinitionIssue[] {
    return this.configure(() => {
      this.registry.refresh();
      return this.registry.problems();
    });
  }

  status(requestId: string): CallStatus | undefined {
    this.assertOpen();
    return callStatus(this.store.db, this.store.scope, requestId);
  }
  history(limit = 50, offset = 0): HistoryItem[] {
    this.assertOpen();
    return history(this.store.db, this.store.scope, limit, offset);
  }
  statistics(toolName: string): ToolStatistics {
    this.assertOpen();
    const tool = this.registry.get(toolName).view;
    return this.calls.statistics(tool.name, tool.definitionHash);
  }
  circuit(toolName: string): CircuitStatus {
    this.assertOpen();
    return new Circuit(this.store).status(this.registry.get(toolName));
  }

  reconcile(requestId: string, result: unknown, evidence: string): ExecutionReceipt {
    this.assertOpen();
    identity(evidence, 'reconciliation evidence', 8192);
    const lease = new CallLease(this.store, identity(requestId, 'request ID'), true);
    try {
      const current = this.calls.required(requestId);
      if (
        current.state === 'prepared' ||
        current.state === 'blocked' ||
        (current.state === 'completed' && current.evidence === null)
      )
        throw new Error('Only uncertain or previously reconciled outcomes accept evidence');
      return receipt(
        this.calls.complete(lease, result, false, evidence),
        current.state === 'completed',
      );
    } finally {
      lease.release();
    }
  }

  asGumihoTools(names: string[]): GumihoTool[] {
    this.assertOpen();
    if (!Array.isArray(names) || names.length > 64 || new Set(names).size !== names.length)
      throw new Error('Select at most 64 distinct tool names');
    return names.map((name) => {
      const view = structuredClone(this.registry.get(name).view);
      return {
        name: view.name,
        description: view.description,
        inputSchema: view.inputSchema,
        readOnly: view.readOnly,
        idempotent: true,
        version: fingerprint({
          protocol: 1,
          storageId: this.store.storageId,
          scope: this.store.scope,
          definitionHash: view.definitionHash,
          policyVersion: this.policy.version,
        }),
        execute: async (args, context) => {
          this.assertOpen();
          if (context.project !== this.store.scope[0] || context.agent !== this.store.scope[1])
            throw new Error('Gumiho and Hecaton scopes differ');
          if (this.registry.get(view.name).view.definitionHash !== view.definitionHash)
            throw new Error(
              'The selected Hecaton capability changed; rebuild the host tool catalog',
            );
          const requestId = fingerprint({
            run: identity(context.runId, 'Gumiho run ID'),
            job: identity(context.jobId, 'Gumiho job ID'),
            call: identity(context.callId, 'Gumiho call ID'),
            tail: identity(context.tailId, 'Gumiho tail ID'),
          });
          const response = await this.execute(
            { requestId, sessionId: context.runId, tool: view.name, arguments: args as JsonObject },
            context.signal,
          );
          return response.result;
        },
      };
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.controller.abort(new Error('Hecaton is closing'));
    this.closing = (async () => {
      await Promise.allSettled([...this.active]);
      try {
        await this.mcpPool.close();
      } finally {
        this.registry.close();
        this.store.close();
      }
    })();
    return this.closing;
  }

  private configure<T>(action: () => T): T {
    this.assertOpen();
    if (this.active.size) throw new Error('Wait for local executions before changing the catalog');
    const lease = new CallLease(this.store, `configure-${randomUUID()}`, true);
    try {
      return action();
    } finally {
      lease.release();
    }
  }
  private assertOpen(): void {
    if (this.closed) throw new Error('Hecaton is closed');
  }
}

function checkedPolicy(value?: ExecutionPolicy): ExecutionPolicy {
  if (value === undefined) return { version: 'host-registered-v1', authorize: () => true };
  if (!value || typeof value.authorize !== 'function')
    throw new Error('Invalid host authorization policy');
  return Object.freeze({
    version: identity(value.version, 'policy version'),
    authorize: value.authorize.bind(value),
  });
}
