// Provide real SDK tools or intentionally damaged protocol frames for transport regressions.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { LATEST_PROTOCOL_VERSION } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');
const mode = process.argv[2] ?? 'normal';

if (mode === 'invalid-utf8' || mode === 'oversized' || mode === 'split-unicode') {
  process.stdin.once('data', (chunk) => {
    const request = JSON.parse(chunk.toString('utf8').trim());
    if (mode === 'oversized') {
      process.stdout.write(Buffer.alloc(1024 * 1024 + 1, 97));
      return;
    }
    const encoded = Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          serverInfo: { name: '한글', version: '1' },
        },
      }) + '\n',
    );
    const position = encoded.indexOf(Buffer.from('한글'));
    if (mode === 'invalid-utf8')
      process.stdout.write(
        Buffer.concat([
          encoded.subarray(0, position),
          Buffer.from([0xff]),
          encoded.subarray(position + Buffer.byteLength('한글')),
        ]),
      );
    else {
      process.stdout.write(encoded.subarray(0, position + 1));
      setTimeout(() => process.stdout.write(encoded.subarray(position + 1)), 5);
    }
  });
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
} else {
  let count = 0;
  const server = new McpServer({ name: 'fixture', version: '1' });
  server.registerTool(
    'echo',
    {
      description: 'Return fixture text',
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true, idempotentHint: true },
      outputSchema: { text: z.string(), count: z.number() },
    },
    async ({ text }) => ({
      content: [{ type: 'text', text }],
      structuredContent: { text, count: ++count },
    }),
  );
  if (mode === 'unsupported-schema')
    server.registerTool(
      'unsupported',
      {
        description: 'Requires a pattern outside the supported schema subset',
        inputSchema: { value: z.string().regex(/(?=x)/) },
      },
      async () => ({ content: [{ type: 'text', text: 'unexpected invocation' }] }),
    );
  server.connect(new StdioServerTransport()).catch(() => {
    process.exitCode = 1;
  });
}
