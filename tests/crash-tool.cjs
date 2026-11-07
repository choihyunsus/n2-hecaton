// Share identical metadata across the crashed worker and its recovery host.
const fs = require('node:fs');
const path = require('node:path');
function crashTool(directory, exitAfterEffect) {
  return {
    name: 'write',
    version: '1',
    description: 'Append one fixture line',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    execute(args) {
      fs.appendFileSync(path.join(directory, 'effect.txt'), args.text + '\n');
      if (exitAfterEffect) process.exit(37);
      return { success: true, output: 'written', modifiedFiles: ['effect.txt'] };
    },
  };
}
module.exports = { crashTool };
