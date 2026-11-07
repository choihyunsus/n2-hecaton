// Keep every test database and cleanup operation inside a newly owned temporary directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HecatonStore } = require('../dist/store');
const { Hecaton } = require('../dist/library');

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'n2-hecaton-test-'));
  const options = {
    dbPath: path.join(directory, 'soul.db'),
    project: 'fixture',
    agent: 'worker',
    ...overrides,
  };
  const stores = [];
  const engines = [];
  const cleanup = [];
  const open = (extra = {}) => {
    const store = new HecatonStore({ ...options, ...extra });
    stores.push(store);
    return store;
  };
  const engine = (extra) => {
    const instance = new Hecaton({ ...options, ...extra });
    engines.push(instance);
    return instance;
  };
  t.after(async () => {
    for (const close of cleanup) await close();
    for (const instance of engines) await instance.close();
    for (const store of stores) store.close();
    const owned = fs.realpathSync.native(directory);
    if (
      path.dirname(owned) !== fs.realpathSync.native(os.tmpdir()) ||
      !path.basename(owned).startsWith('n2-hecaton-test-')
    )
      throw new Error('Test directory ownership changed');
    fs.rmSync(owned, { recursive: true, force: true });
  });
  return { directory, options, open, engine, cleanup };
}
module.exports = { fixture };
