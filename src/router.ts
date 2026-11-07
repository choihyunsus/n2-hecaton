// Route bounded catalogs with exact aliases, domain filtering, DNA and BM25 scores.
import type { RouteMatch, RouteResult, ToolStatistics, ToolView } from './types';
import { integer, text } from './values';
import { queryDomains, tokens } from './taxonomy';

interface IndexedTool {
  tool: ToolView;
  frequencies: Map<string, number>;
  length: number;
  dnaWords: Set<string>;
  nameWords: Set<string>;
  triggers: Set<string>;
}

export class Router {
  private readonly entries: IndexedTool[];
  private readonly idf = new Map<string, number>();
  private readonly averageLength: number;
  private readonly fullCatalogBytes: number;

  constructor(tools: readonly ToolView[]) {
    this.entries = tools.map(indexTool);
    this.averageLength =
      this.entries.reduce((sum, entry) => sum + entry.length, 0) / Math.max(1, tools.length);
    const frequency = new Map<string, number>();
    for (const entry of this.entries)
      for (const word of entry.frequencies.keys())
        frequency.set(word, (frequency.get(word) ?? 0) + 1);
    for (const [word, count] of frequency)
      this.idf.set(word, Math.log(1 + (tools.length - count + 0.5) / (count + 0.5)));
    this.fullCatalogBytes = Buffer.byteLength(JSON.stringify(tools.map(modelSchema)));
  }

  route(
    raw: string,
    limit = 3,
    statistics: ReadonlyMap<string, ToolStatistics> = new Map(),
  ): RouteResult {
    const query = text(raw, 'routing query', 4096).trim().toLowerCase();
    integer(limit, 'routing limit', 1, 32);
    const words = [...new Set(tokens(query))];
    if (words.length > 256) throw new Error('Routing query exceeds its word limit');
    const exact = this.entries.filter(({ tool }) => tool.name.toLowerCase() === query);
    const domain = queryDomains(words);
    const first = exact.length
      ? exact
      : this.entries.filter(
          ({ tool }) =>
            !domain || (tool.bitfield & domain & 1023) !== 0 || exactTrigger(tool, query),
        );
    const candidates = first
      .map((entry) => this.score(entry, query, words, statistics.get(entry.tool.name)))
      .filter((match) => match.scores.dna + match.scores.trigger + match.scores.keyword > 0)
      .sort(compareMatches)
      .slice(0, 30);
    const matches = candidates.slice(0, limit);
    const selected = {
      hints: candidates.map((entry) => entry.tool.dna),
      tools: matches.map((entry) => modelSchema(entry.tool)),
    };
    const selectedBytes = Buffer.byteLength(JSON.stringify(selected));
    return {
      matches: structuredClone(matches),
      candidates: { total: this.entries.length, domain: first.length, ranked: candidates.length },
      budget: {
        fullCatalogBytes: this.fullCatalogBytes,
        selectedBytes,
        estimatedTokens: Math.ceil(selectedBytes / 4),
      },
    };
  }

  private score(
    entry: IndexedTool,
    query: string,
    words: string[],
    stats?: ToolStatistics,
  ): RouteMatch {
    const { tool } = entry;
    const exact = tool.name.toLowerCase() === query;
    const scores = {
      trigger:
        Number(exactTrigger(tool, query)) * 5 +
        words.filter((word) => entry.triggers.has(word)).length * 3,
      dna:
        Number(exact) * 20 +
        words.reduce(
          (sum, word) =>
            sum + Number(entry.dnaWords.has(word)) * 2 + Number(entry.nameWords.has(word)) * 5,
          0,
        ),
      keyword: this.bm25(entry, words),
      usage: stats ? Math.min(Math.log2(1 + stats.usageCount), 5) * 0.5 : 0,
      success: stats && stats.usageCount > 0 ? stats.successes / stats.usageCount : 0,
    };
    return {
      name: tool.name,
      score: Object.values(scores).reduce((sum, score) => sum + score, 0),
      scores,
      tool,
    };
  }

  private bm25(entry: IndexedTool, words: string[]): number {
    let score = 0;
    for (const word of words) {
      const frequency = entry.frequencies.get(word) ?? 0;
      const denominator =
        frequency + 1.2 * (0.25 + (0.75 * entry.length) / Math.max(1, this.averageLength));
      score += ((this.idf.get(word) ?? 0) * frequency * 2.2) / denominator;
    }
    return score;
  }
}

function indexTool(tool: ToolView): IndexedTool {
  const words = tokens(
    [tool.name, tool.description, tool.category, ...tool.triggers, ...tool.tags].join(' '),
  );
  const frequencies = new Map<string, number>();
  for (const word of words) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  return {
    tool: structuredClone(tool),
    frequencies,
    length: words.length,
    dnaWords: new Set(tokens(tool.dna)),
    nameWords: new Set(tokens(tool.name)),
    triggers: new Set(tool.triggers.flatMap(tokens)),
  };
}
function exactTrigger(tool: ToolView, query: string): boolean {
  return !!query && tool.triggers.some((trigger) => trigger.toLowerCase() === query);
}
function compareMatches(left: RouteMatch, right: RouteMatch): number {
  return right.score - left.score || (left.name < right.name ? -1 : Number(left.name > right.name));
}
function modelSchema(tool: ToolView): object {
  return { name: tool.name, description: tool.description, parameters: tool.inputSchema };
}
