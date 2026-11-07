// Exercise persistent registry changes and actual guarded bindings without model fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers.cjs');
const { Registry } = require('../dist/registry');

function host(extra = {}) {
  return {
    name: 'echo',
    version: '1',
    description: 'Return text',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    execute: (args) => ({ success: true, output: args.text }),
    ...extra,
  };
}
function source(name = 'alias', guard = '') {
  return `@meta { name: "${name}" handler: "native:echo" enforce: strict read_only: true triggers: ["메아리"] } ${guard}`;
}
function registry(t, store, hosts = [host()]) {
  const catalog = new Registry(store, hosts);
  t.after(() => catalog.close());
  return catalog;
}

test('installed source restores its real handler and another connection sees CAS replacement', async (t) => {
  const { open } = fixture(t);
  const store = open(),
    first = registry(t, store),
    second = registry(t, open());
  const record = first.installSource(source(), null);
  assert.equal(second.get('alias').view.source, 'n2r');
  assert.equal(second.route('메아리').matches[0].name, 'alias');
  const replacement = first.installSource(
    source('alias', '@rule Guard { blacklist: [/blocked/] }'),
    record.contentHash,
  );
  assert.equal(replacement.revision, 2);
  const entry = second.get('alias');
  assert.throws(() => entry.guard({ text: 'blocked' }), /blacklist/);
  assert.equal((await entry.execute(entry.schema.check({ text: 'ok' }), {})).output, 'ok');
  assert.equal(entry.capabilityHash, second.get('echo').capabilityHash);
  first.remove('alias', replacement.contentHash);
  assert.throws(() => second.get('alias'), /unavailable/);
});

test('name collisions, stale writes and invalid candidates preserve the current source and host capability', (t) => {
  const store = fixture(t).open(),
    catalog = registry(t, store);
  const record = catalog.installSource(source(), null);
  assert.throws(() => catalog.installSource(source('ECHO'), null), /collides/);
  assert.throws(
    () => catalog.installSource(source('ALIAS'), record.contentHash),
    /collides|Case-only/,
  );
  assert.throws(() =>
    catalog.installSource(
      source('alias', '@rule Guard { blacklist: [/(a)\\1/] }'),
      record.contentHash,
    ),
  );
  assert.throws(
    () => catalog.installSource(source('alias', '@rule Guard { blacklist: [/new/] }'), null),
    /changed/,
  );
  assert.throws(() => catalog.remove('echo', record.contentHash), /Host capabilities/);
  assert.equal(store.definitions()[0].contentHash, record.contentHash);
  assert.equal(catalog.list().length, 2);
});

test('unavailable bindings remain inspectable and recover when configured while host tools remain available', (t) => {
  const { open } = fixture(t),
    store = open();
  store.putDefinition({ name: 'alias', kind: 'n2r', content: source() }, null);
  const missing = registry(t, store, [host({ name: 'other' })]);
  assert.deepEqual(
    missing.list().map((item) => item.name),
    ['other'],
  );
  assert.equal(missing.problems()[0].name, 'alias');
  assert.equal(store.definitions().length, 1);
  const recovered = registry(t, open());
  assert.equal(recovered.get('alias').view.name, 'alias');
  assert.deepEqual(recovered.problems(), []);
});

test('catalog copies do not change executable schemas and ambiguous host names fail before registration', (t) => {
  const store = fixture(t).open(),
    catalog = registry(t, store);
  const visible = catalog.list();
  visible[0].inputSchema.required = [];
  assert.throws(() => catalog.get('echo').schema.check({}), /schema/);
  assert.throws(() => new Registry(store, [host(), host({ name: 'ECHO' })]), /collision/);
  assert.throws(
    () =>
      new Registry(
        store,
        Array.from({ length: 513 }, () => host()),
      ),
    /limit/,
  );
});

test('aggregate predicate limits reject installation before saving an oversized catalog', (t) => {
  const store = fixture(t).open(),
    catalog = registry(t, store);
  const guard = `@rule Guard { blacklist: [${Array.from({ length: 32 }, () => '/blocked/').join(',')}] }`;
  for (let index = 0; index < 16; index++)
    catalog.installSource(source(`alias_${index}`, guard), null);
  assert.throws(() => catalog.installSource(source('overflow', guard), null), /limit/);
  assert.equal(store.definitions().length, 16);
  assert.equal(catalog.list().length, 17);
});
