// Exit after an actual external effect while the engine's durable invocation remains pending.
const { Hecaton } = require('..');
const { crashTool } = require('./crash-tool.cjs');
const [dbPath, directory] = process.argv.slice(2);
const engine = new Hecaton({
  dbPath,
  project: 'fixture',
  agent: 'worker',
  tools: [crashTool(directory, true)],
});
engine
  .execute({
    requestId: 'crashed',
    sessionId: 'crash-session',
    tool: 'write',
    arguments: { text: 'one' },
  })
  .then(
    () => process.exit(0),
    () => process.exit(1),
  );
