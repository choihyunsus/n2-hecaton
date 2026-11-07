// Interpret supported preconditions and Rust Unicode blacklist predicates before host invocation.
import { BoundedRegex } from 'n2-clotho';
import { fields, list } from './n2r-ast';
import { object, text } from './values';
import type { JsonObject, JsonValue } from './types';

interface Check {
  field: string;
  regex?: BoundedRegex;
  message: string;
}
export class CustomGuards {
  private readonly blacklist: BoundedRegex[] = [];
  private readonly checks: Check[] = [];
  private disposed = false;

  get count(): number {
    return this.blacklist.length + this.checks.length;
  }

  constructor(blocks: JsonObject[]) {
    try {
      for (const block of blocks) {
        if (block.type === 'Rule') this.rule(block);
        if (block.type === 'Contract') this.contract(block);
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  check(args: JsonObject): void {
    if (this.disposed) throw new Error('Custom-tool guards were disposed');
    const values = [JSON.stringify(args), ...stringValues(args)];
    for (const regex of this.blacklist)
      if (values.some((value) => regex.test(value)))
        throw new Error('N2R blacklist rejected tool arguments');
    for (const check of this.checks) {
      const value = Object.hasOwn(args, check.field) ? args[check.field] : undefined;
      const failed = check.regex
        ? check.regex.test(typeof value === 'string' ? value : '')
        : empty(value);
      if (failed) throw new Error(`N2R precondition rejected arguments: ${check.message}`);
    }
  }

  dispose(): void {
    for (const regex of this.blacklist) regex.free();
    for (const check of this.checks) check.regex?.free();
    this.disposed = true;
  }

  private rule(block: JsonObject): void {
    fields(block.fields, ['target', 'severity']);
    if (list(block.on_match).length) throw new Error('Custom rule actions are unsupported');
    for (const literal of list(block.blacklist)) {
      this.reserve();
      this.blacklist.push(compilePattern(text(literal, 'blacklist regex', 8192)));
    }
    for (const raw of list(block.checks)) {
      this.reserve();
      const check = object(raw);
      const match = /^params\.([A-Za-z_][A-Za-z0-9_]*)\s*!~\s*(\/.*\/[igm]*)$/s.exec(
        text(check.expression, 'rule check', 8192).trim(),
      );
      if (!match) throw new Error('Rule checks must use params.field !~ /pattern/flags');
      const message = text(check.message, 'rule message', 4096);
      this.checks.push({ field: match[1]!, regex: compilePattern(match[2]!), message });
    }
  }

  private contract(block: JsonObject): void {
    fields(block.fields, ['scope']);
    if (
      block.states !== null ||
      ['postconditions', 'invariants', 'recovery', 'transitions'].some(
        (key) => list(block[key]).length,
      )
    )
      throw new Error('Custom contracts support nonempty-field preconditions only');
    for (const raw of list(block.preconditions)) {
      this.reserve();
      const condition = object(raw);
      const match = /^params\.([A-Za-z_][A-Za-z0-9_]*)\s*!=\s*""$/.exec(
        text(condition.expression, 'precondition', 1024).trim(),
      );
      if (!match) throw new Error('Preconditions must use params.field != empty string');
      this.checks.push({
        field: match[1]!,
        message: text(condition.message, 'precondition message', 4096),
      });
    }
  }

  private reserve(): void {
    if (this.blacklist.length + this.checks.length >= 32)
      throw new Error('Custom tools support at most 32 predicates');
  }
}

function compilePattern(literal: string): BoundedRegex {
  const end = literal.lastIndexOf('/');
  if (!literal.startsWith('/') || end === 0) throw new Error('Expected a regex literal');
  return new BoundedRegex(literal.slice(1, end), literal.slice(end + 1));
}
function stringValues(value: JsonValue): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringValues);
  return [];
}
function empty(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === '') return true;
  return typeof value === 'object' && Object.keys(value).length === 0;
}
