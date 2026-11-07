// Run the public engine through real side effects, restart, authorization and durable recovery.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { fixture } = require('./helpers.cjs');
const { ReconciliationRequired } = require('../dist/library');

const schema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};
const host = (execute, extra = {}) => ({
  name: 'echo',
  version: '1',
  description: 'Return text',
  inputSchema: schema,
  execute,
  ...extra,
});
const request = (requestId = 'request', tool = 'echo', args = { text: 'hello' }) => ({
  requestId,
  sessionId: 'session',
  tool,
  arguments: args,
});
const source = (extra = '') =>
  `@meta { name: "alias" handler: "native:echo" enforce: strict read_only: true triggers: ["메아리"] } ${extra}`;

test('normal entry journals before a class callback and replays a completed real file task across restart', async (t) => {
  const setup = fixture(t),
    filename = path.join(setup.directory, 'result.txt');
  let engine;
  class FileTool {
    #calls = 0;
    name = 'echo';
    version = '1';
    description = 'Write one file';
    inputSchema = schema;
    get count() {
      return this.#calls;
    }
    execute(args, context) {
      this.#calls++;
      assert.equal(Object.isFrozen(context), true);
      assert.equal(context.project, 'fixture');
      assert.equal(context.sessionId, 'session');
      assert.equal(engine.status(context.requestId).call.state, 'pending');
      fs.writeFileSync(filename, args.text);
      args.text = 'changed callback argument';
      return { success: true, output: 'written', modifiedFiles: ['result.txt'] };
    }
  }
  const tool = new FileTool();
  engine = setup.engine({ tools: [tool] });
  const input = request();
  const first = await engine.execute(input);
  assert.equal(first.result.success, true);
  assert.equal(first.cached, false);
  assert.equal(input.arguments.text, 'hello');
  assert.equal(engine.status('request').call.arguments.text, 'hello');
  await engine.close();
  engine = setup.engine({ tools: [tool] });
  const replay = await engine.execute(request());
  assert.equal(replay.cached, true);
  assert.equal(replay.experienceId, first.experienceId);
  assert.equal(tool.count, 1);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'hello');
  assert.equal(engine.history()[0].requestId, 'request');
  assert.equal(engine.statistics('echo').usageCount, 1);
});

test('N2R guards, caller argument schemas and routing execute through the normal entry', async (t) => {
  const setup = fixture(t);
  let calls = 0;
  const engine = setup.engine({
    tools: [
      host(
        (args) => {
          calls++;
          return { success: true, output: args.text };
        },
        { readOnly: true },
      ),
    ],
  });
  const record = engine.installSource(source('@rule Guard { blacklist: [/blocked/] }'));
  const denied = await engine.execute(request('denied', 'alias', { text: 'blocked' }));
  assert.equal(denied.state, 'blocked');
  assert.equal(denied.attempts, 0);
  assert.equal((await engine.execute(request('invalid', 'alias', { text: 1 }))).state, 'blocked');
  const routed = await engine.auto({
    requestId: 'routed',
    query: '메아리',
    arguments: { text: 'hello' },
  });
  assert.equal(routed.route.matches[0].name, 'alias');
  assert.equal(routed.execution.result.output, 'hello');
  assert.equal(calls, 1);
  const restored = setup.engine({
    tools: [host((args) => ({ success: true, output: args.text }), { readOnly: true })],
  });
  assert.equal(restored.definitions()[0].contentHash, record.contentHash);
  assert.equal(
    (await restored.execute(request('restart', 'alias', { text: 'blocked' }))).state,
    'blocked',
  );
});

test('host exceptions preserve uncertain file effects, redact secrets and reconcile after the capability is removed', async (t) => {
  const setup = fixture(t),
    filename = path.join(setup.directory, 'effects.txt');
  const engine = setup.engine({
    tools: [
      host(() => {
        fs.appendFileSync(filename, 'one\n');
        throw new Error('fixture-private-token');
      }),
    ],
  });
  await assert.rejects(engine.execute(request()), ReconciliationRequired);
  await assert.rejects(engine.execute(request()), ReconciliationRequired);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'one\n');
  const status = engine.status('request');
  assert.equal(status.uncertain, true);
  assert.equal(status.active, false);
  assert.equal(status.needsReconciliation, true);
  assert.doesNotMatch(JSON.stringify(status), /fixture-private-token/);
  await engine.close();
  const recovery = setup.engine({ tools: [] });
  const result = { success: true, output: 'Inspected exactly one output line' };
  const receipt = recovery.reconcile(
    'request',
    result,
    'Read effects.txt and checked its single line',
  );
  assert.equal(receipt.cached, false);
  assert.equal(
    recovery.reconcile('request', result, 'Read effects.txt and checked its single line').cached,
    true,
  );
  assert.equal(setup.open().db.query('SELECT count(*) AS count FROM experiences')[0].count, 1);
});

test('idempotent retry is delayed by current authorization without losing the earlier uncertainty', async (t) => {
  const setup = fixture(t);
  let calls = 0,
    allowed = true;
  class Policy {
    #checks = 0;
    version = '1';
    authorize() {
      this.#checks++;
      return allowed;
    }
    get count() {
      return this.#checks;
    }
  }
  const policy = new Policy();
  const engine = setup.engine({
    policy,
    tools: [
      host(
        () => {
          if (++calls === 1) throw new Error('unconfirmed');
          return { success: true, output: 'ok' };
        },
        { idempotent: true },
      ),
    ],
  });
  await assert.rejects(engine.execute(request()), ReconciliationRequired);
  allowed = false;
  await assert.rejects(engine.execute(request()), ReconciliationRequired);
  assert.equal(engine.status('request').call.state, 'unknown');
  assert.equal(calls, 1);
  allowed = true;
  assert.equal((await engine.execute(request())).attempts, 2);
  allowed = false;
  await assert.rejects(engine.execute(request()), /historical result/);
  assert.equal(engine.status('request').call.state, 'completed');
  assert.equal(calls, 2);
  assert.equal(policy.count, 4);
});

test('uncooperative tool deadlines and reentrant close discard late results', async (t) => {
  const setup = fixture(t);
  let finish;
  const engine = setup.engine({
    tools: [
      host(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        { timeoutMs: 5 },
      ),
    ],
  });
  await assert.rejects(engine.execute(request()), ReconciliationRequired);
  assert.equal(engine.status('request').call.state, 'unknown');
  const firstClose = engine.close(),
    secondClose = engine.close();
  assert.equal(firstClose, secondClose);
  await firstClose;
  finish({ success: true, output: 'late' });
  await nextTurn();
  const store = setup.open();
  assert.equal(store.db.query('SELECT state FROM hecaton_calls')[0].state, 'unknown');
  assert.equal(store.db.query('SELECT count(*) AS count FROM experiences')[0].count, 0);
  await assert.rejects(engine.execute(request('after-close')), /closed/);
});

test('authorization deadlines remain known pre-invocation failures with no tool side effect', async (t) => {
  const setup = fixture(t);
  let calls = 0;
  const engine = setup.engine({
    policyTimeoutMs: 5,
    policy: { version: '1', authorize: () => new Promise(() => {}) },
    tools: [
      host(() => {
        calls++;
        return { success: true, output: 'unexpected' };
      }),
    ],
  });
  const result = await engine.execute(request());
  assert.equal(result.state, 'blocked');
  assert.equal(result.attempts, 0);
  assert.equal(calls, 0);
  assert.equal(engine.status('request').needsReconciliation, false);
});

test('failed completion commits never re-run a real effect and can be reconciled after storage repair', async (t) => {
  const setup = fixture(t),
    filename = path.join(setup.directory, 'effects.txt');
  const engine = setup.engine({
    tools: [
      host(() => {
        fs.appendFileSync(filename, 'one\n');
        return { success: true, output: 'done' };
      }),
    ],
  });
  const store = setup.open();
  store.db.execute(
    "CREATE TRIGGER fail_completion BEFORE UPDATE ON hecaton_calls WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END",
  );
  await assert.rejects(engine.execute(request()), ReconciliationRequired);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'one\n');
  assert.equal(engine.status('request').call.state, 'unknown');
  assert.equal(store.db.query('SELECT count(*) AS count FROM experiences')[0].count, 0);
  store.db.execute('DROP TRIGGER fail_completion');
  engine.reconcile('request', { success: true, output: 'done' }, 'Inspected the persisted file');
  assert.equal((await engine.execute(request())).cached, true);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'one\n');
});

test('Gumiho tool adapters keep stable replay identity across restart and refuse stale definitions', async (t) => {
  const setup = fixture(t);
  let calls = 0;
  const tool = host(
    (args) => {
      calls++;
      return { success: true, output: args.text };
    },
    { readOnly: true },
  );
  const engine = setup.engine({ tools: [tool] });
  const record = engine.installSource(source());
  const adapter = engine.asGumihoTools(['alias'])[0];
  const context = {
    project: 'fixture',
    agent: 'worker',
    runId: 'run',
    jobId: 'job',
    callId: 'call',
    tailId: 'build',
    signal: new AbortController().signal,
  };
  assert.equal(adapter.idempotent, true);
  assert.equal((await adapter.execute({ text: 'ok' }, context)).success, true);
  assert.equal((await adapter.execute({ text: 'ok' }, context)).success, true);
  const restored = setup.engine({ tools: [tool] }).asGumihoTools(['alias'])[0];
  assert.equal(adapter.version, restored.version);
  assert.equal((await restored.execute({ text: 'ok' }, context)).success, true);
  assert.equal(calls, 1);
  await assert.rejects(adapter.execute({ text: 'ok' }, { ...context, agent: 'other' }), /scopes/);
  await assert.rejects(
    adapter.execute({ text: 'ok' }, { ...context, callId: undefined }),
    /call ID/,
  );
  engine.installSource(source('@rule Guard { blacklist: [/blocked/] }'), record.contentHash);
  await assert.rejects(adapter.execute({ text: 'ok' }, context), /capability changed/);
});
