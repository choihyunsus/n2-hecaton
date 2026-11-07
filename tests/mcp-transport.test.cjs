// Check real process and HTTP transport boundaries before capability discovery and import.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { servers } = require('../dist/mcp-config');
const { StrictStdioTransport } = require('../dist/mcp-stdio');
const { guardedFetch } = require('../dist/mcp-http');
const { ProtocolBudget } = require('../dist/mcp-budget');

function config(mode) {
  return servers([
    {
      id: 'fixture',
      version: '1',
      transport: 'stdio',
      command: process.execPath,
      args: [path.join(__dirname, 'mcp-stdio-fixture.cjs'), mode],
    },
  ]).get('fixture');
}
async function server(t, callback) {
  const instance = http.createServer((request, response) => {
    response.on('error', () => {});
    callback(request, response);
  });
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise((resolve) => instance.close(resolve));
  });
  return `http://127.0.0.1:${instance.address().port}/mcp`;
}

test('strict stdio speaks real MCP, preserves Unicode, retains server state and closes its process', async () => {
  const transport = new StrictStdioTransport(config('normal'));
  const client = new Client({ name: 'fixture-client', version: '1' });
  let pid;
  try {
    await client.connect(transport, { timeout: 3000 });
    pid = transport.pid;
    assert.ok(pid > 0);
    assert.equal((await client.listTools()).tools[0].name, 'echo');
    const first = await client.callTool({ name: 'echo', arguments: { text: '한글😀' } });
    const second = await client.callTool({ name: 'echo', arguments: { text: 'again' } });
    assert.equal(first.content[0].text, '한글😀');
    assert.equal(first.structuredContent.count, 1);
    assert.equal(second.structuredContent.count, 2);
  } finally {
    await client.close();
    await transport.close();
  }
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error.code === 'ESRCH',
  );
});

test('malformed UTF-8 and oversized stdio frames reject initialization and terminate the owned process', async () => {
  for (const mode of ['invalid-utf8', 'oversized']) {
    const transport = new StrictStdioTransport(config(mode));
    const client = new Client({ name: 'fixture-client', version: '1' });
    const connecting = client.connect(transport, { timeout: 3000 });
    const pid = transport.pid;
    await assert.rejects(connecting);
    await client.close();
    await transport.close();
    assert.ok(pid > 0);
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error.code === 'ESRCH',
    );
  }
});

test('valid multi-byte UTF-8 split across stdio chunks is preserved exactly', async () => {
  const transport = new StrictStdioTransport(config('split-unicode'));
  const client = new Client({ name: 'fixture-client', version: '1' });
  try {
    await client.connect(transport, { timeout: 3000 });
    assert.equal(client.getServerVersion().name, '한글');
  } finally {
    await client.close();
    await transport.close();
  }
});

test('operator configuration snapshots credentials and rejects redirects, unsafe URLs and managed headers', () => {
  const input = {
    id: 'fixture',
    version: '1',
    transport: 'http',
    url: 'https://example.com/mcp',
    headers: { authorization: 'Bearer fixture' },
  };
  const selected = servers([input]).get('fixture');
  input.headers.authorization = 'changed';
  assert.equal(selected.headers.authorization, 'Bearer fixture');
  for (const url of [
    'http://example.com/mcp',
    'https://user:pass@example.com/mcp',
    'https://example.com/mcp#fragment',
  ])
    assert.throws(() => servers([{ ...input, url }]));
  for (const headers of [
    { Host: 'elsewhere' },
    { authorization: 'a\r\nb' },
    { 'Mcp-Session-Id': 'override' },
  ])
    assert.throws(() => servers([{ ...input, headers }]));
  assert.throws(() => servers([input, { ...input, id: 'FIXTURE' }]), /collide/);
  const env = JSON.parse('{"__proto__":"literal"}');
  assert.equal(
    servers([
      { id: 'stdio', version: '1', transport: 'stdio', command: process.execPath, env },
    ]).get('stdio').env[process.platform === 'win32' ? '__PROTO__' : '__proto__'],
    'literal',
  );
});

test('HTTP redirects and requests outside the configured endpoint are rejected before following', async (t) => {
  let other = 0;
  const endpoint = await server(t, (request, response) => {
    if (request.url === '/other') other++;
    response.writeHead(302, { location: '/other' });
    response.end();
  });
  const fetch = guardedFetch(endpoint, () => undefined);
  await assert.rejects(fetch(endpoint, { method: 'POST', body: '{}' }), /redirect/);
  await assert.rejects(fetch(endpoint.replace('/mcp', '/other')), /configured endpoint/);
  assert.equal(other, 0);
});

test('HTTP response streams reject damaged UTF-8 and oversized JSON before consumers accept it', async (t) => {
  let mode = 'unicode';
  const endpoint = await server(t, (_request, response) => {
    response.setHeader('content-type', 'application/json');
    if (mode === 'invalid') response.end(Buffer.from([123, 34, 120, 34, 58, 34, 0xff, 34, 125]));
    else if (mode === 'large') response.end(JSON.stringify({ value: 'x'.repeat(1024 * 1024) }));
    else {
      const bytes = Buffer.from(JSON.stringify({ value: '한글😀' }));
      response.write(bytes.subarray(0, 12));
      setImmediate(() => response.end(bytes.subarray(12)));
    }
  });
  assert.equal(
    (await (await guardedFetch(endpoint, () => undefined)(endpoint)).json()).value,
    '한글😀',
  );
  mode = 'invalid';
  await assert.rejects((await guardedFetch(endpoint, () => undefined)(endpoint)).text());
  mode = 'large';
  await assert.rejects(
    (await guardedFetch(endpoint, () => undefined)(endpoint)).text(),
    /byte limit/,
  );
});

test('SSE limits apply to complete events including multi-line data while separate events can continue', async (t) => {
  let largeEvent = true;
  const endpoint = await server(t, (_request, response) => {
    response.setHeader('content-type', 'text/event-stream');
    const line = 'data: ' + 'x'.repeat(6000) + '\n';
    response.end(largeEvent ? line.repeat(200) + '\n' : (line.repeat(100) + '\n').repeat(2));
  });
  await assert.rejects(
    (await guardedFetch(endpoint, () => undefined)(endpoint)).text(),
    /SSE event/,
  );
  largeEvent = false;
  assert.ok(
    (await (await guardedFetch(endpoint, () => undefined)(endpoint)).text()).length > 1024 * 1024,
  );
});

test('traffic budgets bound message floods and POST cancellation interrupts a stalled response', async (t) => {
  const budget = new ProtocolBudget();
  budget.accept(0, 256);
  assert.throws(() => budget.accept(0, 1), /traffic budget/);
  const endpoint = await server(t, () => {});
  const abort = new AbortController();
  const pending = guardedFetch(endpoint, () => abort.signal)(endpoint, {
    method: 'POST',
    body: '{}',
  });
  abort.abort();
  await assert.rejects(pending);
});
