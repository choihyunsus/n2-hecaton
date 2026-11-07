// Preserve small mutation receipts and expose full JSON through code-point-indexed, hashable chunks.
import type { ExecutionReceipt } from './call-types';
import { ReconciliationRequired } from './call-types';
import { digest } from './store';
import { integer } from './values';
const PREVIEW_CHARACTERS = 1000;

export function chunk(value: unknown, offset: number, limit: number) {
  integer(offset, 'character offset', 0, 1048576);
  integer(limit, 'character limit', 1, 4096);
  const json = JSON.stringify(value ?? null);
  const characters = Array.from(json);
  return {
    encoding: 'json',
    sha256: digest(json),
    text: characters.slice(offset, offset + limit).join(''),
    offset,
    totalCharacters: characters.length,
    hasMore: offset + limit < characters.length,
  };
}
export function receiptPreview(receipt: ExecutionReceipt) {
  const { result, ...metadata } = receipt;
  const characters = Array.from(result.output);
  return {
    ...metadata,
    success: result.success,
    output: characters.slice(0, PREVIEW_CHARACTERS).join(''),
    outputTruncated: characters.length > PREVIEW_CHARACTERS,
    fullRecord: { tool: 'hecaton_read', resource: 'call', id: receipt.requestId },
  };
}
export async function respond(operation: () => unknown | Promise<unknown>) {
  try {
    const value = (await operation()) ?? null;
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 60000)
      throw new Error('Read response exceeds 60,000 bytes; use smaller pages or hecaton_read');
    return {
      isError:
        !!value && typeof value === 'object' && 'success' in value && value.success === false,
      content: [{ type: 'text' as const, text }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Hecaton operation failed';
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: Array.from(message).slice(0, PREVIEW_CHARACTERS).join(''),
            requestId: error instanceof ReconciliationRequired ? error.requestId : undefined,
            needsReconciliation: error instanceof ReconciliationRequired,
          }),
        },
      ],
    };
  }
}
