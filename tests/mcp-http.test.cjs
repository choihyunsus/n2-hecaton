// Exercise HTTP import, authenticated calls, lost acknowledgements and safe response resumption.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./helpers.cjs');
const { httpFixture } = require('./mcp-http-fixture.cjs');
const { ReconciliationRequired } = require('../dist/library');
const request = (requestId) => ({ requestId, tool: 'fixture_write', arguments: { text: 'one' } });
function options(url, extra = {}) {
  return {
    tools: [],
    mcpServers: [{ id: 'fixture', version: '1', transport: 'http', url, ...extra }],
  };
}

test('real SDK HTTP sessions preserve configured credentials, execute once and terminate on close', async (t) => {
  const setup = fixture(t),
    remote = await httpFixture(t, { authorization: 'Bearer fixture-private-token' });
  const engine = setup.engine(
    options(remote.url, { headers: { authorization: remote.state.authorization } }),
  );
  const imported = await engine.importMcp({ serverId: 'fixture', names: ['write'] });
  assert.equal(imported.registrationVerified, true);
  const response = await engine.execute(request('http'));
  assert.equal(response.result.data.mcp.structuredContent.count, 1);
  assert.equal((await engine.execute(request('http'))).cached, true);
  assert.equal(remote.state.postedTools, 1);
  assert.doesNotMatch(JSON.stringify(engine.definitions()), /fixture-private-token/);
  assert.doesNotMatch(JSON.stringify(engine.status('http')), /fixture-private-token/);
  await engine.close();
  assert.equal(remote.state.deletions, 1);
  assert.ok(remote.state.authorizations.every((header) => header === remote.state.authorization));
});

test('HTTP 401 and 403 tool responses trigger no automatic credential refresh or POST replay', async (t) => {
  const setup = fixture(t),
    remote = await httpFixture(t);
  for (const mode of ['unauthorized', 'forbidden']) {
    remote.state.mode = 'normal';
    const engine = setup.engine({ ...options(remote.url), agent: mode });
    await engine.importMcp({ serverId: 'fixture', names: ['write'] });
    remote.state.mode = mode;
    const before = remote.state.postedTools;
    await assert.rejects(engine.execute(request(mode)), ReconciliationRequired);
    assert.equal(remote.state.postedTools - before, 1);
    assert.equal(engine.status(mode).needsReconciliation, true);
    assert.doesNotMatch(JSON.stringify(engine.status(mode)), /fixture-private-token/);
    await engine.close();
  }
});

test('a dropped HTTP acknowledgement after a real file effect requires inspection and never duplicates the POST', async (t) => {
  const setup = fixture(t),
    effectFile = path.join(setup.directory, 'http-effect.txt');
  const remote = await httpFixture(t, { effectFile }),
    engine = setup.engine(options(remote.url));
  await engine.importMcp({ serverId: 'fixture', names: ['write'] });
  remote.state.mode = 'drop';
  await assert.rejects(engine.execute(request('lost-ack')), ReconciliationRequired);
  await assert.rejects(engine.execute(request('lost-ack')), ReconciliationRequired);
  assert.equal(remote.state.postedTools, 1);
  assert.equal(fs.readFileSync(effectFile, 'utf8'), 'one\n');
  engine.reconcile(
    'lost-ack',
    { success: true, output: 'Observed one remote file line' },
    'Read the HTTP server output file after the connection closed',
  );
  assert.equal((await engine.execute(request('lost-ack'))).cached, true);
  assert.equal(remote.state.postedTools, 1);
  await engine.close();
});

test('SSE response resumption uses GET and preserves a single mutating tool POST', async (t) => {
  const setup = fixture(t),
    effectFile = path.join(setup.directory, 'resumed-effect.txt');
  const remote = await httpFixture(t, { effectFile });
  const engine = setup.engine(
    options(remote.url, { toolPermissions: { write: { timeoutMs: 5000 } } }),
  );
  await engine.importMcp({ serverId: 'fixture', names: ['write'] });
  remote.state.mode = 'resume';
  const response = await engine.execute(request('resume'));
  assert.equal(response.result.success, true);
  assert.equal(remote.state.postedTools, 1);
  assert.equal(remote.state.resumedGets, 1);
  assert.equal(fs.readFileSync(effectFile, 'utf8'), 'one\n');
  await engine.close();
});

test('preparation failures are confirmed failures before any remote tool invocation', async (t) => {
  const setup = fixture(t),
    remote = await httpFixture(t),
    engine = setup.engine(options(remote.url));
  await engine.importMcp({ serverId: 'fixture', names: ['write'] });
  remote.state.mode = 'prepare-fail';
  const result = await engine.execute(request('not-invoked'));
  assert.equal(result.result.success, false);
  assert.match(result.result.output, /before tool invocation/);
  assert.equal(engine.status('not-invoked').needsReconciliation, false);
  assert.equal(remote.state.postedTools, 0);
  remote.state.mode = 'normal';
  assert.equal((await engine.execute(request('retry-new-request'))).result.success, true);
  await engine.close();
});
