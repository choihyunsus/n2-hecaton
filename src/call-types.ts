// Immutable execution identities and stored outcomes distinguish preparation from uncertain effects.
import type { JsonObject, ToolResult, ToolView } from './types';

export interface ExecutionRequest {
  requestId: string;
  sessionId?: string;
  tool: string;
  arguments: JsonObject;
}
export type CallState = 'prepared' | 'pending' | 'completed' | 'unknown' | 'blocked';
export interface CallInput {
  requestId: string;
  sessionId: string;
  tool: ToolView;
  arguments: JsonObject;
  capabilityHash: string;
  policyVersion: string;
  metadataHash: string;
  requestHash: string;
}
export interface CallRecord extends CallInput {
  state: CallState;
  result: ToolResult | null;
  error: string | null;
  evidence: string | null;
  experienceId: string | null;
  attempts: number;
  circuitEpoch: number;
  circuitProbe: boolean;
  startedAt: number;
  finishedAt: number | null;
}
export interface CallStatus {
  call: CallRecord;
  active: boolean;
  uncertain: boolean;
  needsReconciliation: boolean;
}
export interface ExecutionReceipt {
  requestId: string;
  sessionId: string;
  tool: string;
  state: 'completed' | 'blocked';
  result: ToolResult;
  experienceId: string;
  cached: boolean;
  attempts: number;
}
export class ReconciliationRequired extends Error {
  constructor(readonly requestId: string) {
    super(
      'Tool outcome is uncertain; inspect external state and reconcile this request before retrying',
    );
    this.name = 'ReconciliationRequired';
  }
}
