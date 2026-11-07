// Constrain MCP HTTP requests to the configured endpoint and validate bounded UTF-8 streams.
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { MAX_MCP_FRAME, ProtocolBudget } from './mcp-budget';

export function guardedFetch(
  endpoint: string,
  operationSignal: () => AbortSignal | undefined,
): FetchLike {
  const budget = new ProtocolBudget();
  return async (url, init = {}) => {
    if (new URL(url).href !== endpoint) throw new Error('MCP request left its configured endpoint');
    const method = init.method?.toUpperCase() ?? 'GET';
    if (!['GET', 'POST', 'DELETE'].includes(method)) throw new Error('Unsupported MCP HTTP method');
    const deadline = new AbortController();
    const signals = [
      init.signal,
      method === 'POST' ? operationSignal() : undefined,
      deadline.signal,
    ].filter((signal): signal is AbortSignal => !!signal);
    const headerTimeout = { DELETE: 2000, GET: 15000, POST: 120000 }[method]!;
    const timer = setTimeout(() => deadline.abort(), headerTimeout);
    try {
      const response = await fetch(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.any(signals),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error('MCP HTTP redirects are disabled');
      }
      if (!response.body) return response;
      const eventStream =
        response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ===
        'text/event-stream';
      return new Response(response.body.pipeThrough(checkedBody(eventStream, budget)), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

function checkedBody(
  eventStream: boolean,
  budget: ProtocolBudget,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const frames = new EventBudget(budget);
  let bytes = 0;
  return new TransformStream({
    transform(chunk, controller) {
      budget.accept(chunk.byteLength);
      bytes += chunk.byteLength;
      const text = decoder.decode(chunk, { stream: true });
      if (eventStream) frames.accept(text);
      else if (bytes > MAX_MCP_FRAME) throw new Error('MCP HTTP response exceeds its byte limit');
      controller.enqueue(chunk);
    },
    flush() {
      if (eventStream) frames.accept(decoder.decode());
      else {
        decoder.decode();
        budget.accept(0, 1);
      }
    },
  });
}

class EventBudget {
  private lineBytes = 0;
  private eventBytes = 0;
  private previousCR = false;
  constructor(private readonly budget: ProtocolBudget) {}
  accept(text: string): void {
    for (const character of text) {
      if (character === '\r' || character === '\n') {
        if (character !== '\n' || !this.previousCR) this.endLine();
        this.previousCR = character === '\r';
      } else {
        this.previousCR = false;
        this.lineBytes += Buffer.byteLength(character);
        if (this.lineBytes + this.eventBytes > MAX_MCP_FRAME)
          throw new Error('MCP SSE event exceeds its byte limit');
      }
    }
  }
  private endLine(): void {
    if (this.lineBytes === 0) {
      this.eventBytes = 0;
      this.budget.accept(0, 1);
    } else this.eventBytes += this.lineBytes + 1;
    this.lineBytes = 0;
  }
}
