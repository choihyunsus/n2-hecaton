// Own bounded server stdio, including malformed input, EOF and blocked output shutdown.
import type { Readable, Writable } from 'node:stream';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { JsonRpcFrames } from './mcp-frames';
import { MAX_MCP_FRAME } from './mcp-budget';

export class ServerStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport['onmessage'];
  private readonly frames = new JsonRpcFrames();
  private started = false;
  private closed = false;
  private pending = 0;
  constructor(
    private readonly input: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
  ) {}
  async start(): Promise<void> {
    if (this.started || this.closed)
      throw new Error('MCP server transport already started or closed');
    this.started = true;
    this.input.on('data', this.receive);
    this.input.once('end', this.ended);
    this.input.once('error', this.failed);
    this.output.on('error', this.failed);
    this.input.resume();
    if (this.input.readableEnded || this.input.destroyed) this.ended();
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || !this.started) throw new Error('MCP server transport is disconnected');
    const encoded = Buffer.from(JSON.stringify(message) + '\n');
    if (encoded.length > MAX_MCP_FRAME || this.pending + encoded.length > 4 * MAX_MCP_FRAME) {
      this.failed();
      throw new Error('MCP server output exceeds its budget');
    }
    this.pending += encoded.length;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.failed();
          reject(new Error('MCP server output timed out'));
        }, 5000);
        this.output.write(encoded, (error) => {
          clearTimeout(timer);
          if (error) reject(new Error('MCP server output failed'));
          else resolve();
        });
      });
    } finally {
      this.pending -= encoded.length;
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.input.removeListener('data', this.receive);
    this.input.removeListener('end', this.ended);
    this.input.removeListener('error', this.failed);
    this.input.pause();
    this.frames.clear();
    if (this.pending) {
      this.output.once('close', () => this.output.removeListener('error', this.failed));
      this.output.destroy();
    } else this.output.removeListener('error', this.failed);
    this.onclose?.();
  }
  private readonly receive = (chunk: Buffer): void => {
    if (this.closed) return;
    try {
      this.frames.accept(chunk, (message) => {
        if (!this.closed) this.onmessage?.(message);
      });
    } catch {
      this.failed();
    }
  };
  private readonly ended = (): void => {
    if (this.frames.pendingBytes) this.failed();
    else void this.close();
  };
  private readonly failed = (): void => {
    if (this.closed) return;
    this.onerror?.(new Error('MCP server stdio failed or exceeded its bounded UTF-8 protocol'));
    void this.close();
  };
}
