// Assess ownership independently of the stored phase so dead pending calls remain visibly uncertain.
import { findCall } from './call-record';
import { leaseRows, processAlive } from './lease';
import type { ReadConnection } from './store';
import type { CallStatus } from './call-types';

export function callStatus(
  db: ReadConnection,
  scope: readonly string[],
  requestId: string,
): CallStatus | undefined {
  const call = findCall(db, scope, requestId);
  if (!call) return;
  const active = leaseRows({ db, scope }).some(
    (row) =>
      row.request_id === requestId && row.expires_at > Date.now() && processAlive(row.process_id),
  );
  const uncertain = call.state === 'unknown' || (call.state === 'pending' && !active);
  return { call, active, uncertain, needsReconciliation: uncertain && !call.tool.idempotent };
}
