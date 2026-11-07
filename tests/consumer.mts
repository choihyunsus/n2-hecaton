import {
  Hecaton,
  inspectHecaton,
  type McpImportOptions,
  type CallStatus,
} from '../dist/library.js';
const engine = new Hecaton({ dbPath: './soul.db', project: 'demo', agent: 'worker', tools: [] });
const options: McpImportOptions = { serverId: 'demo', names: ['echo'] };
const status: CallStatus | undefined = engine.status('one');
void [Hecaton, inspectHecaton, options, status, engine.close()];
