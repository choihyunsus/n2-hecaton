// Host real SDK HTTP sessions with controlled acknowledgement loss and GET-only resumption cases.
const fs = require('node:fs');
const http = require('node:http');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const {
  StreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

async function httpFixture(t, options = {}) {
  const state = {
    mode: 'normal',
    calls: 0,
    postedTools: 0,
    resumedGets: 0,
    deletions: 0,
    initializations: 0,
    version: '1',
    description: 'HTTP fixture',
    methods: [],
    authorizations: [],
    ...options,
  };
  const sessions = new Map();
  const instance = http.createServer((request, response) => {
    response.on('error', () => {});
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  async function handle(request, response) {
    state.authorizations.push(request.headers.authorization ?? null);
    if (state.authorization && request.headers.authorization !== state.authorization) {
      response.writeHead(401);
      response.end('Authentication required');
      return;
    }
    if (state.mode === 'redirect') {
      response.writeHead(307, { location: '/elsewhere' });
      response.end();
      return;
    }
    const sessionId = request.headers['mcp-session-id'];
    if (request.method === 'GET') {
      if (
        sessions.has(sessionId) &&
        request.headers['last-event-id'] === 'resume-event' &&
        state.resumption
      ) {
        state.resumedGets++;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: ' + JSON.stringify(state.resumption) + '\n\n');
      } else {
        response.writeHead(405);
        response.end();
      }
      return;
    }
    if (request.method === 'DELETE') {
      state.deletions++;
      const session = sessions.get(sessionId);
      if (session) await session.transport.handleRequest(request, response);
      else {
        response.writeHead(404);
        response.end();
      }
      return;
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 1024 * 1024) {
        response.writeHead(413);
        response.end();
        return;
      }
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    state.methods.push(body.method);
    if (body.method === 'initialize') {
      state.initializations++;
      const server = new Server(
        { name: 'http-fixture', version: state.version },
        { capabilities: { tools: {} } },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (id) => sessions.set(id, { server, transport }),
      });
      server.onclose = () => sessions.delete(transport.sessionId);
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [descriptor()] }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => result(request));
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (body.method === 'tools/list' && state.mode === 'prepare-fail') {
      response.writeHead(503);
      response.end('Catalog unavailable');
      return;
    }
    if (body.method === 'tools/call') {
      state.postedTools++;
      if (state.mode === 'unauthorized' || state.mode === 'forbidden') {
        response.writeHead(state.mode === 'unauthorized' ? 401 : 403, {
          'www-authenticate': 'Bearer error="insufficient_scope"',
        });
        response.end('fixture-private-token');
        return;
      }
      if (state.mode === 'drop') {
        result(body);
        request.socket.destroy();
        return;
      }
      if (state.mode === 'resume') {
        state.resumption = { jsonrpc: '2.0', id: body.id, result: result(body) };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('id: resume-event\nretry: 10\ndata:\n\n');
        return;
      }
    }
    await session.transport.handleRequest(request, response, body);
  }
  function descriptor() {
    return {
      name: 'write',
      description: state.description,
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, count: { type: 'number' } },
        required: ['text', 'count'],
        additionalProperties: false,
      },
    };
  }
  function result(request) {
    state.calls++;
    if (state.effectFile) fs.appendFileSync(state.effectFile, request.params.arguments.text + '\n');
    return {
      content: [{ type: 'text', text: request.params.arguments.text }],
      structuredContent: { text: request.params.arguments.text, count: state.calls },
    };
  }
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => {
    for (const session of sessions.values()) await session.server.close();
    instance.closeAllConnections();
    await new Promise((resolve) => instance.close(resolve));
  });
  return { state, url: `http://127.0.0.1:${instance.address().port}/mcp` };
}
module.exports = { httpFixture };
