// Bound protocol frames and sustained traffic before parsing untrusted server messages.
export const MAX_MCP_FRAME = 1024 * 1024;
export class ProtocolBudget {
  private started = performance.now();
  private bytes = 0;
  private messages = 0;
  accept(bytes: number, messages = 0): void {
    if (performance.now() - this.started >= 1000) {
      this.started = performance.now();
      this.bytes = 0;
      this.messages = 0;
    }
    this.bytes += bytes;
    this.messages += messages;
    if (this.bytes > 4 * MAX_MCP_FRAME || this.messages > 256)
      throw new Error('MCP server exceeded its protocol traffic budget');
  }
}
