// Only explicit local adapter modules execute code; tool definitions remain bounded UTF-8 data.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HecatonOptions } from './hecaton';
import { identity } from './values';

type Adapter = Pick<HecatonOptions, 'tools' | 'policy' | 'policyTimeoutMs' | 'mcpServers'>;
function regularFile(filename: string, maximum: number): string {
  const input = identity(filename, 'local filename', 8192);
  if (/^\\\\[.?]\\/u.test(input)) throw new Error('A regular local file is required');
  const resolved = path.resolve(input);
  if (
    process.platform === 'win32' &&
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)|:/i.test(path.basename(resolved))
  )
    throw new Error('Local file uses a reserved device or stream name');
  const canonical = fs.realpathSync.native(resolved);
  const info = fs.statSync(canonical);
  if (!info.isFile() || info.size > maximum)
    throw new Error('Local file exceeds its type or size limit');
  return canonical;
}
export function readSource(filename: string): string {
  const resolved = regularFile(filename, 65536);
  const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0);
  const handle = fs.openSync(resolved, flags);
  try {
    const info = fs.fstatSync(handle);
    if (!info.isFile() || info.size > 65536) throw new Error('Expected an N2R file within 64 KiB');
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(handle, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > 65536) throw new Error('N2R file exceeds 64 KiB');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, length),
    );
  } finally {
    fs.closeSync(handle);
  }
}
export async function adapterOptions(filename: string): Promise<Partial<Adapter>> {
  const resolved = regularFile(filename, 1048576);
  if (!['.js', '.mjs', '.cjs'].includes(path.extname(resolved)))
    throw new Error('Adapter must be a local JavaScript module');
  try {
    const loaded = await import(pathToFileURL(resolved).href);
    const adapter: Partial<Adapter> = loaded.default ?? loaded;
    if (!adapter || typeof adapter !== 'object') throw new Error('Invalid adapter');
    return {
      tools: adapter.tools ?? [],
      policy: adapter.policy,
      policyTimeoutMs: adapter.policyTimeoutMs,
      mcpServers: adapter.mcpServers,
    };
  } catch {
    throw new Error('Host adapter could not be loaded');
  }
}
