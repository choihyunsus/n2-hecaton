// Fixed test capabilities exercise process entry points without opening arbitrary model-selected files.
const fs = require('node:fs');
const path = require('node:path');
const schema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};
module.exports = {
  dbPath: 'ignored.db',
  project: 'ignored-project',
  agent: 'ignored-agent',
  tools: ['echo', 'write', 'unknown', 'large', 'failure', 'wait'].map((name) => ({
    name,
    version: '1',
    description: 'Fixture ' + name,
    inputSchema: schema,
    readOnly: name === 'echo' || name === 'large',
    execute(args, context) {
      if (name === 'write' || name === 'unknown')
        fs.appendFileSync(process.env.HECATON_EFFECT_FILE, args.text + '\n');
      if (name === 'unknown') throw new Error('fixture-private-token');
      if (name === 'wait') {
        fs.writeFileSync(process.env.HECATON_EFFECT_FILE, 'entered');
        return new Promise((resolve, reject) =>
          context.signal.addEventListener('abort', () => reject(new Error('interrupted')), {
            once: true,
          }),
        );
      }
      return {
        success: name !== 'failure',
        output: name === 'large' ? '가😀'.repeat(14000) : args.text,
      };
    },
  })),
  mcpServers: [
    {
      id: 'fixture',
      version: '1',
      transport: 'stdio',
      command: process.execPath,
      args: [path.join(__dirname, 'mcp-catalog-fixture.cjs'), 'paged'],
    },
  ],
};
