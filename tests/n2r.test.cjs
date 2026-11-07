// Run legacy custom-tool predicates through the published compiler and real host callbacks.
const test = require('node:test');
const assert = require('node:assert/strict');
const { compileTool } = require('../dist/n2r-tool');
const { hostEntry } = require('../dist/tool-entry');
const { parseSource } = require('../dist/n2r-ast');

const source = String.raw`@meta { name: "echo_tool" handler: "native:echo" enforce: strict read_only: true
  param_descriptions: "{\"text\":\"Text to return\"}" triggers: ["메아리"] }
@schema { Input { text: String [required] } }
@contract Required { scope: request precondition { params.text != "" => "text is required" } }
@rule Guard { target: "echo_tool" severity: low check { params.text !~ /secret/i => "fixture rule" } blacklist: [/blocked/] }
@workflow Run { trigger: tool_call apply_contracts: [Required] step go { action: "native:echo" timeout: 1s output -> $RESULT } }`;

function binding(extra = {}) {
  return hostEntry({
    name: 'echo',
    version: '1',
    description: 'Return supplied text',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 1000 } },
      required: ['text'],
      additionalProperties: false,
    },
    execute: (args) => ({ success: true, output: args.text }),
    ...extra,
  });
}
function compile(value = source, host = binding()) {
  return compileTool(value, (id) => {
    assert.equal(id, 'host:echo');
    return host;
  });
}
async function invoke(entry, args) {
  const checked = entry.schema.check(args);
  entry.guard(checked);
  return entry.execute(checked, {});
}

test('legacy typed schema, description, workflow timeout and guards execute before the callback', async (t) => {
  let calls = 0;
  const entry = compile(
    source,
    binding({
      execute(args) {
        calls++;
        return { success: true, output: args.text };
      },
    }),
  );
  t.after(() => entry.dispose());
  assert.equal(entry.view.timeoutMs, 1000);
  assert.equal(entry.view.bindingId, 'host:echo');
  assert.equal(entry.view.source, 'n2r');
  assert.equal(entry.view.inputSchema.properties.text.description, 'Text to return');
  assert.deepEqual(entry.view.triggers, ['메아리']);
  assert.equal((await invoke(entry, { text: 'hello' })).output, 'hello');
  for (const args of [
    { text: '' },
    { text: 'SECRET' },
    { text: 'blocked' },
    { text: 1 },
    {},
    { text: 'x'.repeat(1001) },
    { text: 'ok', extra: true },
  ])
    await assert.rejects(invoke(entry, args));
  assert.equal(calls, 1);
});

test('Rust Unicode word predicates and multiline raw values are preserved', async (t) => {
  const unicode = compile(source.replace('/secret/i', '/^\\w+$/'));
  const multiline = compile(source.replace('/blocked/', '/^blocked$/m'));
  t.after(() => {
    unicode.dispose();
    multiline.dispose();
  });
  await assert.rejects(invoke(unicode, { text: '한글_123' }), /precondition/);
  assert.equal((await invoke(unicode, { text: 'two words' })).success, true);
  await assert.rejects(invoke(multiline, { text: 'before\nblocked\nafter' }), /blacklist/);
});

test('metadata cannot promote mutating or non-idempotent host bindings', () => {
  assert.throws(() => compile(source, binding({ readOnly: false })), /upgrade/);
  assert.throws(
    () =>
      compile(
        source.replace('read_only: true', 'read_only: true idempotent: true'),
        binding({ idempotent: false }),
      ),
    /upgrade/,
  );
  assert.throws(() => compile(source.replace('read_only: true', 'read_only: "true"')), /booleans/);
  assert.throws(() => compile(source.replace('enforce: strict', 'enforce: warn')), /strict/);
});

test('unsupported execution syntax, ambiguous schemas and malformed source fail before installation', () => {
  for (const value of [
    source.replace('action: "native:echo"', 'action: "native:other"'),
    source.replace('timeout: 1s', 'timeout: 121s'),
    source.replace('output -> $RESULT', 'output -> $OTHER'),
    source.replace('params.text != ""', 'params.text == "yes"'),
    source.replace('params.text !~ /secret/i', 'params.text == "secret"'),
    source.replace('/secret/i', '/(a)\\1/'),
    source.replace('scope: request', 'scope: request states: Mode'),
    source.replace('name: "echo_tool"', 'name: "echo_tool" input_schema_json: "{}"'),
    source + '\n@schema { Second { value: Int } }',
    source + '\n@workflow Second { step go { action: "native:echo" } }',
    source + '\n@meta { name: "duplicate" enforce: strict }',
    source + '\ud800',
  ])
    assert.throws(() => compile(value));
  assert.throws(() => parseSource('x'.repeat(65537)), /source/);
});

test('JSON schema inputs retain constraints and changing a binding version changes the definition hash', (t) => {
  const schema = JSON.stringify({
    type: 'object',
    properties: { text: { type: 'string', enum: ['ok'] } },
    required: ['text'],
  });
  const value = `@meta { name: "alias" handler: "host:echo" enforce: strict input_schema_json: ${JSON.stringify(schema)} }`;
  const first = compile(value),
    second = compile(value, binding({ version: '2' }));
  t.after(() => {
    first.dispose();
    second.dispose();
  });
  assert.notEqual(first.view.definitionHash, second.view.definitionHash);
  assert.deepEqual(first.schema.check({ text: 'ok' }), { text: 'ok' });
  assert.throws(() => first.schema.check({ text: 'different' }), /schema/);
});
