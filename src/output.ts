// Await bounded stdout writes and settle owned work before ending a process retained by a native write.
import { BoundedOutput } from './output-stdio';
export const outputStream = new BoundedOutput();
export function writeText(text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    outputStream.write(text, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
export function print(value: unknown): Promise<void> {
  return writeText(JSON.stringify(value) + '\n');
}
export async function finishOutput(): Promise<void> {
  if (!(await outputStream.settle())) return;
  // Native pipe writes can retain an OS worker during normal exit. Main has already closed its work.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 250);
    process.stderr.write('', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  process.kill(process.pid, 'SIGKILL');
}
