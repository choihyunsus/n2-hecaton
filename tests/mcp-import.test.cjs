// Verify all import phases through real MCP sessions before executing registered capabilities.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./helpers.cjs');
const { ReconciliationRequired } = require('../dist/library');
function config(mode = 'normal', extra = {}) {
  return {
    id: 'fixture',
    version: '1',
    transport: 'stdio',
    command: process.execPath,
    args: [path.join(__dirname, 'mcp-stdio-fixture.cjs'), mode],
    ...extra,
  };
}
function catalog(mode, file) {
  return config(mode, {
    args: [path.join(__dirname, 'mcp-catalog-fixture.cjs'), mode, ...(file ? [file] : [])],
  });
}
function request(requestId, tool = 'fixture_echo', text = '한글😀') {
  return { requestId, tool, arguments: { text } };
}

test('discovery, analysis, source compilation and registration do not invoke the remote tool', async (t) => {
  const setup = fixture(t);
  const server = config('normal', { env: { MCP_FIXTURE_SECRET: 'fixture-private-token' } });
  const engine = setup.engine({ tools: [], mcpServers: [server] });
  assert.equal(engine.mcpServers()[0].connected, false);
  const analysis = await engine.discoverMcp('fixture');
  assert.equal(analysis.tools[0].supported, true, analysis.tools[0].reason);
  assert.equal(analysis.tools[0].remote.annotations.readOnlyHint, true);
  assert.equal(analysis.tools[0].readOnly, false);
  const installed = await engine.importMcp({ serverId: 'fixture', names: ['echo'] });
  assert.equal(installed.registrationVerified, true);
  assert.equal(installed.executionVerified, false);
  assert.equal(installed.installed[0].name, 'fixture_echo');
  assert.equal(
    (await engine.importMcp({ serverId: 'fixture', names: ['echo'] })).installed[0].revision,
    1,
  );
  const first = await engine.execute(request('first'));
  assert.equal(first.result.output, '한글😀');
  assert.equal(first.result.data.mcp.structuredContent.count, 1);
  assert.equal((await engine.execute(request('first'))).cached, true);
  assert.equal(
    (await engine.execute(request('second'))).result.data.mcp.structuredContent.count,
    2,
  );
  assert.doesNotMatch(JSON.stringify(engine.definitions()), /fixture-private-token/);
  assert.doesNotMatch(JSON.stringify(engine.mcpServers()), /fixture-private-token/);
  await engine.close();
  const restored = setup.engine({ tools: [], mcpServers: [server] });
  assert.equal(restored.list()[0].name, 'fixture_echo');
  assert.equal(restored.mcpServers()[0].connected, false);
  assert.equal((await restored.execute(request('first'))).cached, true);
  assert.equal(restored.mcpServers()[0].connected, false);
});

test('host-granted read-only proxies can be wrapped in durable N2R guards', async (t) => {
  const setup = fixture(t);
  const engine = setup.engine({
    tools: [],
    mcpServers: [config('normal', { toolPermissions: { echo: { readOnly: true } } })],
  });
  await engine.importMcp({ serverId: 'fixture', names: ['echo'] });
  engine.installSource(
    '@meta { name: "guarded" handler: "mcp:fixture|echo" enforce: strict read_only: true } @rule Guard { blacklist: [/blocked/] }',
  );
  assert.equal(engine.list().find((tool) => tool.name === 'fixture_echo').readOnly, true);
  assert.equal((await engine.execute(request('blocked', 'guarded', 'blocked'))).state, 'blocked');
  assert.equal(
    (await engine.execute(request('allowed', 'guarded', 'ok'))).result.data.mcp.structuredContent
      .count,
    1,
  );
});

test('unsupported schemas and task modes are reported and selected imports fail before saving any rows', async (t) => {
  const setup = fixture(t),
    engine = setup.engine({ tools: [], mcpServers: [config('unsupported-schema')] });
  const analysis = await engine.discoverMcp('fixture');
  assert.equal(analysis.tools.find((tool) => tool.remote.name === 'echo').supported, true);
  assert.equal(analysis.tools.find((tool) => tool.remote.name === 'unsupported').supported, false);
  await assert.rejects(engine.importMcp({ serverId: 'fixture', names: ['echo', 'unsupported'] }));
  assert.deepEqual(engine.definitions(), []);
  await engine.importMcp({ serverId: 'fixture', names: ['echo'] });
  assert.equal((await engine.execute(request('valid'))).result.success, true);
  const tasks = setup.engine({ agent: 'tasks', tools: [], mcpServers: [catalog('task-required')] });
  assert.equal((await tasks.discoverMcp('fixture')).tools[0].supported, false);
  await assert.rejects(tasks.importMcp({ serverId: 'fixture', names: ['echo'] }), /task-capable/);
  assert.deepEqual(tasks.definitions(), []);
});

test('paginated imports are atomic when the second selected definition fails to persist', async (t) => {
  const setup = fixture(t),
    engine = setup.engine({ tools: [], mcpServers: [catalog('paged')] });
  assert.equal((await engine.discoverMcp('fixture')).tools.length, 2);
  const store = setup.open();
  store.db.execute(
    "CREATE TRIGGER fail_import BEFORE INSERT ON hecaton_definitions WHEN NEW.name='fixture_echo_two' BEGIN SELECT RAISE(ABORT,'fixture import rollback'); END",
  );
  await assert.rejects(
    engine.importMcp({ serverId: 'fixture', names: ['echo', 'echo_two'] }),
    /fixture/,
  );
  assert.deepEqual(engine.definitions(), []);
  assert.deepEqual(engine.list(), []);
  store.db.execute('DROP TRIGGER fail_import');
  const imported = await engine.importMcp({ serverId: 'fixture', names: ['echo', 'echo_two'] });
  assert.equal(imported.installed.length, 2);
  assert.equal(
    (await engine.execute(request('second-tool', 'fixture_echo_two'))).result.data.mcp
      .structuredContent.count,
    1,
  );
});

test('repeated cursors, duplicate names and excessive page counts fail discovery without saving tools', async (t) => {
  const setup = fixture(t);
  for (const mode of ['loop', 'duplicate', 'pages']) {
    const engine = setup.engine({ agent: mode, tools: [], mcpServers: [catalog(mode)] });
    await assert.rejects(engine.discoverMcp('fixture'));
    assert.deepEqual(engine.definitions(), []);
    await engine.close();
  }
});

test('changed remote metadata blocks invocation until an explicit hash-checked reimport', async (t) => {
  const setup = fixture(t),
    stateFile = path.join(setup.directory, 'server-state.json');
  fs.writeFileSync(stateFile, '{}');
  const engine = setup.engine({ tools: [], mcpServers: [catalog('mutable', stateFile)] });
  const first = await engine.importMcp({ serverId: 'fixture', names: ['echo'] });
  assert.equal(
    (await engine.execute(request('before'))).result.data.mcp.structuredContent.count,
    1,
  );
  fs.writeFileSync(stateFile, JSON.stringify({ description: 'changed' }));
  const blocked = await engine.execute(request('changed'));
  assert.equal(blocked.result.success, false);
  assert.match(blocked.result.output, /metadata changed/);
  await assert.rejects(
    engine.importMcp({ serverId: 'fixture', names: ['echo'] }),
    /current content hash/,
  );
  const updated = await engine.importMcp({
    serverId: 'fixture',
    names: ['echo'],
    expectedHashes: { fixture_echo: first.installed[0].contentHash },
  });
  assert.equal(updated.installed[0].revision, 2);
  assert.equal(
    (await engine.execute(request('updated'))).result.data.mcp.structuredContent.count,
    2,
  );
});

test('invalid structured output after a real remote effect remains uncertain and is never replayed implicitly', async (t) => {
  const setup = fixture(t),
    stateFile = path.join(setup.directory, 'server-state.json'),
    effectFile = path.join(setup.directory, 'remote-effect.txt');
  fs.writeFileSync(stateFile, JSON.stringify({ invalidOutput: true, effectFile }));
  const engine = setup.engine({ tools: [], mcpServers: [catalog('mutable', stateFile)] });
  await engine.importMcp({ serverId: 'fixture', names: ['echo'] });
  await assert.rejects(engine.execute(request('invalid-output')), ReconciliationRequired);
  await assert.rejects(engine.execute(request('invalid-output')), ReconciliationRequired);
  assert.equal(engine.status('invalid-output').needsReconciliation, true);
  assert.equal(fs.readFileSync(effectFile, 'utf8'), 'effect\n');
  engine.reconcile(
    'invalid-output',
    { success: false, output: 'Observed one effect and invalid structured output' },
    'Inspected remote-effect.txt after transport shutdown',
  );
  assert.equal((await engine.execute(request('invalid-output'))).cached, true);
});
