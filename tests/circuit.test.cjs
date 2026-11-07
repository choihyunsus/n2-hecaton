// Check persisted breaker transitions, shared aliases and stale-completion fencing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers.cjs');
const { CallLease } = require('../dist/lease');
const { Circuit, CircuitOpen } = require('../dist/circuit');
const { hostEntry } = require('../dist/tool-entry');
const { compileTool } = require('../dist/n2r-tool');
const entry = () =>
  hostEntry({
    name: 'echo',
    version: '1',
    description: 'Fixture',
    readOnly: true,
    inputSchema: { type: 'object' },
    execute: () => ({ success: true, output: 'ok' }),
  });

function failThree(store, circuit, tool) {
  for (let index = 0; index < 3; index++) {
    const lease = new CallLease(store, `failure-${index}`, false);
    try {
      circuit.finish(lease, tool, circuit.reserve(lease, tool), 'failure');
    } finally {
      lease.release();
    }
  }
}
function cool(store) {
  store.db.execute('UPDATE hecaton_circuits SET opened_at=?', [Date.now() - 60001]);
}

test('three failures open a durable circuit shared by custom aliases', (t) => {
  const { open } = fixture(t),
    store = open(),
    tool = entry(),
    circuit = new Circuit(store);
  const alias = compileTool(
    '@meta { name: "alias" handler: "native:echo" enforce: strict read_only: true }',
    () => tool,
  );
  t.after(() => alias.dispose());
  failThree(store, circuit, tool);
  assert.equal(circuit.status(alias).state, 'open');
  const second = open(),
    shared = new Circuit(second),
    lease = new CallLease(second, 'blocked', false);
  try {
    assert.throws(() => shared.reserve(lease, alias), CircuitOpen);
  } finally {
    lease.release();
  }
  assert.equal(shared.status(tool).failures, 3);
});

test('only one half-open probe runs and cancellation releases its reservation', (t) => {
  const { open } = fixture(t),
    store = open(),
    tool = entry(),
    circuit = new Circuit(store);
  failThree(store, circuit, tool);
  cool(store);
  const first = new CallLease(store, 'probe', false),
    second = new CallLease(open(), 'other', false);
  try {
    const reserved = circuit.reserve(first, tool);
    assert.equal(reserved.probe, true);
    assert.equal(circuit.status(tool).state, 'half_open');
    assert.throws(() => circuit.reserve(second, tool), CircuitOpen);
    circuit.finish(first, tool, reserved, 'cancelled');
    const next = circuit.reserve(second, tool);
    circuit.finish(second, tool, next, 'success');
    assert.deepEqual(circuit.status(tool), { state: 'closed', failures: 0, retryAt: null });
  } finally {
    first.release();
    second.release();
  }
});

test('stale concurrent success cannot close a circuit opened by newer failures', (t) => {
  const store = fixture(t).open(),
    tool = entry(),
    circuit = new Circuit(store);
  const old = new CallLease(store, 'old-reader', false),
    reservation = circuit.reserve(old, tool);
  try {
    failThree(store, circuit, tool);
    circuit.finish(old, tool, reservation, 'success');
    assert.equal(circuit.status(tool).state, 'open');
  } finally {
    old.release();
  }
});

test('expired probe ownership can recover while a failed probe starts a new cooldown', (t) => {
  const { open } = fixture(t),
    store = open(),
    tool = entry(),
    circuit = new Circuit(store);
  failThree(store, circuit, tool);
  cool(store);
  const old = new CallLease(store, 'old-probe', false);
  circuit.reserve(old, tool);
  store.db.execute('UPDATE hecaton_leases SET expires_at=0');
  const current = new CallLease(open(), 'new-probe', false);
  try {
    const reservation = circuit.reserve(current, tool);
    assert.equal(reservation.probe, true);
    circuit.finish(current, tool, reservation, 'failure');
    assert.ok(circuit.status(tool).retryAt >= Date.now() + 59000);
    assert.throws(() => old.assert(), /lost|expired/);
  } finally {
    old.release();
    current.release();
  }
});
