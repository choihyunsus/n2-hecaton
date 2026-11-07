// Share breaker state across aliases and fence late completions by capability version and epoch.
import { identity, integer } from './values';
import { column, type HecatonStore } from './store';
import { leaseRows, processAlive, type CallLease } from './lease';
import type { ToolEntry } from './tool-entry';
const FAILURE_LIMIT = 3;
const COOLDOWN_MS = 60000;

interface CircuitRow {
  failures: number;
  epoch: number;
  opened_at: number | null;
  probe_nonce: string | null;
}
export interface CircuitReservation {
  epoch: number;
  probe: boolean;
}
export interface CircuitStatus {
  state: 'closed' | 'open' | 'half_open';
  failures: number;
  retryAt: number | null;
}
export class CircuitOpen extends Error {
  constructor() {
    super('Tool circuit is open or already has a recovery probe');
    this.name = 'CircuitOpen';
  }
}

export class Circuit {
  constructor(private readonly store: HecatonStore) {}

  reserve(lease: CallLease, entry: ToolEntry): CircuitReservation {
    return this.store.db.transaction(() => {
      lease.assert();
      this.store.db.execute(
        'INSERT OR IGNORE INTO hecaton_circuits(project,agent,binding_id,capability_hash) VALUES(?,?,?,?)',
        this.key(entry),
      );
      const row = this.read(entry)!;
      if (row.opened_at === null) return { epoch: row.epoch, probe: false };
      if (Date.now() < row.opened_at + COOLDOWN_MS || this.activeProbe(row.probe_nonce))
        throw new CircuitOpen();
      this.store.db.execute(
        'UPDATE hecaton_circuits SET probe_nonce=? WHERE project=? AND agent=? AND binding_id=? AND capability_hash=?',
        [lease.nonce, ...this.key(entry)],
      );
      return { epoch: row.epoch, probe: true };
    });
  }

  finish(
    lease: CallLease,
    entry: ToolEntry,
    reservation: CircuitReservation,
    outcome: 'success' | 'failure' | 'cancelled',
  ): void {
    this.store.db.transaction(() => {
      lease.assert();
      const row = this.read(entry);
      if (
        !row ||
        row.epoch !== reservation.epoch ||
        (reservation.probe && row.probe_nonce !== lease.nonce)
      )
        return;
      if (outcome === 'cancelled') {
        if (reservation.probe) this.save(entry, { ...row, probe_nonce: null });
        return;
      }
      const failures = outcome === 'success' ? 0 : Math.min(FAILURE_LIMIT, row.failures + 1);
      const opened = failures >= FAILURE_LIMIT;
      const changed = opened || reservation.probe;
      this.save(entry, {
        failures,
        epoch: integer(row.epoch + Number(changed), 'circuit epoch', 0, Number.MAX_SAFE_INTEGER),
        opened_at: opened ? Date.now() : null,
        probe_nonce: null,
      });
    });
  }

  status(entry: ToolEntry): CircuitStatus {
    const row = this.read(entry);
    if (!row || row.opened_at === null)
      return { state: 'closed', failures: row?.failures ?? 0, retryAt: null };
    return {
      state: this.activeProbe(row.probe_nonce) ? 'half_open' : 'open',
      failures: row.failures,
      retryAt: row.opened_at + COOLDOWN_MS,
    };
  }

  private read(entry: ToolEntry): CircuitRow | undefined {
    const row = this.store.db.query<CircuitRow>(
      `SELECT failures,epoch,opened_at,${column('probe_nonce', 128)}
      FROM hecaton_circuits WHERE project=? AND agent=? AND binding_id=? AND capability_hash=?`,
      this.key(entry),
    )[0];
    if (!row) return;
    integer(row.failures, 'circuit failure count', 0, FAILURE_LIMIT);
    integer(row.epoch, 'circuit epoch', 0, Number.MAX_SAFE_INTEGER);
    if (row.opened_at !== null)
      integer(row.opened_at, 'circuit opening time', 0, Number.MAX_SAFE_INTEGER);
    if (row.probe_nonce !== null) identity(row.probe_nonce, 'circuit probe nonce');
    if (
      (row.failures === FAILURE_LIMIT) !== (row.opened_at !== null) ||
      (row.probe_nonce !== null && row.opened_at === null)
    )
      throw new Error('Stored circuit state is inconsistent');
    return row;
  }

  private save(entry: ToolEntry, row: CircuitRow): void {
    this.store.db.execute(
      `UPDATE hecaton_circuits SET failures=?,epoch=?,opened_at=?,probe_nonce=?
      WHERE project=? AND agent=? AND binding_id=? AND capability_hash=?`,
      [row.failures, row.epoch, row.opened_at, row.probe_nonce, ...this.key(entry)],
    );
  }
  private key(entry: ToolEntry): string[] {
    return [...this.store.scope, entry.view.bindingId, entry.capabilityHash];
  }
  private activeProbe(nonce: string | null): boolean {
    return (
      nonce !== null &&
      leaseRows(this.store).some(
        (lease) =>
          lease.nonce === nonce && lease.expires_at > Date.now() && processAlive(lease.process_id),
      )
    );
  }
}
