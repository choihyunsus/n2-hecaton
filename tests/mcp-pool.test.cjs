// Exercise persistent sessions and bounded cancellation without implicit operation replay.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ListToolsResultSchema } = require('@modelcontextprotocol/sdk/types.js');
const { McpPool, McpOperationError } = require('../dist/mcp-pool');
const { servers } = require('../dist/mcp-config');
const { Permits } = require('../dist/mcp-permits');

const configuration = {
  id: 'fixture',
  version: '1',
  transport: 'stdio',
  command: process.execPath,
  args: [path.join(__dirname, 'mcp-stdio-fixture.cjs'), 'normal'],
};
const signal = () => new AbortController().signal;
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('separate operations reuse one real MCP process and preserve remote state until explicit close', async () => {
  const pool = new McpPool([configuration]);
  let pid;
  try {
    const listed = await pool.run(
      'fixture',
      (client, signal) =>
        client.request({ method: 'tools/list' }, ListToolsResultSchema, { signal }),
      signal(),
    );
    assert.equal(listed.tools[0].name, 'echo');
    pid = pool.information()[0].processId;
    const first = await pool.run(
      'fixture',
      (client, signal) =>
        client.callTool({ name: 'echo', arguments: { text: 'first' } }, undefined, { signal }),
      signal(),
    );
    const second = await pool.run(
      'fixture',
      (client, signal) =>
        client.callTool({ name: 'echo', arguments: { text: 'second' } }, undefined, { signal }),
      signal(),
    );
    assert.equal(first.structuredContent.count, 1);
    assert.equal(second.structuredContent.count, 2);
    assert.equal(pool.information()[0].processId, pid);
  } finally {
    await pool.close();
  }
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error.code === 'ESRCH',
  );
  await assert.rejects(
    pool.run('fixture', async () => 1, signal()),
    /closed/,
  );
});

test('cancelled queued operations release their place without invoking the callback', async () => {
  const pool = new McpPool([configuration]),
    gate = deferred(),
    entered = deferred();
  let queuedCalls = 0;
  const first = pool.run(
    'fixture',
    async () => {
      entered.resolve();
      await gate.promise;
      return 'done';
    },
    signal(),
  );
  try {
    await entered.promise;
    const abort = new AbortController();
    const queued = pool.run(
      'fixture',
      async () => {
        queuedCalls++;
      },
      abort.signal,
    );
    const cancelled = assert.rejects(
      queued,
      (error) => error instanceof McpOperationError && error.code === 'cancelled',
    );
    abort.abort();
    await cancelled;
    gate.resolve();
    assert.equal(await first, 'done');
    assert.equal(queuedCalls, 0);
    assert.equal(await pool.run('fixture', async () => 'next', signal()), 'next');
  } finally {
    gate.resolve();
    await first.catch(() => {});
    await pool.close();
  }
});

test('an operation error is redacted, closes its session and is attempted exactly once', async () => {
  const pool = new McpPool([configuration]);
  let attempts = 0;
  try {
    await assert.rejects(
      pool.run(
        'fixture',
        async () => {
          attempts++;
          throw new Error('fixture-private-token');
        },
        signal(),
      ),
      (error) =>
        error instanceof McpOperationError && !error.message.includes('fixture-private-token'),
    );
    assert.equal(attempts, 1);
    assert.equal(pool.information()[0].connected, false);
    const result = await pool.run(
      'fixture',
      (client, signal) =>
        client.callTool({ name: 'echo', arguments: { text: 'fresh' } }, undefined, { signal }),
      signal(),
    );
    assert.equal(result.structuredContent.count, 1);
  } finally {
    await pool.close();
  }
});

test('host grants alone determine read-only and idempotent capabilities', () => {
  const pool = new McpPool([
    {
      ...configuration,
      toolPermissions: { echo: { readOnly: true }, write: { idempotent: true, timeoutMs: 5000 } },
    },
  ]);
  assert.deepEqual(pool.permission('fixture', 'unknown'), {
    readOnly: false,
    idempotent: false,
    timeoutMs: 120000,
  });
  assert.deepEqual(pool.permission('fixture', 'echo'), {
    readOnly: true,
    idempotent: true,
    timeoutMs: 120000,
  });
  assert.deepEqual(pool.permission('fixture', 'write'), {
    readOnly: false,
    idempotent: true,
    timeoutMs: 5000,
  });
  for (const grant of [
    { readOnly: null },
    { idempotent: 'true' },
    { timeoutMs: null },
    { promote: true },
  ])
    assert.throws(() => servers([{ ...configuration, toolPermissions: { echo: grant } }]));
  return pool.close();
});

test('permit queues remain bounded and cancelled waiters do not consume capacity', async () => {
  const permits = new Permits(1),
    owner = await permits.acquire(signal());
  const abort = new AbortController();
  const waiting = Array.from({ length: 32 }, () => permits.acquire(abort.signal));
  await assert.rejects(permits.acquire(signal()), /queue is full/);
  const outcomes = Promise.allSettled(waiting);
  abort.abort();
  assert.ok((await outcomes).every((result) => result.status === 'rejected'));
  owner();
  owner();
  const next = await permits.acquire(signal());
  next();
});
