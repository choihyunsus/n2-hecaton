// Inspect existing scoped records through a read-only connection without running host adapters.
import Database from 'better-sqlite3';
import {
  databaseFile,
  readDefinitions,
  column,
  type DefinitionRecord,
  type ReadConnection,
  type StoreOptions,
  type SqlConnection,
} from './store';
import { callStatus } from './call-status';
import { history, type HistoryItem } from './history';
import { identity } from './values';
import type { CallStatus } from './call-types';

export interface InspectionOptions extends StoreOptions {
  view: 'status' | 'history' | 'definitions';
  requestId?: string;
  limit?: number;
  offset?: number;
}
export type HecatonInspection =
  | { view: 'status'; status: CallStatus | null }
  | { view: 'history'; history: HistoryItem[] }
  | { view: 'definitions'; definitions: DefinitionRecord[] };

export function inspectHecaton(options: InspectionOptions): HecatonInspection {
  const scope = [identity(options.project, 'project', 512), identity(options.agent, 'agent', 512)];
  const filename = databaseFile(options.dbPath, false);
  const db = new Database(filename, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    db.pragma('query_only=ON');
    const reader: ReadConnection = {
      query<T>(sql: string, values: Parameters<SqlConnection['query']>[1] = []): T[] {
        return db.prepare(sql).all(...values) as T[];
      },
    };
    const version = reader.query<{ value: unknown }>(
      `SELECT ${column('value', 16)} FROM meta WHERE key='hecaton_schema_version'`,
    )[0]?.value;
    if (version !== '1') throw new Error('An initialized Hecaton schema version 1 is required');
    if (options.view === 'status')
      return {
        view: 'status',
        status: callStatus(reader, scope, identity(options.requestId, 'request ID')) ?? null,
      };
    if (options.view === 'history')
      return { view: 'history', history: history(reader, scope, options.limit, options.offset) };
    if (options.view === 'definitions')
      return { view: 'definitions', definitions: readDefinitions(reader, scope) };
    throw new Error('Unknown inspection view');
  } finally {
    db.close();
  }
}
