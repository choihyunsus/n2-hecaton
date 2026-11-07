// Enforce per-frame size independently of how a pipe batches multiple JSON-RPC messages.
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { MAX_MCP_FRAME, ProtocolBudget } from './mcp-budget';

export class JsonRpcFrames {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly budget = new ProtocolBudget();
  get pendingBytes(): number {
    return this.buffer.length;
  }
  accept(chunk: Buffer, receive: (message: JSONRPCMessage) => void): void {
    this.budget.accept(chunk.length);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (this.buffer.length + end - start > MAX_MCP_FRAME)
        throw new Error('MCP frame exceeds its limit');
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(start, end)]);
      if (newline < 0) break;
      this.budget.accept(0, 1);
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.buffer);
      this.buffer = Buffer.alloc(0);
      receive(JSONRPCMessageSchema.parse(JSON.parse(text)));
      start = newline + 1;
    }
  }
  clear(): void {
    this.buffer = Buffer.alloc(0);
  }
}
