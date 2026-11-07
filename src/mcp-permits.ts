// Bound queued and active MCP operations while promptly releasing cancelled waiters.
interface Waiter {
  signal: AbortSignal;
  resolve(release: () => void): void;
  reject(error: Error): void;
  abort(): void;
}
export class Permits {
  private readonly waiting: Waiter[] = [];
  constructor(private available: number) {}
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error('MCP operation was cancelled'));
    if (this.available > 0) {
      this.available--;
      return Promise.resolve(this.releaseToken());
    }
    if (this.waiting.length >= 32) return Promise.reject(new Error('MCP operation queue is full'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new Error('MCP operation was cancelled'));
        },
      };
      this.waiting.push(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
      if (signal.aborted) waiter.abort();
    });
  }
  private releaseToken(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.available++;
      const waiter = this.waiting.shift();
      if (waiter) {
        waiter.signal.removeEventListener('abort', waiter.abort);
        this.available--;
        waiter.resolve(this.releaseToken());
      }
    };
  }
}
