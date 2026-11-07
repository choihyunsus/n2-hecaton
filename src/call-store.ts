// Journal intent before callbacks and commit completed receipts with shared Soul experiences atomically.
import type { HecatonStore } from './store';
import { findCall } from './call-record';
import { checkedResult } from './tool-entry';
import { fingerprint, identity, integer } from './values';
import type { CallLease } from './lease';
import type { CircuitReservation } from './circuit';
import type { CallInput, CallRecord } from './call-types';
import type { JsonValue, ToolStatistics } from './types';

export class CallStore {
  constructor(readonly store: HecatonStore) {}

  get(requestId: string): CallRecord | undefined {
    return findCall(this.store.db, this.store.scope, requestId);
  }

  begin(lease: CallLease, input: CallInput): CallRecord {
    return this.store.db.transaction(() => {
      lease.assert();
      if (input.requestId !== lease.requestId)
        throw new Error('Request differs from its execution lease');
      const existing = this.get(input.requestId);
      if (existing) {
        if (existing.requestHash !== input.requestHash)
          throw new Error('Request ID belongs to different input or capability versions');
        return existing;
      }
      this.store.db.execute(
        `INSERT INTO hecaton_calls(project,agent,request_id,session_id,tool_name,definition_hash,
        binding_id,capability_hash,policy_version,request_hash,arguments_json,metadata_json,metadata_hash,
        state,circuit_epoch,circuit_probe,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',0,0,?)`,
        [
          ...this.store.scope,
          input.requestId,
          input.sessionId,
          input.tool.name,
          input.tool.definitionHash,
          input.tool.bindingId,
          input.capabilityHash,
          input.policyVersion,
          input.requestHash,
          JSON.stringify(input.arguments),
          JSON.stringify(input.tool),
          input.metadataHash,
          Date.now(),
        ],
      );
      return this.get(input.requestId)!;
    });
  }

  pending(lease: CallLease, reservation: CircuitReservation): CallRecord {
    return this.store.db.transaction(() => {
      lease.assert();
      const record = this.required(lease.requestId);
      if (!['prepared', 'pending', 'unknown'].includes(record.state))
        throw new Error('Completed requests cannot invoke another callback');
      if (record.state !== 'prepared' && !record.tool.idempotent)
        throw new Error('Uncertain non-idempotent requests require reconciliation');
      const attempts = integer(record.attempts + 1, 'invocation attempts', 1, 32);
      this.store.db.execute(
        `UPDATE hecaton_calls SET state='pending',attempts=?,circuit_epoch=?,circuit_probe=?,
        error=NULL,finished_at=NULL WHERE project=? AND agent=? AND request_id=?`,
        [
          attempts,
          reservation.epoch,
          Number(reservation.probe),
          ...this.store.scope,
          lease.requestId,
        ],
      );
      return this.required(lease.requestId);
    });
  }

  unknown(lease: CallLease, message: string): void {
    identity(message, 'uncertainty message', 4096);
    this.store.db.transaction(() => {
      lease.assert();
      if (this.required(lease.requestId).state !== 'pending')
        throw new Error('Only an invoked request can have an uncertain result');
      this.store.db.execute(
        "UPDATE hecaton_calls SET state='unknown',error=?,finished_at=? WHERE project=? AND agent=? AND request_id=?",
        [message, Date.now(), ...this.store.scope, lease.requestId],
      );
    });
  }

  complete(
    lease: CallLease,
    rawResult: unknown,
    blocked = false,
    evidence: string | null = null,
  ): CallRecord {
    if (evidence !== null) identity(evidence, 'reconciliation evidence', 8192);
    return this.store.db.transaction(() => {
      lease.assert();
      const previous = this.required(lease.requestId);
      const result = checkedResult(rawResult, previous.tool.readOnly);
      const hash = fingerprint(result as unknown as JsonValue);
      if (previous.state === 'completed' || previous.state === 'blocked') {
        if (
          fingerprint(previous.result as unknown as JsonValue) !== hash ||
          previous.evidence !== evidence ||
          (previous.state === 'blocked') !== blocked
        )
          throw new Error('Completed request differs from the supplied reconciliation');
        return previous;
      }
      if (
        (blocked && (previous.state !== 'prepared' || result.success)) ||
        (!blocked && previous.state === 'prepared')
      )
        throw new Error('Completion does not match the invocation state');
      if (previous.state === 'unknown' && evidence === null)
        throw new Error('Unknown outcomes require reconciliation evidence');
      const state = blocked ? 'blocked' : 'completed';
      const experience = this.recordExperience(previous, result, hash);
      this.store.db.execute(
        `UPDATE hecaton_calls SET state=?,result_json=?,result_hash=?,evidence=?,experience_id=?,
        error=NULL,finished_at=? WHERE project=? AND agent=? AND request_id=?`,
        [
          state,
          JSON.stringify(result),
          hash,
          evidence,
          experience,
          Date.now(),
          ...this.store.scope,
          lease.requestId,
        ],
      );
      if (previous.attempts > 0) this.incrementStatistics(previous, result.success);
      return this.required(lease.requestId);
    });
  }

  statistics(toolName: string, definitionHash: string): ToolStatistics {
    const row = this.store.db.query<{
      usage_count: unknown;
      successes: unknown;
      last_used_at: unknown;
    }>(
      'SELECT usage_count,successes,last_used_at FROM hecaton_statistics WHERE project=? AND agent=? AND tool_name=? AND definition_hash=?',
      [...this.store.scope, toolName, definitionHash],
    )[0];
    if (!row) return { usageCount: 0, successes: 0, lastUsedAt: null };
    const usageCount = integer(row.usage_count, 'tool usage count', 0, Number.MAX_SAFE_INTEGER);
    return {
      usageCount,
      successes: integer(row.successes, 'tool success count', 0, usageCount),
      lastUsedAt:
        row.last_used_at === null
          ? null
          : integer(row.last_used_at, 'last usage time', 0, Number.MAX_SAFE_INTEGER),
    };
  }

  required(requestId: string): CallRecord {
    const record = this.get(requestId);
    if (!record) throw new Error('Unknown execution request');
    return record;
  }

  private recordExperience(
    record: CallRecord,
    result: ReturnType<typeof checkedResult>,
    hash: string,
  ): string {
    return this.store.memory.insertExperience({
      project: this.store.scope[0],
      agent: this.store.scope[1],
      sessionId: record.sessionId,
      type: result.success ? 'success' : 'failure',
      category: 'hecaton_tool',
      severity: result.success ? 'info' : 'error',
      context: JSON.stringify({ tool: record.tool.name, requestId: record.requestId }),
      action: record.tool.bindingId,
      outcome: JSON.stringify({
        verified: false,
        reportedSuccess: result.success,
        resultHash: hash,
        outputPreview: Array.from(result.output).slice(0, 2000).join(''),
      }),
      sourceRef: `hecaton:${record.requestId}`,
    }).id;
  }

  private incrementStatistics(record: CallRecord, success: boolean): void {
    const current = this.statistics(record.tool.name, record.tool.definitionHash);
    this.store.db.execute(
      `INSERT INTO hecaton_statistics VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(project,agent,tool_name,definition_hash) DO UPDATE SET usage_count=excluded.usage_count,
      successes=excluded.successes,last_used_at=excluded.last_used_at`,
      [
        ...this.store.scope,
        record.tool.name,
        record.tool.definitionHash,
        Math.min(Number.MAX_SAFE_INTEGER, current.usageCount + 1),
        Math.min(Number.MAX_SAFE_INTEGER, current.successes + Number(success)),
        Date.now(),
      ],
    );
  }
}
