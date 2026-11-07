// Own the shared Mimir connection and atomic versioned custom-tool source records.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MimirDatabase } from 'n2-mimir/storage';
import { identity, integer, name, text } from './values';
import { initializeSchema } from './store-schema';
const MAX_DEFINITIONS = 512;
const MAX_SCOPE_BYTES = 512;

export type SqlConnection = MimirDatabase['reasoning']['connection'];
export type ReadConnection = Pick<SqlConnection, 'query'>;
export interface StoreOptions {
  dbPath: string;
  project: string;
  agent: string;
}
export interface DefinitionRecord {
  name: string;
  kind: 'n2r' | 'mcp';
  content: string;
  contentHash: string;
  revision: number;
  updatedAt: number;
}
export class HecatonStore {
  readonly memory: MimirDatabase;
  readonly db: SqlConnection;
  readonly dbPath: string;
  readonly storageId: string;
  readonly scope: [string, string];

  constructor(options: StoreOptions) {
    this.scope = [
      identity(options.project, 'project', MAX_SCOPE_BYTES),
      identity(options.agent, 'agent', MAX_SCOPE_BYTES),
    ];
    this.dbPath = databaseFile(options.dbPath);
    this.memory = new MimirDatabase(this.dbPath);
    this.db = this.memory.reasoning.connection;
    try {
      this.storageId = initializeSchema(this.db);
    } catch (error) {
      this.memory.close();
      throw error;
    }
  }

  definitions(): DefinitionRecord[] {
    return readDefinitions(this.db, this.scope);
  }

  putDefinition(
    value: Omit<DefinitionRecord, 'revision' | 'updatedAt' | 'contentHash'>,
    expectedHash: string | null,
  ): DefinitionRecord {
    const toolName = name(value.name),
      content = text(value.content, 'definition content', value.kind === 'mcp' ? 131072 : 65536);
    if (!['n2r', 'mcp'].includes(value.kind)) throw new Error('Unknown definition kind');
    if (expectedHash !== null) hashValue(expectedHash);
    return this.db.transaction(() => {
      const records = this.definitions();
      const previous = records.find((entry) => entry.name.toLowerCase() === toolName.toLowerCase());
      if ((previous?.contentHash ?? null) !== expectedHash)
        throw new Error('Tool definition changed; reload before updating');
      if (previous && previous.name !== toolName)
        throw new Error('Case-only tool name collisions are unsupported');
      if (!previous && records.length >= MAX_DEFINITIONS) throw new Error('Tool catalog is full');
      const revision = (previous?.revision ?? 0) + 1,
        updatedAt = Date.now(),
        contentHash = digest(content);
      integer(revision, 'definition revision', 1, Number.MAX_SAFE_INTEGER);
      this.db.execute(
        `INSERT INTO hecaton_definitions VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(project,agent,name) DO UPDATE SET kind=excluded.kind,content=excluded.content,
        content_hash=excluded.content_hash,revision=excluded.revision,updated_at=excluded.updated_at`,
        [...this.scope, toolName, value.kind, content, contentHash, revision, updatedAt],
      );
      return { name: toolName, kind: value.kind, content, contentHash, revision, updatedAt };
    });
  }

  removeDefinition(toolName: string, expectedHash: string): void {
    name(toolName);
    hashValue(expectedHash);
    this.db.transaction(() => {
      const previous = this.definitions().find((entry) => entry.name === toolName);
      if (!previous || previous.contentHash !== expectedHash)
        throw new Error('Tool definition changed or is missing');
      this.db.execute(
        'DELETE FROM hecaton_definitions WHERE project=? AND agent=? AND name=? AND content_hash=?',
        [...this.scope, toolName, expectedHash],
      );
    });
  }

  close(): void {
    this.memory.close();
  }
}

export function readDefinitions(db: ReadConnection, scope: readonly string[]): DefinitionRecord[] {
  const rows = db.query<Record<string, unknown>>(
    `SELECT ${column('name', 64)},${column('kind', 16)},${column('content', 131072)},${column('content_hash', 64)},revision,updated_at
     FROM hecaton_definitions WHERE project=? AND agent=? ORDER BY name LIMIT ?`,
    [...scope, MAX_DEFINITIONS + 1],
  );
  if (rows.length > MAX_DEFINITIONS)
    throw new Error('Stored tool definitions exceed the catalog limit');
  return rows.map(readDefinition);
}

function readDefinition(row: Record<string, unknown>): DefinitionRecord {
  const toolName = name(row.name),
    content = text(row.content, 'stored definition content', row.kind === 'mcp' ? 131072 : 65536);
  const contentHash = hashValue(row.content_hash);
  if (digest(content) !== contentHash) throw new Error('Stored tool definition hash mismatch');
  if (row.kind !== 'n2r' && row.kind !== 'mcp') throw new Error('Invalid stored definition kind');
  return {
    name: toolName,
    kind: row.kind,
    content,
    contentHash,
    revision: integer(row.revision, 'stored revision', 1, Number.MAX_SAFE_INTEGER),
    updatedAt: integer(row.updated_at, 'stored update time', 0, Number.MAX_SAFE_INTEGER),
  };
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function hashValue(value: unknown): string {
  const result = text(value, 'SHA-256 hash', 64);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('Invalid SHA-256 hash');
  return result;
}
export function column(columnName: string, maximum: number): string {
  if (!/^[a-z_]+$/.test(columnName) || !Number.isSafeInteger(maximum) || maximum < 1)
    throw new Error('Invalid SQL projection');
  return `CASE WHEN length(CAST(${columnName} AS BLOB))>${maximum} THEN 0 ELSE ${columnName} END AS ${columnName}`;
}
export function databaseFile(value: unknown, createParent = true): string {
  const filename = identity(value, 'database path', 8192);
  if (filename === ':memory:' || /^\\\\[.?]\\/u.test(filename))
    throw new Error('A durable regular SQLite file is required');
  const resolved = path.resolve(filename);
  if (
    process.platform === 'win32' &&
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)|:/i.test(path.basename(resolved))
  )
    throw new Error('Database path uses a reserved device or stream name');
  if (createParent) fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const canonical = path.join(
    fs.realpathSync.native(path.dirname(resolved)),
    path.basename(resolved),
  );
  try {
    if (!fs.statSync(canonical).isFile()) throw new Error('Database must be a regular file');
    return fs.realpathSync.native(canonical);
  } catch (error) {
    if (!createParent || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return canonical;
  }
}
