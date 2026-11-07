// Serve paginated catalogs and controlled metadata or output changes over the real SDK protocol.
const fs = require('node:fs');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const mode = process.argv[2] ?? 'paged',
  filename = process.argv[3];
const state = () => (filename ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {});
const descriptor = (name) => ({
  name,
  description: 'Fixture text ' + (state().description ?? ''),
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
  annotations: { readOnlyHint: true, idempotentHint: true },
  ...(mode === 'task-required' ? { execution: { taskSupport: 'required' } } : {}),
});
const server = new Server(
  { name: 'catalog-fixture', version: '1' },
  { capabilities: { tools: {} } },
);
let count = 0;
server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  const cursor = request.params?.cursor;
  if (mode === 'pages') return { tools: [], nextCursor: String(Number(cursor ?? 0) + 1) };
  if (mode === 'mutable' || mode === 'task-required') return { tools: [descriptor('echo')] };
  if (cursor === undefined) return { tools: [descriptor('echo')], nextCursor: 'second' };
  if (mode === 'loop') return { tools: [], nextCursor: 'second' };
  return { tools: [descriptor(mode === 'duplicate' ? 'echo' : 'echo_two')] };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  count++;
  const options = state();
  if (options.effectFile) fs.appendFileSync(options.effectFile, 'effect\n');
  return {
    content: [{ type: 'text', text: request.params.arguments.text }],
    structuredContent: {
      text: request.params.arguments.text,
      count: options.invalidOutput ? 'invalid' : count,
    },
  };
});
server.connect(new StdioServerTransport()).catch(() => {
  process.exitCode = 1;
});
