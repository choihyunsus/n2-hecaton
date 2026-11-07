// Async fd writes keep Windows pipe backpressure from blocking cancellation and deadline timers.
import { write } from 'node:fs';
import { Writable } from 'node:stream';
export class BoundedOutput extends Writable {
  private pending?: Promise<void>;
  private abandoned = false;
  constructor() {
    super();
    this.on('error', () => {});
  }
  override _write(
    buffer: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    let release!: () => void,
      settled = false;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending = pending;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (this.pending === pending) this.pending = undefined;
      callback(error);
      release();
    };
    const timer = setTimeout(() => {
      this.abandoned = true;
      finish(new Error('Output consumer exceeded its deadline'));
    }, 5000);
    writeAll(buffer, 0, () => !settled, finish);
  }
  async settle(): Promise<boolean> {
    while (this.pending) await this.pending;
    return this.abandoned;
  }
}
function writeAll(
  buffer: Buffer,
  offset: number,
  accepting: () => boolean,
  finish: (error?: Error) => void,
): void {
  write(1, buffer, offset, buffer.length - offset, null, (error, written) => {
    if (!accepting()) return;
    if (error?.code === 'EAGAIN' || error?.code === 'EWOULDBLOCK') {
      setTimeout(() => {
        if (accepting()) writeAll(buffer, offset, accepting, finish);
      }, 5);
      return;
    }
    if (error || written < 1) {
      finish(new Error('Output stream failed'));
      return;
    }
    const next = offset + written;
    if (next >= buffer.length) finish();
    else writeAll(buffer, next, accepting, finish);
  });
}
