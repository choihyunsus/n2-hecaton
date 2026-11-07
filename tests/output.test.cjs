// Real subprocess pipes verify that stalled consumers leave the host able to close its owned work.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { fixture } = require('./helpers.cjs');
const entry = path.resolve(__dirname, '../dist/index.js');
function start(t, command, count, descriptionLength) {
  const setup = fixture(t),
    adapter = path.join(setup.directory, 'adapter.cjs');
  fs.writeFileSync(
    adapter,
    `module.exports={tools:Array.from({length:${count}},(_,i)=>({name:'tool_'+i,version:'1',description:'x'.repeat(${descriptionLength}),readOnly:true,inputSchema:{type:'object'},execute:()=>({success:true,output:'read'})}))};`,
  );
  const child = spawn(
    process.execPath,
    [
      entry,
      command,
      '--db',
      setup.options.dbPath,
      '--project',
      setup.options.project,
      '--agent',
      setup.options.agent,
      '--adapter',
      adapter,
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data.toString();
  });
  child.stdin.on('error', () => {});
  setup.cleanup.push(() => {
    if (child.exitCode === null) child.kill();
    child.stdin.destroy();
    child.stdout.destroy();
  });
  return { child, stderr: () => stderr };
}
async function exits(setup) {
  let forced = false;
  const timer = setTimeout(() => {
    forced = true;
    setup.child.kill();
  }, 12000);
  try {
    const [code, signal] = await once(setup.child, 'exit');
    assert.equal(forced, false, setup.stderr());
    assert.ok(code === 1 || signal === 'SIGKILL');
    assert.match(setup.stderr(), /Output consumer|stdio|output timed out/);
  } finally {
    clearTimeout(timer);
  }
}
test('CLI finishes owned shutdown after a large tool catalog stalls its output pipe', async (t) => {
  const setup = start(t, 'list', 256, 4096);
  setup.child.stdout.pause();
  await exits(setup);
});
test('MCP output timeouts remain effective when a real client pauses its reply stream', async (t) => {
  const setup = start(t, 'mcp', 100, 160),
    child = setup.child;
  const handshake = new Promise((resolve, reject) => {
    let input = '';
    const receive = (data) => {
      input += data.toString();
      if (!input.includes('\n')) return;
      child.stdout.removeListener('data', receive);
      child.stdout.pause();
      try {
        resolve(JSON.parse(input.split('\n')[0]));
      } catch (error) {
        reject(error);
      }
    };
    child.stdout.on('data', receive);
    child.once('error', reject);
  });
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'paused-reader', version: '1' },
      },
    }) + '\n',
  );
  assert.ok((await handshake).result.protocolVersion);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  for (let id = 2; id < 42; id++)
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'hecaton_list', arguments: { limit: 100 } },
      }) + '\n',
    );
  await exits(setup);
});
