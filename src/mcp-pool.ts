// Reuse stateful MCP sessions while limiting concurrency and never replaying a tool POST internally.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StrictStdioTransport } from './mcp-stdio';
import { guardedFetch } from './mcp-http';
import {
  servers,
  DEFAULT_MCP_PERMISSION,
  type ResolvedMcpServer,
  type ResolvedPermission,
} from './mcp-config';
import { Permits } from './mcp-permits';
import { Interrupted, withDeadline } from './deadline';
import { integer, name } from './values';
import { McpOperationError, type McpServer, type McpServerStatus } from './mcp-types';
export { McpOperationError } from './mcp-types';
const SETUP_TIMEOUT_MS = 15000;

interface Session {
  id: string;
  client: Client;
  transport: Transport;
  http?: StreamableHTTPClientTransport;
  stdio?: StrictStdioTransport;
  signal?: AbortSignal;
  closed: boolean;
  closing?: Promise<void>;
}

export class McpPool {
  private readonly configured: Map<string, ResolvedMcpServer>;
  private readonly sessions = new Map<string, Session>();
  private readonly gates = new Map<string, Permits>();
  private readonly global = new Permits(2);
  private readonly controller = new AbortController();
  private readonly requests = new Set<Promise<unknown>>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly closingSessions = new Set<Promise<void>>();
  private closed = false;
  private shutdownFailed = false;
  private closing?: Promise<void>;

  constructor(configurations: McpServer[] = []) {
    this.configured = servers(configurations);
    for (const id of this.configured.keys()) this.gates.set(id, new Permits(1));
  }

  information(): McpServerStatus[] {
    return [...this.configured.values()].map((server) => ({
      id: server.id,
      version: server.version,
      transport: server.transport,
      connected: !!this.sessions.get(server.id),
      processId: this.sessions.get(server.id)?.stdio?.pid ?? null,
    }));
  }
  version(id: string): string {
    return this.configuration(id).version;
  }
  permission(id: string, tool: string): ResolvedPermission {
    const policies = this.configuration(id).toolPermissions;
    return { ...(Object.hasOwn(policies, tool) ? policies[tool]! : DEFAULT_MCP_PERMISSION) };
  }

  async run<T>(
    id: string,
    operation: (client: Client, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    timeout = SETUP_TIMEOUT_MS,
  ): Promise<T> {
    if (this.closed) throw new Error('MCP client pool is closed');
    const server = this.configuration(id);
    integer(timeout, 'MCP operation timeout', 1, 120000);
    const combined = AbortSignal.any([signal, this.controller.signal]);
    const request = withDeadline(
      (current) => {
        const inner = this.perform(server, operation, current);
        this.operations.add(inner);
        void inner.finally(() => this.operations.delete(inner)).catch(() => {});
        return inner;
      },
      timeout,
      combined,
    );
    this.requests.add(request);
    try {
      return await request;
    } catch (error) {
      throw new McpOperationError(
        error instanceof Interrupted ? (error.timedOut ? 'timeout' : 'cancelled') : 'failed',
      );
    } finally {
      this.requests.delete(request);
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.controller.abort();
    this.closing = (async () => {
      const closing = [...this.sessions.values()].map((session) => this.discard(session));
      await Promise.allSettled([...this.requests, ...this.operations]);
      const outcomes = await Promise.allSettled([...closing, ...this.closingSessions]);
      if (this.shutdownFailed || outcomes.some((outcome) => outcome.status === 'rejected'))
        throw new Error('An owned MCP session could not finish shutdown');
    })();
    return this.closing;
  }

  private configuration(id: string): ResolvedMcpServer {
    const server = this.configured.get(name(id, 'MCP server ID'));
    if (!server) throw new Error('MCP server is outside the host configuration');
    return server;
  }

  private async perform<T>(
    server: ResolvedMcpServer,
    operation: (client: Client, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const releaseServer = await this.gates.get(server.id)!.acquire(signal);
    let releaseGlobal: (() => void) | undefined, session: Session | undefined;
    try {
      releaseGlobal = await this.global.acquire(signal);
      signal.throwIfAborted();
      session = await this.connect(server, signal);
      session.signal = signal;
      return await operation(session.client, signal);
    } catch (error) {
      if (session) await this.discard(session);
      throw error;
    } finally {
      if (session?.signal === signal) session.signal = undefined;
      releaseGlobal?.();
      releaseServer();
    }
  }

  private async connect(server: ResolvedMcpServer, signal: AbortSignal): Promise<Session> {
    const existing = this.sessions.get(server.id);
    if (existing && !existing.closed) return existing;
    const session = this.createSession(server, signal);
    this.sessions.set(server.id, session);
    try {
      await session.client.connect(session.transport, {
        signal,
        timeout: SETUP_TIMEOUT_MS,
        maxTotalTimeout: SETUP_TIMEOUT_MS,
      });
      return session;
    } catch (error) {
      await this.discard(session);
      throw error;
    }
  }

  private createSession(server: ResolvedMcpServer, signal: AbortSignal): Session {
    const client = new Client(
      { name: 'n2-hecaton', version: '1.0.0' },
      { capabilities: {}, enforceStrictCapabilities: true },
    );
    let session: Session;
    if (server.transport === 'stdio') {
      const transport = new StrictStdioTransport(server);
      session = { id: server.id, client, transport, stdio: transport, signal, closed: false };
    } else {
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers, redirect: 'error' },
        fetch: guardedFetch(server.url, () => session.signal),
        reconnectionOptions: {
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 5000,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 2,
        },
      });
      session = { id: server.id, client, transport, http: transport, signal, closed: false };
    }
    client.onerror = () => {
      /* Requests and bounded transports determine whether recovery succeeded. */
    };
    client.onclose = () => {
      session.closed = true;
      if (this.sessions.get(server.id) === session) this.sessions.delete(server.id);
    };
    return session;
  }

  private discard(session: Session): Promise<void> {
    if (session.closing) return session.closing;
    session.closed = true;
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    session.closing = Promise.resolve().then(async () => {
      if (session.http) await session.http.terminateSession().catch(() => {});
      await session.client.close();
    });
    this.closingSessions.add(session.closing);
    void session.closing.then(
      () => this.closingSessions.delete(session.closing!),
      () => {
        this.shutdownFailed = true;
        this.closingSessions.delete(session.closing!);
      },
    );
    return session.closing;
  }
}
