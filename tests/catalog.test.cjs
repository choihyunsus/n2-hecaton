// Verify schema execution and routing decisions before adding persistence or external effects.
const test = require('node:test');
const assert = require('node:assert/strict');
const { InputSchema } = require('../dist/schema');
const { hostEntry, checkedResult } = require('../dist/tool-entry');
const { Router } = require('../dist/router');
const { classify, queryDomains, tokens } = require('../dist/taxonomy');
const { plainJson, fingerprint } = require('../dist/values');
const inputSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};
const tool = (name, description, extra = {}) =>
  hostEntry({
    name,
    version: '1',
    description,
    inputSchema,
    execute: (args) => ({ success: true, output: args.text }),
    ...extra,
  });

test('schemas retain local references, constraints and independent linear patterns', () => {
  const schema = new InputSchema({
    type: 'object',
    definitions: {
      text: { type: 'string', pattern: '^a+$', minLength: 2 },
    },
    properties: {
      first: { $ref: '#/definitions/text' },
      second: { type: 'string', pattern: '^b+$' },
    },
    required: ['first', 'second'],
    additionalProperties: false,
  });
  assert.deepEqual(schema.check({ first: 'aa', second: 'bb' }), { first: 'aa', second: 'bb' });
  for (const value of [
    { first: 'a', second: 'bb' },
    { first: 'aa', second: 'aa' },
    { first: 'aa', second: 'bb', extra: 1 },
  ])
    assert.throws(() => schema.check(value), /schema/);
  const regex = new InputSchema({
    type: 'object',
    properties: { text: { type: 'string', pattern: '(a+)+$' } },
  });
  assert.throws(() => regex.check({ text: 'a'.repeat(10000) + '!' }), /schema/);
});

test('recursive, asynchronous, external and unsupported schema constraints fail at registration', () => {
  for (const schema of [
    { type: 'object', properties: { x: { $ref: '#' } } },
    { type: 'object', definitions: { x: { $ref: '#/definitions/x' } } },
    { type: 'object', properties: { x: { $ref: 'https://example.com/schema' } } },
    { type: 'object', $async: true },
    { type: 'object', properties: { x: { type: 'string', format: 'email' } } },
    { type: 'object', properties: { x: { type: 'string', pattern: '(?=a)' } } },
    { type: 'object', ignoredConstraint: true },
    { type: 'object', $schema: 'https://json-schema.org/draft/2020-12/schema' },
  ])
    assert.throws(() => new InputSchema(schema));
});

test('nested and prototype-shaped arguments preserve literal data without coercion', () => {
  const schema = new InputSchema({
    type: 'object',
    properties: {
      items: { type: 'array', maxItems: 2, items: { type: 'integer', minimum: 1 } },
    },
    required: ['items'],
    additionalProperties: true,
  });
  const data = JSON.parse('{"items":[1,2],"__proto__":{"literal":true}}');
  assert.deepEqual(schema.check(data), data);
  assert.equal({}.literal, undefined);
  assert.throws(() => schema.check({ items: ['1'] }));
  assert.throws(() => schema.check({ items: [1, 2, 3] }));
  assert.throws(() => plainJson([, 1]));
  assert.throws(() => plainJson({ text: '\ud800' }));
  assert.throws(() => plainJson({ count: Number.MAX_SAFE_INTEGER + 1 }));
  assert.equal(fingerprint({ a: 1, b: [2] }), fingerprint({ b: [2], a: 1 }));
});

test('host class methods and private state remain bound while metadata is snapshotted', async () => {
  class Counter {
    #calls = 0;
    name = 'counter';
    version = '1';
    description = 'fixture';
    inputSchema = inputSchema;
    execute(args) {
      return { success: true, output: `${args.text}:${++this.#calls}` };
    }
  }
  const original = new Counter();
  const entry = hostEntry(original);
  original.name = 'changed';
  assert.equal(entry.view.name, 'counter');
  assert.equal((await entry.execute({ text: 'ok' }, {})).output, 'ok:1');
  assert.equal((await entry.execute({ text: 'ok' }, {})).output, 'ok:2');
  assert.throws(
    () => checkedResult({ success: true, output: 'ok', modifiedFiles: ['changed'] }, true),
    /read-only/,
  );
  assert.throws(() => checkedResult({ success: 'true', output: 'ok' }, false));
  assert.throws(() => checkedResult({ success: true, output: '\ud800' }, false));
});

test('exact names, Korean aliases and unknown-domain descriptions select actual tools', () => {
  const entries = [
    tool('file_read', 'Read file content', {
      category: 'file',
      triggers: ['파일 내용 읽기'],
      readOnly: true,
    }),
    tool('summarize', '요약하기 literature', { category: 'mcp' }),
    tool('file_write', 'Write file content', { category: 'file' }),
  ];
  const router = new Router(entries.map((entry) => entry.view));
  assert.equal(router.route('FILE_READ').matches[0].name, 'file_read');
  assert.equal(router.route('파일 내용 읽기').matches[0].name, 'file_read');
  assert.equal(router.route('literature').matches[0].name, 'summarize');
  assert.equal(router.route('요약하기').matches[0].name, 'summarize');
  assert.equal(router.route('entirelyunrelated').matches.length, 0);
  assert.equal(router.route('').matches.length, 0);
  assert.equal(classify(entries[2].view).area, 'write');
  assert.equal(
    classify({ name: 'namespace_file_write', category: 'file', description: 'Write a file' }).area,
    'write',
  );
  assert.equal(
    classify({ name: 'namespace_file_read', category: 'file', description: 'Read a file' }).area,
    'read',
  );
  assert.ok(queryDomains(tokens('search')) & 1);
  assert.ok(queryDomains(tokens('search')) & (1 << 2));
});

test('routing ties, schemas and actual byte estimates remain stable across catalog order', () => {
  const entries = [tool('zeta', 'galaxy'), tool('alpha', 'galaxy')].map((entry) => entry.view);
  const first = new Router(entries).route('galaxy');
  const second = new Router([...entries].reverse()).route('galaxy');
  assert.deepEqual(
    first.matches.map((item) => item.name),
    ['alpha', 'zeta'],
  );
  assert.deepEqual(first, second);
  const payload = {
    hints: first.matches.map((item) => item.tool.dna),
    tools: first.matches.map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    })),
  };
  assert.equal(first.budget.selectedBytes, Buffer.byteLength(JSON.stringify(payload)));
  assert.equal(first.budget.estimatedTokens, Math.ceil(first.budget.selectedBytes / 4));
  first.matches[0].tool.inputSchema.required = [];
  assert.deepEqual(new Router(entries).route('galaxy').matches[0].tool.inputSchema.required, [
    'text',
  ]);
});
