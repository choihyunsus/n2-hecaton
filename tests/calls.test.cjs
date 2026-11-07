// Exercise real journal transactions and preserve uncertain effects across storage failures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./helpers.cjs');
const { CallLease } = require('../dist/lease');
const { CallStore } = require('../dist/call-store');
const { callInput } = require('../dist/call-record');
const { Circuit } = require('../dist/circuit');
const { hostEntry } = require('../dist/tool-entry');

function tool(extra = {}) {
  return hostEntry({
    name: 'write',
    version: '1',
    description: 'Fixture',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: () => ({ success: true, output: 'ok' }),
    ...extra,
  });
}
function input(entry, requestId = 'request', args = { text: 'hello' }) {
  return callInput(
    { requestId, sessionId: 'session', tool: entry.view.name, arguments: args },
    entry,
    'policy-1',
  );
}
function begin(store, entry, requestId = 'request') {
  const calls = new CallStore(store),
    lease = new CallLease(store, requestId, !entry.view.readOnly),
    circuit = new Circuit(store);
  const record = calls.begin(lease, input(entry, requestId));
  return { calls, lease, circuit, record };
}
function invoke(fixture, entry) {
  return fixture.lease.store.db.transaction(() => {
    const reserved = fixture.circuit.reserve(fixture.lease, entry);
    fixture.calls.pending(fixture.lease, reserved);
    return reserved;
  });
}

test('prepared intent and pending invocation precede file effects and completion saves exactly one scoped experience', (t) => {
  const { directory, open } = fixture(t),
    store = open(),
    entry = tool(),
    task = begin(store, entry);
  try {
    assert.equal(task.calls.get('request').state, 'prepared');
    assert.equal(task.calls.get('request').attempts, 0);
    const reserved = invoke(task, entry);
    fs.writeFileSync(path.join(directory, 'result.txt'), 'hello');
    const result = { success: true, output: 'written', modifiedFiles: ['result.txt'] };
    const complete = store.db.transaction(() => {
      task.circuit.finish(task.lease, entry, reserved, 'success');
      return task.calls.complete(task.lease, result);
    });
    assert.equal(complete.state, 'completed');
    assert.equal(complete.attempts, 1);
    assert.ok(complete.experienceId);
    assert.equal(task.calls.complete(task.lease, result).experienceId, complete.experienceId);
    const memory = store.memory.queryExperiences({
      project: 'fixture',
      agent: 'worker',
      limit: 10,
    });
    assert.equal(memory.length, 1);
    assert.equal(memory[0].sessionId, 'session');
    assert.equal(JSON.parse(memory[0].outcome).verified, false);
    assert.equal(task.calls.statistics('write', entry.view.definitionHash).usageCount, 1);
    assert.equal(new CallStore(open()).get('request').experienceId, complete.experienceId);
    assert.equal(new CallStore(open({ agent: 'other' })).get('request'), undefined);
  } finally {
    task.lease.release();
  }
});

test('completion rollback preserves the pending receipt and retries persistence without repeating a file effect', (t) => {
  const { directory, open } = fixture(t),
    store = open(),
    entry = tool(),
    task = begin(store, entry);
  try {
    const reserved = invoke(task, entry);
    const filename = path.join(directory, 'effect.txt');
    fs.appendFileSync(filename, 'one effect\n');
    store.db.execute(
      "CREATE TRIGGER fail_receipt BEFORE UPDATE ON hecaton_calls WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END",
    );
    const result = { success: false, output: 'observed tool failure' };
    assert.throws(
      () =>
        store.db.transaction(() => {
          task.circuit.finish(task.lease, entry, reserved, 'failure');
          task.calls.complete(task.lease, result);
        }),
      /fixture/,
    );
    assert.equal(task.calls.get('request').state, 'pending');
    assert.equal(task.circuit.status(entry).failures, 0);
    assert.equal(store.db.query('SELECT count(*) AS count FROM experiences')[0].count, 0);
    store.db.execute('DROP TRIGGER fail_receipt');
    const receipt = task.calls.complete(task.lease, result);
    assert.equal(receipt.state, 'completed');
    assert.equal(store.db.query('SELECT count(*) AS count FROM experiences')[0].count, 1);
    assert.equal(fs.readFileSync(filename, 'utf8'), 'one effect\n');
  } finally {
    task.lease.release();
  }
});

test('unknown non-idempotent outcomes require evidence and identical reconciliation is idempotent', (t) => {
  const store = fixture(t).open(),
    entry = tool(),
    task = begin(store, entry);
  try {
    invoke(task, entry);
    task.calls.unknown(task.lease, 'Host callback did not confirm its outcome');
    assert.equal(task.calls.begin(task.lease, input(entry)).state, 'unknown');
    assert.throws(
      () => task.calls.pending(task.lease, { epoch: 0, probe: false }),
      /reconciliation/,
    );
    assert.throws(
      () => task.calls.complete(task.lease, { success: true, output: 'ok' }),
      /evidence/,
    );
    assert.throws(
      () => task.calls.complete(task.lease, { success: false, output: 'blocked retry' }, true),
      /invocation state/,
    );
    const result = { success: true, output: 'file independently inspected' };
    const receipt = task.calls.complete(task.lease, result, false, 'Compared the output file hash');
    assert.equal(
      task.calls.complete(task.lease, result, false, 'Compared the output file hash').experienceId,
      receipt.experienceId,
    );
    assert.throws(
      () => task.calls.complete(task.lease, result, false, 'different evidence'),
      /differs/,
    );
    assert.equal(store.db.query('SELECT count(*) AS count FROM experiences')[0].count, 1);
  } finally {
    task.lease.release();
  }
});

test('idempotent retries preserve prior uncertainty until the next invocation actually begins', (t) => {
  const store = fixture(t).open(),
    entry = tool({ idempotent: true }),
    task = begin(store, entry);
  try {
    invoke(task, entry);
    task.calls.unknown(task.lease, 'Outcome unknown');
    const existing = task.calls.begin(task.lease, input(entry));
    assert.equal(existing.state, 'unknown');
    assert.equal(existing.attempts, 1);
    invoke(task, entry);
    assert.equal(task.calls.get('request').attempts, 2);
    assert.equal(
      task.calls.complete(task.lease, { success: true, output: 'confirmed retry' }).state,
      'completed',
    );
    assert.equal(task.calls.statistics('write', entry.view.definitionHash).usageCount, 1);
  } finally {
    task.lease.release();
  }
});

test('blocked preparation records a failure without tool usage and mismatching replay inputs are rejected', (t) => {
  const store = fixture(t).open(),
    entry = tool(),
    task = begin(store, entry);
  try {
    const blocked = task.calls.complete(
      task.lease,
      { success: false, output: 'Host authorization denied' },
      true,
    );
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.attempts, 0);
    assert.equal(task.calls.statistics('write', entry.view.definitionHash).usageCount, 0);
    assert.throws(
      () => task.calls.begin(task.lease, input(entry, 'request', { text: 'changed' })),
      /different/,
    );
    assert.throws(() => task.calls.begin(task.lease, input(tool({ version: '2' }))), /different/);
    assert.throws(() => task.calls.pending(task.lease, { epoch: 0, probe: false }), /Completed/);
  } finally {
    task.lease.release();
  }
});

test('damaged journal arguments and results fail hash validation while read-only mutation results stay pending', (t) => {
  const store = fixture(t).open(),
    entry = tool({ readOnly: true }),
    task = begin(store, entry);
  try {
    invoke(task, entry);
    assert.throws(
      () =>
        task.calls.complete(task.lease, {
          success: true,
          output: 'ok',
          modifiedFiles: ['changed'],
        }),
      /read-only/,
    );
    assert.equal(task.calls.get('request').state, 'pending');
    store.db.execute("UPDATE hecaton_calls SET arguments_json='{}'");
    assert.throws(() => task.calls.get('request'), /request hash mismatch/);
    store.db.execute('UPDATE hecaton_calls SET arguments_json=?', [
      JSON.stringify({ text: 'hello' }),
    ]);
    task.calls.complete(task.lease, { success: true, output: 'original' });
    store.db.execute('UPDATE hecaton_calls SET result_json=?', [
      JSON.stringify({ success: true, output: 'altered' }),
    ]);
    assert.throws(() => task.calls.get('request'), /result hash mismatch/);
  } finally {
    task.lease.release();
  }
});
