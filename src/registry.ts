// Restore registered capabilities and atomically replace validated custom source in the shared DB.
import { compileTool } from './n2r-tool';
import { hostEntry, type ToolEntry } from './tool-entry';
import { digest, hashValue, type DefinitionRecord, type HecatonStore } from './store';
import { name, text } from './values';
import { Router } from './router';
import type { RouteResult, ToolDefinition, ToolStatistics, ToolView } from './types';

const MAX_TOOLS = 512;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_PREDICATES = 512;
export interface DefinitionIssue {
  name: string;
  reason: string;
}
export type McpEntryFactory = (record: DefinitionRecord) => ToolEntry;
export interface ImportCandidate {
  name: string;
  content: string;
  expectedHash: string | null;
}

export class Registry {
  private readonly hosts: ToolEntry[];
  private entries = new Map<string, ToolEntry>();
  private bindings = new Map<string, ToolEntry>();
  private issues: DefinitionIssue[] = [];
  private signature = '';
  private router: Router;

  constructor(
    private readonly store: HecatonStore,
    definitions: ToolDefinition[],
    private readonly mcp?: McpEntryFactory,
  ) {
    if (!Array.isArray(definitions) || definitions.length > MAX_TOOLS)
      throw new Error('Host catalog exceeds its tool limit');
    this.hosts = definitions.map(hostEntry);
    const names = new Set(this.hosts.map((entry) => entry.view.name.toLowerCase()));
    if (names.size !== this.hosts.length)
      throw new Error('Case-insensitive host tool name collision');
    checkBudget(this.hosts, []);
    this.router = new Router([]);
    this.refresh();
  }

  list(): ToolView[] {
    this.refresh();
    return [...this.entries.values()].map((entry) => structuredClone(entry.view));
  }
  problems(): DefinitionIssue[] {
    this.refresh();
    return structuredClone(this.issues);
  }
  get(toolName: string): ToolEntry {
    this.refresh();
    const entry = this.entries.get(name(toolName));
    if (!entry) throw new Error('Tool is unavailable in the registered catalog');
    return entry;
  }
  route(
    query: string,
    limit?: number,
    statistics?: ReadonlyMap<string, ToolStatistics>,
  ): RouteResult {
    this.refresh();
    return this.router.route(query, limit, statistics);
  }

  installSource(source: string, expectedHash: string | null): DefinitionRecord {
    this.refresh();
    const candidate = compileTool(source, (id) => this.binding(id));
    try {
      this.checkCandidate(candidate, source);
      const record = this.store.putDefinition(
        { name: candidate.view.name, kind: 'n2r', content: source },
        expectedHash,
      );
      this.refresh();
      return record;
    } finally {
      candidate.dispose?.();
    }
  }

  installImported(candidates: ImportCandidate[]): DefinitionRecord[] {
    this.refresh();
    if (!Array.isArray(candidates) || !candidates.length || candidates.length > 128)
      throw new Error('Select between 1 and 128 imported tools');
    const snapshot = this.store.definitions();
    const selected = candidates.map((candidate) => proposedImport(candidate, snapshot));
    if (new Set(selected.map((record) => record.name.toLowerCase())).size !== selected.length)
      throw new Error('Imported tool names collide');
    const changed = new Set(selected.map((record) => record.name));
    const proposal = [...snapshot.filter((record) => !changed.has(record.name)), ...selected];
    const restored = this.restore(proposal);
    try {
      for (const record of selected)
        if (restored.entries.get(record.name)?.view.source !== 'mcp')
          throw new Error('An imported definition could not be registered');
      const saved = this.store.db.transaction(() => {
        if (JSON.stringify(this.store.definitions()) !== JSON.stringify(snapshot))
          throw new Error('Tool catalog changed during import planning');
        return selected.map((record, index) => {
          const previous = snapshot.find((item) => item.name === record.name);
          return previous?.contentHash === record.contentHash
            ? previous
            : this.store.putDefinition(record, candidates[index]!.expectedHash);
        });
      });
      this.refresh();
      return saved;
    } finally {
      for (const entry of restored.entries.values())
        if (entry.view.source !== 'host') entry.dispose?.();
    }
  }

  remove(toolName: string, expectedHash: string): void {
    if (this.hosts.some((entry) => entry.view.name.toLowerCase() === toolName.toLowerCase()))
      throw new Error('Host capabilities are configured by the embedding application');
    this.store.removeDefinition(toolName, expectedHash);
    this.refresh();
  }

  refresh(): void {
    const records = this.store.definitions();
    const signature = digest(
      JSON.stringify(
        records.map((record) => [record.name, record.kind, record.contentHash, record.revision]),
      ),
    );
    if (signature === this.signature) return;
    const restored = this.restore(records);
    for (const entry of this.entries.values()) if (entry.view.source !== 'host') entry.dispose?.();
    this.entries = restored.entries;
    this.bindings = restored.bindings;
    this.issues = restored.issues;
    this.signature = signature;
    this.router = new Router([...this.entries.values()].map((entry) => entry.view));
  }

  close(): void {
    for (const entry of this.entries.values()) if (entry.view.source !== 'host') entry.dispose?.();
    this.entries.clear();
    this.bindings.clear();
    this.signature = '';
  }

  private binding(id: string): ToolEntry {
    const entry = this.bindings.get(id);
    if (!entry)
      throw new Error('Custom tool refers to an unavailable host or registered MCP binding');
    return entry;
  }

  private checkCandidate(candidate: ToolEntry, source: string): void {
    const entries = [...this.entries.values()];
    const collision = entries.find(
      (entry) => entry.view.name.toLowerCase() === candidate.view.name.toLowerCase(),
    );
    if (
      collision &&
      (collision.view.source !== 'n2r' || collision.view.name !== candidate.view.name)
    )
      throw new Error('Custom tool name collides with a registered capability');
    const remaining = entries.filter((entry) => entry !== collision);
    const records = this.store
      .definitions()
      .filter((record) => record.name !== candidate.view.name);
    checkBudget(
      [...remaining, candidate],
      [...records.map((record) => record.content), text(source, 'tool source')],
    );
  }

  private restore(records: DefinitionRecord[]): {
    entries: Map<string, ToolEntry>;
    bindings: Map<string, ToolEntry>;
    issues: DefinitionIssue[];
  } {
    const entries = new Map(this.hosts.map((entry) => [entry.view.name, entry]));
    const bindings = new Map(this.hosts.map((entry) => [entry.view.bindingId, entry]));
    const issues: DefinitionIssue[] = [];
    const sorted = [...records].sort(
      (left, right) => Number(right.kind === 'mcp') - Number(left.kind === 'mcp'),
    );
    for (const record of sorted) {
      let candidate: ToolEntry | undefined;
      try {
        candidate =
          record.kind === 'mcp'
            ? this.mcp?.(record)
            : compileTool(record.content, (id) => {
                const binding = bindings.get(id);
                if (!binding) throw new Error('Missing binding');
                return binding;
              });
        validateRestored(candidate, record.name, entries);
        checkBudget(
          [...entries.values(), candidate!],
          records.map((item) => item.content),
        );
        if (record.kind === 'mcp') {
          if (bindings.has(candidate!.view.bindingId)) throw new Error('Duplicate MCP binding');
          bindings.set(candidate!.view.bindingId, candidate!);
        }
        entries.set(record.name, candidate!);
      } catch {
        candidate?.dispose?.();
        issues.push({
          name: record.name,
          reason:
            'Stored definition or its host binding is unavailable; inspect its source and configuration',
        });
      }
    }
    return { entries, bindings, issues };
  }
}

function proposedImport(
  candidate: ImportCandidate,
  existing: DefinitionRecord[],
): DefinitionRecord {
  const toolName = name(candidate.name),
    content = text(candidate.content, 'MCP definition', 131072);
  if (candidate.expectedHash !== null) hashValue(candidate.expectedHash);
  const previous = existing.find((record) => record.name.toLowerCase() === toolName.toLowerCase());
  if (previous && (previous.name !== toolName || previous.kind !== 'mcp'))
    throw new Error('Imported tool name collides with another definition');
  const contentHash = digest(content);
  if (
    previous?.contentHash === contentHash &&
    (candidate.expectedHash === null || candidate.expectedHash === previous.contentHash)
  )
    return previous;
  if ((previous?.contentHash ?? null) !== candidate.expectedHash)
    throw new Error('Imported definition changed; provide its current content hash');
  return {
    name: toolName,
    kind: 'mcp',
    content,
    contentHash,
    revision: (previous?.revision ?? 0) + 1,
    updatedAt: Date.now(),
  };
}

function validateRestored(
  candidate: ToolEntry | undefined,
  storedName: string,
  entries: Map<string, ToolEntry>,
): void {
  if (!candidate || candidate.view.name !== storedName)
    throw new Error('Stored name differs from the compiled definition');
  if ([...entries.keys()].some((key) => key.toLowerCase() === storedName.toLowerCase()))
    throw new Error('Stored definition collides with a capability');
}
function checkBudget(entries: ToolEntry[], sources: string[]): void {
  const bytes =
    Buffer.byteLength(JSON.stringify(entries.map((entry) => entry.view))) +
    sources.reduce((sum, source) => sum + Buffer.byteLength(source), 0);
  const predicates = entries.reduce((sum, entry) => sum + entry.predicateCount, 0);
  if (entries.length > MAX_TOOLS || bytes > MAX_CATALOG_BYTES || predicates > MAX_PREDICATES)
    throw new Error('Tool catalog exceeds its count, byte or predicate limit');
}
