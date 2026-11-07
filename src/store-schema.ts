// Add scoped tool state beside Soul memory without adopting ambiguous legacy Hecaton tables.
import type { SqlConnection } from './store';
import { randomUUID } from 'node:crypto';
import { identity } from './values';

export function initializeSchema(db: SqlConnection): string {
  return db.transaction(() => {
    const version = db.query<{ value: unknown }>(
      "SELECT value FROM meta WHERE key='hecaton_schema_version'",
    )[0]?.value;
    const tables = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'hecaton_*'",
    );
    if (version !== undefined && version !== '1')
      throw new Error('Unsupported Hecaton schema version');
    if (version === undefined && tables.length)
      throw new Error('Unversioned Hecaton tables require explicit migration');
    if (version !== undefined && tables.length !== Object.keys(COLUMNS).length)
      throw new Error('Versioned Hecaton tables are incomplete');
    for (const table of tables) {
      const columns = db.query<{ name: string }>('SELECT name FROM pragma_table_info(?)', [
        table.name,
      ]);
      if (COLUMNS[table.name]?.join(',') !== columns.map((column) => column.name).join(','))
        throw new Error('Existing Hecaton tables have an incompatible schema');
    }
    for (const sql of STATEMENTS) db.execute(sql);
    db.execute("INSERT OR IGNORE INTO meta(key,value) VALUES('hecaton_schema_version','1')");
    db.execute("INSERT OR IGNORE INTO meta(key,value) VALUES('hecaton_storage_id',?)", [
      randomUUID(),
    ]);
    const stored = db.query<{ value: unknown }>(
      "SELECT CASE WHEN length(CAST(value AS BLOB))<=36 THEN value END AS value FROM meta WHERE key='hecaton_storage_id'",
    )[0]?.value;
    const storageId = identity(stored, 'Hecaton storage ID', 36);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(storageId))
      throw new Error('Invalid Hecaton storage ID');
    return storageId;
  });
}

const COLUMNS: Record<string, string[]> = {
  hecaton_definitions: [
    'project',
    'agent',
    'name',
    'kind',
    'content',
    'content_hash',
    'revision',
    'updated_at',
  ],
  hecaton_calls: [
    'project',
    'agent',
    'request_id',
    'session_id',
    'tool_name',
    'definition_hash',
    'binding_id',
    'capability_hash',
    'policy_version',
    'request_hash',
    'arguments_json',
    'metadata_json',
    'metadata_hash',
    'state',
    'result_json',
    'result_hash',
    'error',
    'evidence',
    'experience_id',
    'attempts',
    'circuit_epoch',
    'circuit_probe',
    'started_at',
    'finished_at',
  ],
  hecaton_circuits: [
    'project',
    'agent',
    'binding_id',
    'capability_hash',
    'failures',
    'epoch',
    'opened_at',
    'probe_nonce',
  ],
  hecaton_statistics: [
    'project',
    'agent',
    'tool_name',
    'definition_hash',
    'usage_count',
    'successes',
    'last_used_at',
  ],
  hecaton_leases: [
    'project',
    'agent',
    'request_id',
    'nonce',
    'process_id',
    'expires_at',
    'writing',
  ],
};
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS hecaton_definitions (
    project TEXT NOT NULL, agent TEXT NOT NULL, name TEXT NOT NULL COLLATE NOCASE,
    kind TEXT NOT NULL CHECK(kind IN('n2r','mcp')), content TEXT NOT NULL
      CHECK(length(CAST(content AS BLOB))<=CASE kind WHEN 'mcp' THEN 131072 ELSE 65536 END),
    content_hash TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL,
    PRIMARY KEY(project,agent,name))`,
  `CREATE TABLE IF NOT EXISTS hecaton_calls (
    project TEXT NOT NULL, agent TEXT NOT NULL, request_id TEXT NOT NULL, session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL, definition_hash TEXT NOT NULL, binding_id TEXT NOT NULL, capability_hash TEXT NOT NULL,
    policy_version TEXT NOT NULL, request_hash TEXT NOT NULL,
    arguments_json TEXT NOT NULL CHECK(length(CAST(arguments_json AS BLOB))<=65536),
    metadata_json TEXT NOT NULL CHECK(length(CAST(metadata_json AS BLOB))<=65536), metadata_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN('prepared','pending','completed','unknown','blocked')),
    result_json TEXT CHECK(length(CAST(result_json AS BLOB))<=131072), result_hash TEXT,
    error TEXT, evidence TEXT, experience_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    circuit_epoch INTEGER NOT NULL, circuit_probe INTEGER NOT NULL CHECK(circuit_probe IN(0,1)),
    started_at INTEGER NOT NULL, finished_at INTEGER, PRIMARY KEY(project,agent,request_id))`,
  `CREATE INDEX IF NOT EXISTS idx_hecaton_calls_history ON hecaton_calls(project,agent,started_at DESC,request_id)`,
  `CREATE TABLE IF NOT EXISTS hecaton_circuits (
    project TEXT NOT NULL, agent TEXT NOT NULL, binding_id TEXT NOT NULL, capability_hash TEXT NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0,
    opened_at INTEGER, probe_nonce TEXT, PRIMARY KEY(project,agent,binding_id,capability_hash))`,
  `CREATE TABLE IF NOT EXISTS hecaton_statistics (
    project TEXT NOT NULL, agent TEXT NOT NULL, tool_name TEXT NOT NULL, definition_hash TEXT NOT NULL,
    usage_count INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER,
    PRIMARY KEY(project,agent,tool_name,definition_hash))`,
  `CREATE TABLE IF NOT EXISTS hecaton_leases (
    project TEXT NOT NULL, agent TEXT NOT NULL, request_id TEXT NOT NULL, nonce TEXT NOT NULL,
    process_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, writing INTEGER NOT NULL CHECK(writing IN(0,1)),
    PRIMARY KEY(project,agent,request_id))`,
];
