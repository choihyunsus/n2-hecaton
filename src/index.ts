#!/usr/bin/env node
// Read-only inspection stays independent of host startup, and active commands drain before exit.
import { Hecaton } from './hecaton';
import { inspectHecaton, type InspectionOptions } from './inspect';
import { executeCli } from './cli-execute';
import { parseCli, engineOptions, scopeOptions, numberOption, HELP } from './cli-options';
import { ReconciliationRequired } from './call-types';
import { print, writeText, finishOutput } from './output';

export async function main(args: string[]): Promise<void> {
  const { command, values } = parseCli(args);
  if (command === 'help' || command === 'version') {
    await writeText(command === 'help' ? HELP : '1.0.1\n');
    return;
  }
  if (['status', 'history', 'definitions'].includes(command)) {
    await print(
      inspectHecaton({
        ...scopeOptions(values),
        view: command as InspectionOptions['view'],
        requestId: values.get('request-id'),
        limit: numberOption(values, 'limit', 50),
        offset: numberOption(values, 'offset', 0),
      }),
    );
    return;
  }
  const engine = new Hecaton(await engineOptions(values));
  if (command === 'mcp') {
    const { serve } = await import('./mcp-serve.js');
    await serve(engine);
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('CLI execution interrupted'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await executeCli(engine, command, values, controller.signal);
    await print(result);
    const receipt = result as {
      result?: { success: boolean };
      execution?: { result: { success: boolean } };
    };
    if (receipt?.result?.success === false || receipt?.execution?.result.success === false)
      process.exitCode = 2;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await engine.close();
  }
}
export function reportFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Hecaton operation failed';
  process.stderr.write(
    JSON.stringify({
      error: Array.from(message).slice(0, 1000).join(''),
      requestId: error instanceof ReconciliationRequired ? error.requestId : undefined,
      needsReconciliation: error instanceof ReconciliationRequired,
    }) + '\n',
  );
  process.exitCode = 1;
}
if (require.main === module) {
  // Write callbacks and the bounded MCP transport own stream failures and cancellation.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  void main(process.argv.slice(2)).catch(reportFailure).finally(finishOutput);
}
