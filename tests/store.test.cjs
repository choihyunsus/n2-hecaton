// Verify durable definition transactions, schema boundaries and cross-connection execution leases.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./helpers.cjs');
const { HecatonStore, digest } = require('../dist/store');
const { CallLease } = require('../dist/lease');

test('definitions survive restart with scoped CAS updates and case collision protection', (t) => {
  const { open } = fixture(t);
  const store = open();
  const first = store.putDefinition({ name: 'echo', kind: 'n2r', content: 'first source' }, null);
  assert.equal(first.revision, 1);
  const second = open();
  assert.deepEqual(second.definitions(), [first]);
  assert.deepEqual(open({ agent: 'other' }).definitions(), []);
  assert.throws(
    () => second.putDefinition({ name: 'echo', kind: 'n2r', content: 'stale' }, null),
    /changed/,
  );
  assert.throws(
    () =>
      second.putDefinition({ name: 'ECHO', kind: 'n2r', content: 'collision' }, first.contentHash),
    /Case-only/,
  );
  const changed = second.putDefinition(
    { name: 'echo', kind: 'n2r', content: 'new source' },
    first.contentHash,
  );
  assert.equal(changed.revision, 2);
  assert.equal(store.definitions()[0].content, 'new source');
  assert.throws(() => store.removeDefinition('echo', first.contentHash), /changed/);
  store.removeDefinition('echo', changed.contentHash);
  assert.deepEqual(second.definitions(), []);
});

test('failed definition writes roll back complete source, hash and revision together', (t) => {
  const store = fixture(t).open();
  const original = store.putDefinition({ name: 'echo', kind: 'n2r', content: 'original' }, null);
  store.db.execute(
    "CREATE TRIGGER stop_definition BEFORE UPDATE ON hecaton_definitions BEGIN SELECT RAISE(ABORT,'fixture rollback'); END",
  );
  assert.throws(
    () =>
      store.putDefinition({ name: 'echo', kind: 'n2r', content: 'changed' }, original.contentHash),
    /fixture/,
  );
  assert.deepEqual(store.definitions(), [original]);
  assert.equal(store.db.query('PRAGMA integrity_check')[0].integrity_check, 'ok');
});

test('damaged source, type and NUL records fail explicitly while preserving original stored bytes', (t) => {
  const store = fixture(t).open();
  store.putDefinition({ name: 'echo', kind: 'n2r', content: 'original' }, null);
  store.db.execute("UPDATE hecaton_definitions SET content='altered'");
  assert.throws(() => store.definitions(), /hash mismatch/);
  store.db.execute('UPDATE hecaton_definitions SET content=?,content_hash=?', [
    'before\0after',
    digest('before\0after'),
  ]);
  assert.throws(() => store.definitions(), /content/);
  assert.equal(
    store.db.query('SELECT length(CAST(content AS BLOB)) AS bytes FROM hecaton_definitions')[0]
      .bytes,
    12,
  );
  store.db.execute('UPDATE hecaton_definitions SET content=?,content_hash=?', [
    'original',
    digest('original'),
  ]);
  store.db.execute('PRAGMA ignore_check_constraints=ON');
  store.db.execute('UPDATE hecaton_definitions SET content=zeroblob(1048576)');
  assert.throws(() => store.definitions(), /content/);
});

test('future, incomplete and unversioned module schemas refuse startup', (t) => {
  const { open } = fixture(t);
  const store = open();
  store.db.execute("UPDATE meta SET value='2' WHERE key='hecaton_schema_version'");
  assert.throws(() => open(), /Unsupported/);
  store.db.execute("UPDATE meta SET value='1' WHERE key='hecaton_schema_version'");
  store.db.execute('DROP TABLE hecaton_statistics');
  assert.throws(() => open(), /incomplete/);
  store.db.execute("DELETE FROM meta WHERE key='hecaton_schema_version'");
  assert.throws(() => open(), /Unversioned/);
});

test('durable paths reject directories, memory and malformed Unicode before opening SQLite', (t) => {
  const { options, directory } = fixture(t);
  for (const dbPath of [':memory:', directory, path.join(directory, '\ud800.db')])
    assert.throws(() => new HecatonStore({ ...options, dbPath }));
  if (process.platform === 'win32') {
    for (const dbPath of [path.join(directory, 'NUL.db'), path.join(directory, 'db:stream')])
      assert.throws(() => new HecatonStore({ ...options, dbPath }), /reserved/);
  }
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('shared scope admits four readers or one writer and rejects duplicate active request IDs', (t) => {
  const { open } = fixture(t),
    first = open(),
    second = open();
  const leases = [];
  try {
    leases.push(new CallLease(first, 'read-0', false));
    assert.throws(() => new CallLease(second, 'read-0', false), /active owner/);
    assert.throws(() => new CallLease(second, 'write', true), /busy/);
    for (let index = 1; index < 4; index++)
      leases.push(new CallLease(second, `read-${index}`, false));
    assert.throws(() => new CallLease(first, 'fifth', false), /busy/);
  } finally {
    for (const lease of leases) lease.release();
  }
  const writer = new CallLease(second, 'write', true);
  try {
    assert.throws(() => new CallLease(first, 'read', false), /busy/);
  } finally {
    writer.release();
  }
});

test('expired ownership is fenced and releasing an old nonce preserves its replacement', (t) => {
  const { open } = fixture(t),
    first = open(),
    second = open();
  const old = new CallLease(first, 'write', true);
  first.db.execute('UPDATE hecaton_leases SET expires_at=0');
  const current = new CallLease(second, 'write', true);
  try {
    assert.throws(() => old.assert(), /lost|expired/);
    old.release();
    current.assert();
    assert.equal(second.db.query('SELECT nonce FROM hecaton_leases')[0].nonce, current.nonce);
  } finally {
    old.release();
    current.release();
  }
});
