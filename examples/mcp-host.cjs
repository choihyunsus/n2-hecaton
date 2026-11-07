// The operator supplies an absolute server path and grants capabilities for selected remote tools.
const path = require('node:path');
const filename = process.env.HECATON_MCP_SERVER;
if (!filename || !path.isAbsolute(filename))
  throw new Error('Set HECATON_MCP_SERVER to an absolute local server path');
module.exports = {
  tools: [],
  mcpServers: [
    {
      id: 'local',
      version: '1',
      transport: 'stdio',
      command: process.execPath,
      args: [filename],
      toolPermissions: { echo: { readOnly: true, timeoutMs: 10000 } },
    },
  ],
};
