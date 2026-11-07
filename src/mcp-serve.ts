// Closing the host protocol also cancels execution and shuts down its configured MCP children.
import type { Hecaton } from './hecaton';
import { createMcpServer } from './mcp';
import { ServerStdioTransport } from './mcp-server-transport';
import { reportFailure } from './index';

export async function serve(engine: Hecaton): Promise<void> {
  const server = createMcpServer(engine);
  const stop = (): void => {
    void server.close().catch(reportFailure);
  };
  const removeListeners = (): void => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  };
  const stopped = new Promise<void>((resolve) => {
    server.server.onclose = () => {
      removeListeners();
      void engine.close().catch(reportFailure).finally(resolve);
    };
  });
  server.server.onerror = reportFailure;
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await server.connect(new ServerStdioTransport());
    await stopped;
  } finally {
    removeListeners();
    try {
      await server.close();
    } finally {
      await engine.close();
    }
  }
}
