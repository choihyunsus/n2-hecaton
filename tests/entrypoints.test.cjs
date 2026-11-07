// Exercise installed-shaped CLI and real MCP clients, including large results and shutdown ownership.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createHash } = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { fixture } = require('./helpers.cjs');
const { inspectHecaton } = require('../dist/library');
const { parseCli } = require('../dist/cli-options');
const cli = path.join(__dirname, '../dist/index.js');
const adapter = path.join(__dirname, 'cli-adapter.cjs');
const scope = (setup) => [
  '--db',
  setup.options.dbPath,
  '--project',
  'fixture',
  '--agent',
  'worker',
];
function run(setup, command, args = [], env = {}) {
  return spawnSync(process.execPath, [cli, command, ...scope(setup), ...args], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
}
const executeArgs = (id, tool) => [
  '--adapter',
  adapter,
  '--tool',
  tool,
  '--request-id',
  id,
  '--args-json',
  '{"text":"안녕😀"}',
];

test('bundled host and N2R examples run through the public engine and preserve inherited input checks', async (t) => {
  const setup = fixture(t);
  const engine = setup.engine(require('../examples/host.cjs'));
  const source = fs.readFileSync(path.join(__dirname, '../examples/echo.n2r'), 'utf8');
  engine.installSource(source);
  const valid = await engine.execute({
    requestId: 'example',
    tool: 'echo_checked',
    arguments: { text: 'hello' },
  });
  assert.equal(valid.result.output, 'hello');
  const invalid = await engine.execute({
    requestId: 'empty-example',
    tool: 'echo_checked',
    arguments: { text: '' },
  });
  assert.equal(invalid.state, 'blocked');
  const inherited = await engine.execute({
    requestId: 'oversized-example',
    tool: 'echo_checked',
    arguments: { text: 'x'.repeat(1001) },
  });
  assert.equal(inherited.state, 'blocked');
});

test('read-only inspection checks scopes and content without creating or migrating a database', async (t) => {
  const setup = fixture(t);
  const missing = { ...setup.options, dbPath: path.join(setup.directory, 'missing', 'new.db') };
  assert.throws(() => inspectHecaton({ ...missing, view: 'history' }));
  assert.equal(fs.existsSync(path.dirname(missing.dbPath)), false);
  const engine = setup.engine({
    tools: [
      {
        name: 'echo',
        version: '1',
        description: 'Text',
        inputSchema: { type: 'object' },
        readOnly: true,
        execute: () => ({ success: true, output: 'checked' }),
      },
    ],
  });
  engine.installSource('@meta { name: "alias" handler: "native:echo" enforce: strict }');
  await engine.execute({ requestId: 'one', tool: 'echo', arguments: {} });
  await engine.close();
  const original = fs.readFileSync(setup.options.dbPath);
  assert.equal(
    inspectHecaton({ ...setup.options, view: 'status', requestId: 'one' }).status.call.result
      .output,
    'checked',
  );
  assert.equal(
    inspectHecaton({ ...setup.options, agent: 'other', view: 'history' }).history.length,
    0,
  );
  assert.equal(
    inspectHecaton({ ...setup.options, view: 'definitions' }).definitions[0].name,
    'alias',
  );
  assert.deepEqual(fs.readFileSync(setup.options.dbPath), original);
  const db = setup.open();
  db.db.execute("UPDATE hecaton_definitions SET content='corrupt'");
  assert.throws(() => inspectHecaton({ ...setup.options, view: 'definitions' }), /hash mismatch/);
  db.db.execute("UPDATE meta SET value='2' WHERE key='hecaton_schema_version'");
  assert.throws(() => inspectHecaton({ ...setup.options, view: 'history' }), /version 1/);
});

test('CLI preserves literal values, rejects duplicate/irrelevant flags and loads CJS or ESM without scope overrides', (t) => {
  const setup = fixture(t);
  assert.equal(parseCli(['route', '--query', '--literal']).values.get('query'), '--literal');
  assert.equal(parseCli(['route', '--query=--literal']).values.get('query'), '--literal');
  for (const args of [
    ['list', '--unknown', 'x'],
    ['list', '--db', 'a', '--db', 'b'],
    ['list', '--db'],
    ['status', '--adapter', adapter],
  ])
    assert.throws(() => parseCli(args));
  const result = run(setup, 'call', executeArgs('echo-request', 'echo'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.output, '안녕😀');
  const status = run(setup, 'status', ['--request-id', 'echo-request']);
  assert.equal(JSON.parse(status.stdout).status.call.tool.name, 'echo');
  const esm = path.join(setup.directory, 'adapter.mjs');
  fs.writeFileSync(esm, 'export default {tools:[]};');
  assert.equal(run(setup, 'list', ['--adapter', esm]).status, 0);
  fs.writeFileSync(esm + '.cjs', 'throw new Error("fixture-private-token");');
  const failed = run(setup, 'list', ['--adapter', esm + '.cjs']);
  assert.equal(failed.status, 1);
  assert.doesNotMatch(failed.stderr, /fixture-private-token/);
  assert.match(failed.stderr, /could not be loaded/);
  assert.equal(run(setup, 'call', executeArgs('known-failure', 'failure')).status, 2);
});

test('CLI executes, installs, inspects, removes and reconciles while preserving one real effect across restarts', (t) => {
  const setup = fixture(t),
    effect = path.join(setup.directory, 'effects.txt');
  const env = { HECATON_EFFECT_FILE: effect };
  const first = run(setup, 'call', executeArgs('one', 'write'), env);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(
    JSON.parse(run(setup, 'call', executeArgs('one', 'write'), env).stdout).cached,
    true,
  );
  assert.equal(fs.readFileSync(effect, 'utf8'), '안녕😀\n');
  const source = path.join(setup.directory, 'alias.n2r');
  fs.writeFileSync(
    source,
    '@meta { name: "alias" handler: "native:echo" enforce: strict triggers: ["메아리"] }',
  );
  const installed = run(setup, 'install', ['--adapter', adapter, '--source', source]);
  assert.equal(installed.status, 0, installed.stderr);
  const record = JSON.parse(installed.stdout);
  const routed = run(setup, 'route', ['--adapter', adapter, '--query', '메아리']);
  assert.equal(JSON.parse(routed.stdout).matches[0].name, 'alias');
  assert.equal(JSON.parse(run(setup, 'definitions').stdout).definitions[0].name, 'alias');
  assert.equal(
    run(setup, 'remove', [
      '--adapter',
      adapter,
      '--tool',
      'alias',
      '--expected-hash',
      record.contentHash,
    ]).status,
    0,
  );
  assert.equal(run(setup, 'call', executeArgs('uncertain', 'unknown'), env).status, 1);
  assert.equal(run(setup, 'call', executeArgs('uncertain', 'unknown'), env).status, 1);
  assert.equal(fs.readFileSync(effect, 'utf8'), '안녕😀\n안녕😀\n');
  const reconciled = run(setup, 'reconcile', [
    '--request-id',
    'uncertain',
    '--result-json',
    '{"success":true,"output":"inspected"}',
    '--evidence',
    'Read two stored output lines',
  ]);
  assert.equal(reconciled.status, 0, reconciled.stderr);
  const restored = run(setup, 'status', ['--request-id', 'uncertain']);
  assert.equal(JSON.parse(restored.stdout).status.call.result.output, 'inspected');
  assert.equal(JSON.parse(run(setup, 'history').stdout).history.length, 2);
  fs.writeFileSync(source, Buffer.from([0xc3, 0x28]));
  assert.equal(run(setup, 'install', ['--adapter', adapter, '--source', source]).status, 1);
  assert.equal(
    run(setup, 'install', ['--adapter', adapter, '--source', setup.directory]).status,
    1,
  );
});

async function connect(t, setup) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp', ...scope(setup), '--adapter', adapter],
    stderr: 'pipe',
    env: { ...process.env, HECATON_EFFECT_FILE: path.join(setup.directory, 'effects.txt') },
  });
  const client = new Client({ name: 'hecaton-test', version: '1' });
  const errors = [];
  transport.stderr?.on('data', (chunk) => errors.push(chunk.toString()));
  setup.cleanup.push(() => client.close());
  await client.connect(transport);
  return { client, transport, errors };
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
  assert.equal(Buffer.byteLength(result.content[0].text) <= 60000, true);
  return { ...result, value: JSON.parse(result.content[0].text) };
}

test('real MCP entry returns durable small receipts and reconstructs a large Unicode result by hash-checked chunks', async (t) => {
  const setup = fixture(t);
  const { client } = await connect(t, setup);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 16);
  const result = await call(client, 'hecaton_call', {
    requestId: 'large',
    tool: 'large',
    arguments: { text: 'hello' },
  });
  assert.equal(result.isError, false);
  assert.equal(result.value.success, true);
  assert.equal(result.value.outputTruncated, true);
  assert.equal(Array.from(result.value.output).length, 1000);
  let text = '',
    offset = 0,
    hash;
  for (;;) {
    const page = (
      await call(client, 'hecaton_read', { resource: 'call', id: 'large', offset, limit: 4096 })
    ).value;
    if (hash) assert.equal(page.sha256, hash);
    hash = page.sha256;
    text += page.text;
    offset += Array.from(page.text).length;
    if (!page.hasMore) break;
  }
  assert.equal(createHash('sha256').update(text).digest('hex'), hash);
  assert.equal(JSON.parse(text).call.result.output, '가😀'.repeat(14000));
  const failure = await call(client, 'hecaton_call', {
    requestId: 'failed',
    tool: 'failure',
    arguments: { text: 'known failure' },
  });
  assert.equal(failure.isError, true);
  assert.equal(failure.value.state, 'completed');
});

test('real MCP management imports and executes a child capability, then EOF shuts down both owned processes', async (t) => {
  const setup = fixture(t);
  const { client, transport, errors } = await connect(t, setup);
  const discovery = await call(client, 'hecaton_discover', { serverId: 'fixture' });
  assert.equal(discovery.isError, false);
  assert.equal(discovery.value.tools.length, 2);
  const imported = await call(client, 'hecaton_import', { serverId: 'fixture', names: ['echo'] });
  assert.equal(imported.value.registrationVerified, true);
  assert.equal(imported.value.executionVerified, false);
  const name = imported.value.installed[0].name;
  const executed = await call(client, 'hecaton_call', {
    requestId: 'remote',
    tool: name,
    arguments: { text: 'remote hello' },
  });
  assert.equal(executed.value.success, true);
  assert.equal(executed.value.output, 'remote hello');
  const remotePid = (await call(client, 'hecaton_servers')).value[0].processId;
  const parentPid = transport.pid;
  await client.close();
  for (const pid of [remotePid, parentPid])
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error.code === 'ESRCH',
    );
  assert.equal(errors.join(''), '');
  const restarted = await connect(t, setup);
  const replayed = await call(restarted.client, 'hecaton_call', {
    requestId: 'remote',
    tool: name,
    arguments: { text: 'remote hello' },
  });
  assert.equal(replayed.value.cached, true);
  assert.equal((await call(restarted.client, 'hecaton_servers')).value[0].connected, false);
});

test('MCP cancellation and EOF preserve interrupted callback uncertainty before the process exits', async (t) => {
  for (const mode of ['cancel', 'eof']) {
    const setup = fixture(t);
    const { client } = await connect(t, setup);
    const controller = new AbortController();
    const pending = client
      .callTool(
        {
          name: 'hecaton_call',
          arguments: {
            requestId: mode,
            tool: 'wait',
            arguments: { text: 'waiting' },
          },
        },
        undefined,
        { signal: controller.signal, timeout: 15000 },
      )
      .catch((error) => error);
    const marker = path.join(setup.directory, 'effects.txt');
    for (let attempt = 0; attempt < 100 && !fs.existsSync(marker); attempt++) await delay(20);
    assert.equal(fs.existsSync(marker), true);
    if (mode === 'cancel') {
      controller.abort();
      let status;
      for (let attempt = 0; attempt < 100; attempt++) {
        status = (await call(client, 'hecaton_status', { requestId: mode })).value;
        if (status.needsReconciliation) break;
        await delay(20);
      }
      assert.equal(status.needsReconciliation, true);
    }
    await client.close();
    assert.ok((await pending) instanceof Error);
    assert.equal(
      inspectHecaton({ ...setup.options, view: 'status', requestId: mode }).status
        .needsReconciliation,
      true,
    );
  }
});

test(
  'CLI SIGTERM cancels an active callback and leaves inspectable uncertainty',
  {
    skip:
      process.platform === 'win32'
        ? 'Windows process.kill forcibly terminates without a catchable SIGTERM'
        : false,
  },
  async (t) => {
    const setup = fixture(t),
      effect = path.join(setup.directory, 'entered.txt');
    const child = spawn(
      process.execPath,
      [cli, 'call', ...scope(setup), ...executeArgs('interrupted', 'wait')],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, HECATON_EFFECT_FILE: effect },
      },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    const exited = once(child, 'exit');
    for (let attempt = 0; attempt < 100 && !fs.existsSync(effect); attempt++) await delay(50);
    assert.equal(fs.existsSync(effect), true);
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 1);
    assert.equal(
      inspectHecaton({ ...setup.options, view: 'status', requestId: 'interrupted' }).status
        .needsReconciliation,
      true,
    );
  },
);
