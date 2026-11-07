// Return bounded history summaries without loading stored arguments or full callback results.
import { column, type SqlConnection } from './store';
import { identity, integer, name, text } from './values';
import type { CallState } from './call-types';
export interface HistoryItem {
  requestId: string;
  tool: string;
  state: CallState;
  attempts: number;
  startedAt: number;
  finishedAt: number | null;
}
export function history(
  db: Pick<SqlConnection, 'query'>,
  scope: readonly string[],
  limit = 50,
  offset = 0,
): HistoryItem[] {
  integer(limit, 'history limit', 1, 100);
  integer(offset, 'history offset', 0, 100000);
  const rows = db.query<Record<string, unknown>>(
    `SELECT ${column('request_id', 128)},${column('tool_name', 64)},
    ${column('state', 16)},attempts,started_at,finished_at FROM hecaton_calls WHERE project=? AND agent=?
    ORDER BY started_at DESC,request_id LIMIT ? OFFSET ?`,
    [...scope, limit, offset],
  );
  return rows.map((row) => {
    const state = text(row.state, 'stored call state', 16) as CallState;
    if (!['prepared', 'pending', 'completed', 'unknown', 'blocked'].includes(state))
      throw new Error('Invalid stored call state');
    return {
      requestId: identity(row.request_id, 'stored request ID'),
      tool: name(row.tool_name),
      state,
      attempts: integer(row.attempts, 'stored attempts', 0, 32),
      startedAt: integer(row.started_at, 'stored start time', 0, Number.MAX_SAFE_INTEGER),
      finishedAt:
        row.finished_at === null
          ? null
          : integer(row.finished_at, 'stored finish time', 0, Number.MAX_SAFE_INTEGER),
    };
  });
}
