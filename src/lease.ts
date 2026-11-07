// Fence cross-process calls with renewable scoped ownership and bounded reader/writer admission.
import { randomUUID } from 'node:crypto';
import { identity, integer } from './values';
import { column, type HecatonStore, type ReadConnection } from './store';
const LEASE_MS = 30000;
const MAX_READERS = 4;

interface LeaseRow {
  request_id: string;
  nonce: string;
  process_id: number;
  expires_at: number;
  writing: number;
}
export class CallLease {
  readonly nonce = randomUUID();
  readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private renewAt = Date.now() + LEASE_MS / 3;
  private released = false;

  constructor(
    readonly store: HecatonStore,
    readonly requestId: string,
    writing: boolean,
  ) {
    identity(requestId, 'request ID');
    store.db.transaction(() => {
      const rows = leaseRows(store);
      const live = rows.filter(
        (row) => row.expires_at > Date.now() && processAlive(row.process_id),
      );
      for (const row of rows)
        if (!live.includes(row))
          store.db.execute('DELETE FROM hecaton_leases WHERE project=? AND agent=? AND nonce=?', [
            ...store.scope,
            row.nonce,
          ]);
      if (live.some((row) => row.request_id === requestId))
        throw new Error('This request already has an active owner');
      if ((writing && live.length) || live.some((row) => row.writing) || live.length >= MAX_READERS)
        throw new Error('Hecaton execution slots are busy');
      store.db.execute('INSERT INTO hecaton_leases VALUES(?,?,?,?,?,?,?)', [
        ...store.scope,
        requestId,
        this.nonce,
        process.pid,
        Date.now() + LEASE_MS,
        Number(writing),
      ]);
    });
    this.timer = setInterval(() => this.heartbeat(), 1000);
    this.timer.unref();
  }

  assert(): void {
    this.controller.signal.throwIfAborted();
    const row = leaseRows(this.store).find((row) => row.request_id === this.requestId);
    if (!row || row.nonce !== this.nonce || row.expires_at <= Date.now())
      throw new Error('Hecaton execution lease was lost or expired');
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    clearInterval(this.timer);
    this.controller.abort(new Error('Hecaton operation ended'));
    this.store.db.execute(
      'DELETE FROM hecaton_leases WHERE project=? AND agent=? AND request_id=? AND nonce=?',
      [...this.store.scope, this.requestId, this.nonce],
    );
  }

  private heartbeat(): void {
    try {
      this.store.db.transaction(() => {
        this.assert();
        if (Date.now() < this.renewAt) return;
        this.store.db.execute(
          'UPDATE hecaton_leases SET expires_at=? WHERE project=? AND agent=? AND request_id=? AND nonce=?',
          [Date.now() + LEASE_MS, ...this.store.scope, this.requestId, this.nonce],
        );
        this.renewAt = Date.now() + LEASE_MS / 3;
      });
    } catch (error) {
      clearInterval(this.timer);
      this.controller.abort(error);
    }
  }
}

export function leaseRows(store: { db: ReadConnection; scope: readonly string[] }): LeaseRow[] {
  const rows = store.db.query<LeaseRow>(
    `SELECT ${column('request_id', 128)},${column('nonce', 128)},process_id,expires_at,writing FROM hecaton_leases WHERE project=? AND agent=? LIMIT 5`,
    store.scope,
  );
  if (rows.length > MAX_READERS)
    throw new Error('Stored execution leases exceed the concurrency limit');
  for (const row of rows) {
    identity(row.request_id, 'lease request ID');
    identity(row.nonce, 'lease nonce');
    integer(row.process_id, 'lease process ID', 1, Number.MAX_SAFE_INTEGER);
    integer(row.expires_at, 'lease expiry', 0, Number.MAX_SAFE_INTEGER);
    integer(row.writing, 'lease write flag', 0, 1);
  }
  return rows;
}
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
