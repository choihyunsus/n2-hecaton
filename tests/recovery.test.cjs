// Verify real process-loss recovery, cross-host admission and authorization before circuit probes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { fixture } = require('./helpers.cjs');
const { crashTool } = require('./crash-tool.cjs');
const { ReconciliationRequired } = require('../dist/library');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function tool(name, readOnly, execute) {
  return {
    name,
    readOnly,
    version: '1',
    description: 'Fixture capability',
    inputSchema: { type: 'object', additionalProperties: false },
    execute,
  };
}
function request(requestId, name = 'read') {
  return { requestId, tool: name, arguments: {} };
}

test('an actual worker exit preserves one file effect and requires reconciliation before replay', async (t) => {
  const setup = fixture(t);
  const child = spawnSync(
    process.execPath,
    [path.join(__dirname, 'crash-worker.cjs'), setup.options.dbPath, setup.directory],
    { encoding: 'utf8', timeout: 15000, windowsHide: true },
  );
  assert.equal(child.status, 37, child.stderr);
  const engine = setup.engine({ tools: [crashTool(setup.directory, false)] });
  const input = {
    requestId: 'crashed',
    sessionId: 'crash-session',
    tool: 'write',
    arguments: { text: 'one' },
  };
  const status = engine.status('crashed');
  assert.equal(status.call.state, 'pending');
  assert.equal(status.active, false);
  assert.equal(status.needsReconciliation, true);
  await assert.rejects(engine.execute(input), ReconciliationRequired);
  assert.equal(fs.readFileSync(path.join(setup.directory, 'effect.txt'), 'utf8'), 'one\n');
  engine.reconcile(
    'crashed',
    { success: true, output: 'written', modifiedFiles: ['effect.txt'] },
    'Read the persisted file after the worker exited',
  );
  assert.equal((await engine.execute(input)).cached, true);
  assert.equal(fs.readFileSync(path.join(setup.directory, 'effect.txt'), 'utf8'), 'one\n');
  assert.equal(setup.open().db.query('SELECT count(*) AS count FROM experiences')[0].count, 1);
});

test('four readers share the same database while writers and catalog changes wait for free capacity', async (t) => {
  const setup = fixture(t);
  const gates = Array.from({ length: 4 }, deferred),
    entered = Array.from({ length: 4 }, deferred);
  let writes = 0;
  const tools = [
    tool('read', true, (_args, context) => {
      const index = Number(context.requestId.slice(-1));
      entered[index].resolve();
      return gates[index].promise;
    }),
    tool('write', false, () => {
      writes++;
      return { success: true, output: 'written' };
    }),
  ];
  const first = setup.engine({ tools }),
    second = setup.engine({ tools }),
    third = setup.engine({ tools });
  const pending = [
    first.execute(request('read-0')),
    first.execute(request('read-1')),
    second.execute(request('read-2')),
    second.execute(request('read-3')),
  ];
  await Promise.all(entered.map((entry) => entry.promise));
  await assert.rejects(third.execute(request('fifth')), /busy/);
  await assert.rejects(third.execute(request('writer', 'write')), /busy/);
  assert.throws(
    () => first.installSource('@meta { name: "alias" handler: "native:read" enforce: strict }'),
    /local executions/,
  );
  assert.throws(
    () => third.installSource('@meta { name: "alias" handler: "native:read" enforce: strict }'),
    /busy/,
  );
  for (const gate of gates) gate.resolve({ success: true, output: 'read' });
  assert.ok((await Promise.all(pending)).every((result) => result.result.success));
  assert.equal((await third.execute(request('writer', 'write'))).result.success, true);
  assert.equal(writes, 1);
  assert.equal(first.statistics('read').usageCount, 4);
});

test('authorization precedes half-open reservation and cancelling the only probe permits recovery', async (t) => {
  const setup = fixture(t),
    gate = deferred(),
    entered = deferred();
  let calls = 0,
    allowed = true;
  const tools = [
    tool('read', true, () => {
      calls++;
      if (calls <= 3) return { success: false, output: 'known failure' };
      if (calls === 4) {
        entered.resolve();
        return gate.promise;
      }
      return { success: true, output: 'recovered' };
    }),
  ];
  const policy = { version: '1', authorize: () => allowed };
  const first = setup.engine({ tools, policy }),
    second = setup.engine({ tools, policy });
  first.installSource(
    '@meta { name: "alias" handler: "native:read" enforce: strict read_only: true }',
  );
  for (let index = 0; index < 3; index++) await first.execute(request(`failure-${index}`));
  assert.equal(first.circuit('read').state, 'open');
  const store = setup.open();
  store.db.execute('UPDATE hecaton_circuits SET opened_at=?', [Date.now() - 60001]);
  allowed = false;
  assert.equal((await first.execute(request('denied', 'alias'))).state, 'blocked');
  assert.equal(store.db.query('SELECT probe_nonce FROM hecaton_circuits')[0].probe_nonce, null);
  allowed = true;
  const abort = new AbortController(),
    pending = first.execute(request('probe', 'alias'), abort.signal);
  const rejected = assert.rejects(pending, ReconciliationRequired);
  await entered.promise;
  assert.equal(first.circuit('read').state, 'half_open');
  assert.equal((await second.execute(request('second-probe'))).state, 'blocked');
  assert.equal(calls, 4);
  abort.abort();
  await rejected;
  assert.equal(first.circuit('read').state, 'open');
  assert.equal((await second.execute(request('recovery'))).result.success, true);
  gate.resolve({ success: true, output: 'late discarded result' });
  await nextTurn();
  assert.equal(first.status('probe').call.state, 'unknown');
  assert.equal(first.circuit('read').state, 'closed');
});
