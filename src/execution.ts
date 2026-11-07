// Enforce authorization and durable intent before running a registered capability once.
import { CallLease } from './lease';
import { CallStore } from './call-store';
import { Circuit, CircuitOpen } from './circuit';
import {
  ReconciliationRequired,
  type CallInput,
  type CallRecord,
  type ExecutionReceipt,
} from './call-types';
import { checkedResult, type ToolEntry } from './tool-entry';
import { Interrupted, withDeadline } from './deadline';
import type { HecatonStore } from './store';
import type { JsonObject, ToolContext, ToolView } from './types';

export interface AuthorizationRequest {
  tool: ToolView;
  arguments: JsonObject;
  context: ToolContext;
}
export interface ExecutionPolicy {
  version: string;
  authorize(request: AuthorizationRequest): boolean | Promise<boolean>;
}

export class Execution {
  private readonly calls: CallStore;
  private readonly circuit: Circuit;
  constructor(
    private readonly store: HecatonStore,
    private readonly policy: ExecutionPolicy,
    private readonly policyTimeout: number,
  ) {
    this.calls = new CallStore(store);
    this.circuit = new Circuit(store);
  }

  async run(
    input: CallInput,
    entry: ToolEntry,
    preflight: string | null,
    signal: AbortSignal,
  ): Promise<ExecutionReceipt> {
    signal.throwIfAborted();
    const lease = new CallLease(this.store, input.requestId, !input.tool.readOnly);
    const combined = AbortSignal.any([signal, lease.controller.signal]);
    try {
      const existing = this.calls.begin(lease, input);
      if (['pending', 'unknown'].includes(existing.state) && !existing.tool.idempotent)
        throw new ReconciliationRequired(input.requestId);
      const denied = await this.authorize(input, combined);
      if (denied) return this.block(lease, existing, denied);
      if (existing.state === 'completed' || existing.state === 'blocked')
        return receipt(existing, true);
      if (preflight) return this.block(lease, existing, preflight);
      let reservation;
      try {
        reservation = this.store.db.transaction(() => {
          const reserved = this.circuit.reserve(lease, entry);
          this.calls.pending(lease, reserved);
          return reserved;
        });
      } catch (error) {
        if (error instanceof CircuitOpen) return this.block(lease, existing, error.message);
        throw error;
      }
      return await this.invoke(lease, input, entry, reservation, combined);
    } finally {
      lease.release();
    }
  }

  private async authorize(input: CallInput, signal: AbortSignal): Promise<string | null> {
    try {
      const allowed = await withDeadline(
        (current) =>
          this.policy.authorize({
            tool: structuredClone(input.tool),
            arguments: structuredClone(input.arguments),
            context: this.context(input, current),
          }),
        this.policyTimeout,
        signal,
      );
      return allowed === true ? null : 'Host authorization denied the request';
    } catch (error) {
      return error instanceof Interrupted
        ? 'Authorization was interrupted before tool invocation'
        : 'Host authorization callback failed';
    }
  }

  private block(lease: CallLease, existing: CallRecord, message: string): ExecutionReceipt {
    if (existing.state === 'pending' || existing.state === 'unknown')
      throw new ReconciliationRequired(existing.requestId);
    if (existing.state !== 'prepared')
      throw new Error('Host authorization denied access to the historical result');
    return receipt(this.calls.complete(lease, { success: false, output: message }, true), false);
  }

  private async invoke(
    lease: CallLease,
    input: CallInput,
    entry: ToolEntry,
    reservation: { epoch: number; probe: boolean },
    signal: AbortSignal,
  ): Promise<ExecutionReceipt> {
    let result;
    try {
      result = checkedResult(
        await withDeadline(
          (current) =>
            entry.execute(structuredClone(input.arguments), this.context(input, current)),
          input.tool.timeoutMs,
          signal,
        ),
        input.tool.readOnly,
      );
    } catch (error) {
      const cancelled = error instanceof Interrupted && !error.timedOut;
      this.markUnknown(
        lease,
        entry,
        reservation,
        cancelled ? 'cancelled' : 'failure',
        error instanceof Interrupted
          ? error.message
          : 'Host callback failed or returned an invalid result',
      );
      throw new ReconciliationRequired(input.requestId);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return this.store.db.transaction(() => {
          this.circuit.finish(lease, entry, reservation, result.success ? 'success' : 'failure');
          return receipt(this.calls.complete(lease, result), false);
        });
      } catch {
        if (attempt === 0) continue;
        this.markUnknown(
          lease,
          entry,
          reservation,
          'cancelled',
          'A result was observed but its completion receipt could not be committed',
        );
      }
    }
    throw new ReconciliationRequired(input.requestId);
  }

  private markUnknown(
    lease: CallLease,
    entry: ToolEntry,
    reservation: { epoch: number; probe: boolean },
    outcome: 'failure' | 'cancelled',
    message: string,
  ): void {
    try {
      this.store.db.transaction(() => {
        this.circuit.finish(lease, entry, reservation, outcome);
        this.calls.unknown(lease, message);
      });
    } catch {
      // The pending receipt was committed before invocation and remains uncertain if this write fails.
    }
  }

  private context(input: CallInput, signal: AbortSignal): ToolContext {
    return Object.freeze({
      project: this.store.scope[0],
      agent: this.store.scope[1],
      requestId: input.requestId,
      sessionId: input.sessionId,
      toolName: input.tool.name,
      bindingId: input.tool.bindingId,
      signal,
    });
  }
}

export function receipt(record: CallRecord, cached: boolean): ExecutionReceipt {
  if (
    (record.state !== 'completed' && record.state !== 'blocked') ||
    !record.result ||
    !record.experienceId
  )
    throw new Error('Execution has no confirmed completion receipt');
  return {
    requestId: record.requestId,
    sessionId: record.sessionId,
    tool: record.tool.name,
    state: record.state,
    result: structuredClone(record.result),
    experienceId: record.experienceId,
    attempts: record.attempts,
    cached,
  };
}
