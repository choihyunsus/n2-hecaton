// Treat split Unicode, frame batching and malformed protocol shutdown as real transport boundaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { JsonRpcFrames } = require('../dist/mcp-frames');
const { ServerStdioTransport } = require('../dist/mcp-server-transport');
const { fixture } = require('./helpers.cjs');

test('batched valid frames have independent size limits and split UTF-8 remains exact', () => {
  const parser = new JsonRpcFrames(),
    received = [];
  const encoded = Buffer.from(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'fixture',
      params: { text: 'a'.repeat(600000) + '😀' },
    }) + '\n',
  );
  parser.accept(Buffer.concat([encoded, encoded]), (value) => received.push(value));
  assert.equal(received.length, 2);
  assert.equal(received[0].params.text, 'a'.repeat(600000) + '😀');
  const unicode = Buffer.from('{"jsonrpc":"2.0","method":"안녕😀"}\n');
  for (const byte of unicode) parser.accept(Buffer.from([byte]), (value) => received.push(value));
  assert.equal(received[2].method, '안녕😀');
  assert.throws(() => new JsonRpcFrames().accept(Buffer.alloc(1048577, 32), () => {}), /frame/);
  assert.throws(() => new JsonRpcFrames().accept(Buffer.from([0xc3, 0x28, 10]), () => {}));
});

test('server EOF, truncated frames and invalid messages close exactly once with listener cleanup', async () => {
  for (const payload of [Buffer.alloc(0), Buffer.from('{'), Buffer.from([0xc3, 0x28, 10])]) {
    const input = new PassThrough(),
      output = new PassThrough();
    const transport = new ServerStdioTransport(input, output);
    let errors = 0,
      closes = 0;
    transport.onerror = () => errors++;
    transport.onclose = () => closes++;
    await transport.start();
    const ended = once(input, 'end');
    input.end(payload);
    if (payload.length <= 1) await ended;
    else await new Promise((resolve) => setImmediate(resolve));
    await transport.close();
    assert.equal(closes, 1);
    assert.equal(errors, payload.length ? 1 : 0);
    assert.equal(input.listenerCount('data'), 0);
    assert.equal(output.listenerCount('error'), 0);
    await assert.rejects(transport.send({ jsonrpc: '2.0', method: 'fixture' }), /disconnected/);
    input.destroy();
    output.destroy();
  }
});

test('real CLI rejects malformed stdio, releases the database and exits with a bounded diagnostic', async (t) => {
  const setup = fixture(t);
  const child = spawn(
    process.execPath,
    [
      path.join(__dirname, '../dist/index.js'),
      'mcp',
      '--db',
      setup.options.dbPath,
      '--project',
      'fixture',
      '--agent',
      'worker',
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  setup.cleanup.push(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.on('error', () => {});
  const exited = once(child, 'exit');
  child.stdin.end(Buffer.from([0xc3, 0x28, 10]));
  const [code] = await exited;
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /bounded UTF-8/);
  assert.ok(stderr.length < 1000);
});
