// Settle cooperative or uncooperative callbacks while distinguishing host cancellation from deadlines.
export class Interrupted extends Error {
  constructor(readonly timedOut: boolean) {
    super(timedOut ? 'Operation deadline elapsed' : 'Operation was cancelled');
    this.name = 'Interrupted';
  }
}

export async function withDeadline<T>(
  callback: (signal: AbortSignal) => T | Promise<T>,
  milliseconds: number,
  parent: AbortSignal,
): Promise<T> {
  if (parent.aborted) throw new Interrupted(false);
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  let timer: NodeJS.Timeout | undefined;
  let onAbort = (): void => {};
  try {
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Interrupted(controller.signal.aborted));
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => controller.abort(), milliseconds);
      if (signal.aborted) onAbort();
    });
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal.aborted) throw new Interrupted(controller.signal.aborted);
        return callback(signal);
      }),
      interrupted,
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
