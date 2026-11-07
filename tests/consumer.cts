import { Hecaton, inspectHecaton, type McpServer, type ToolDefinition } from '..';
const tools: ToolDefinition[] = [
  {
    name: 'echo',
    version: '1',
    description: 'Return input',
    readOnly: true,
    inputSchema: { type: 'object' },
    execute: (args, context) => ({
      success: !context.signal.aborted,
      output: JSON.stringify(args),
    }),
  },
];
const servers: McpServer[] = [
  { id: 'demo', version: '1', transport: 'stdio', command: 'node', args: ['server.cjs'] },
];
const engine = new Hecaton({
  dbPath: './soul.db',
  project: 'demo',
  agent: 'worker',
  tools,
  mcpServers: servers,
});
const receipts = engine.execute({ requestId: 'one', tool: 'echo', arguments: {} });
const adapters = engine.asGumihoTools(['echo']);
const inspection = inspectHecaton({
  dbPath: './soul.db',
  project: 'demo',
  agent: 'worker',
  view: 'status',
  requestId: 'one',
});
void [receipts, adapters, inspection, engine.close()];
