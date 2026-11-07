// Parse literal flag values and require ownership before loading an operator-selected adapter.
import type { HecatonOptions } from './hecaton';
import { identity, integer, plainJson, text } from './values';
import { adapterOptions } from './cli-files';

const SCOPE = ['db', 'project', 'agent'];
const HOST = [...SCOPE, 'adapter'];
const FLAGS: Record<string, readonly string[]> = {
  list: HOST,
  route: [...HOST, 'query', 'limit'],
  call: [...HOST, 'tool', 'request-id', 'session-id', 'args-json'],
  auto: [...HOST, 'query', 'request-id', 'session-id', 'args-json'],
  status: [...SCOPE, 'request-id'],
  history: [...SCOPE, 'limit', 'offset'],
  definitions: SCOPE,
  install: [...HOST, 'source', 'expected-hash'],
  remove: [...HOST, 'tool', 'expected-hash'],
  servers: HOST,
  discover: [...HOST, 'server'],
  import: [...HOST, 'server', 'names-json', 'expected-hashes-json'],
  reconcile: [...HOST, 'request-id', 'result-json', 'evidence'],
  mcp: HOST,
};
export type CliValues = Map<string, string>;
export function parseCli(args: string[]): { command: string; values: CliValues } {
  const command = args[0] ?? 'help';
  if (['help', '--help', '-h'].includes(command) && args.length <= 1)
    return { command: 'help', values: new Map() };
  if (['version', '--version'].includes(command) && args.length === 1)
    return { command: 'version', values: new Map() };
  if (!Object.hasOwn(FLAGS, command)) throw new Error('Unknown command; use --help');
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index++) {
    const token = args[index]!;
    if (!token.startsWith('--')) throw new Error('Expected a named --option');
    const equal = token.indexOf('=');
    const name = token.slice(2, equal < 0 ? undefined : equal);
    const value = equal < 0 ? args[++index] : token.slice(equal + 1);
    if (!FLAGS[command]!.includes(name) || values.has(name) || value === undefined)
      throw new Error(`Unknown, repeated or incomplete option --${name}`);
    values.set(name, value);
  }
  return { command, values };
}
export function required(values: CliValues, key: string): string {
  const value = values.get(key);
  if (value === undefined || !value.trim()) throw new Error(`Required option --${key} is missing`);
  return value;
}
export function scopeOptions(values: CliValues) {
  return {
    dbPath: identity(required(values, 'db'), 'database path', 8192),
    project: identity(required(values, 'project'), 'project', 512),
    agent: identity(required(values, 'agent'), 'agent', 512),
  };
}
export async function engineOptions(values: CliValues): Promise<HecatonOptions> {
  const scope = scopeOptions(values);
  const adapter = values.has('adapter') ? await adapterOptions(required(values, 'adapter')) : {};
  return { ...scope, tools: [], ...adapter };
}
export function numberOption(values: CliValues, key: string, fallback: number): number {
  const value = values.get(key);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`Invalid numeric option --${key}`);
  return integer(Number(value), key, 0, 100000);
}
export function jsonOption(values: CliValues, key: string, maximum = 65536) {
  return plainJson(JSON.parse(text(required(values, key), key, maximum)), maximum);
}
export const HELP = `n2-hecaton <${Object.keys(FLAGS).join('|')}>
  --db <mimir.db> --project <project> --agent <agent> [--adapter <host.cjs>]
list shows available tools and definition issues. route requires --query and accepts --limit.
call requires --tool --request-id --args-json, optionally --session-id.
auto replaces --tool with --query and executes the highest-ranked registered capability.
status requires --request-id. history accepts --limit and --offset.
status/history/definitions inspect an existing database without loading an adapter.
install requires --source <tool.n2r>; replacement also requires --expected-hash.
remove requires --tool and --expected-hash. discover requires --server.
import requires --server --names-json <array>, optionally --expected-hashes-json <object>.
reconcile requires --request-id --result-json --evidence after external outcome inspection.
mcp serves bounded stdio tools until EOF or interruption.
Host adapters supply tools, policy and fixed MCP server configurations.
`;
