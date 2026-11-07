// Preserve exact UTF-8 JSON-RPC frames and own the selected child process through shutdown.
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ResolvedMcpServer } from './mcp-config';
import { MAX_MCP_FRAME } from './mcp-budget';
import { JsonRpcFrames } from './mcp-frames';
type Child = ChildProcessByStdio<Writable, Readable, null>;
const EXIT_GRACE_MS = 1000;

export class StrictStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport['onmessage'];
  private child?: Child;
  private readonly frames = new JsonRpcFrames();
  private started = false;
  private notified = false;
  private closing?: Promise<void>;

  constructor(private readonly config: Extract<ResolvedMcpServer, { transport: 'stdio' }>) {}
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.started || this.closing)
      throw new Error('MCP transport has already started or closed');
    this.started = true;
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      env: this.config.env,
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: false,
      windowsHide: true,
    });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    child.stdout.on('error', () => this.fail());
    child.stdin.on('error', () => this.fail());
    child.once('close', () => this.notifyClosed());
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => {
        reject(new Error('MCP executable could not start'));
        this.fail();
      });
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    if (!child || this.closing || child.exitCode !== null)
      throw new Error('MCP process is disconnected');
    const encoded = Buffer.from(JSON.stringify(message) + '\n');
    if (encoded.length > MAX_MCP_FRAME) throw new Error('Outgoing MCP message exceeds its limit');
    await new Promise<void>((resolve, reject) =>
      child.stdin.write(encoded, (error) =>
        error ? reject(new Error('MCP stdin write failed')) : resolve(),
      ),
    );
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(() => this.shutdown());
    return this.closing;
  }

  private receive(chunk: Buffer): void {
    if (this.closing) return;
    try {
      this.frames.accept(chunk, (message) => {
        if (!this.closing) this.onmessage?.(message);
      });
    } catch {
      this.fail();
    }
  }

  private fail(): void {
    if (this.closing) return;
    this.onerror?.(
      new Error('MCP process transport failed or returned invalid bounded UTF-8 messages'),
    );
    void this.close().catch(() => this.notifyClosed());
  }
  private notifyClosed(): void {
    if (this.notified) return;
    this.notified = true;
    this.onclose?.();
  }
  private async shutdown(): Promise<void> {
    const child = this.child;
    try {
      if (!child) return;
      child.stdin.end();
      if (!(await exited(child, EXIT_GRACE_MS))) child.kill('SIGTERM');
      if (!(await exited(child, EXIT_GRACE_MS))) child.kill('SIGKILL');
      if (!(await exited(child, EXIT_GRACE_MS)))
        throw new Error('MCP process did not exit during bounded shutdown');
    } finally {
      child?.stdin.destroy();
      child?.stdout.destroy();
      this.child = undefined;
      this.frames.clear();
      this.notifyClosed();
    }
  }
}

function exited(child: Child, milliseconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (result: boolean): void => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(result);
    };
    const onExit = (): void => done(true);
    const timer = setTimeout(() => done(false), milliseconds);
    child.once('exit', onExit);
  });
}
