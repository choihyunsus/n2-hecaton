// Run the published Gumiho harness through Hecaton capabilities against one durable Soul-compatible DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Gumiho } = require('n2-gumiho');
const { fixture } = require('./helpers.cjs');

function setupWorkflow(t, uncertain = false) {
  const setup = fixture(t),
    workspace = path.join(setup.directory, 'workspace');
  fs.mkdirSync(workspace);
  const filename = path.join(workspace, 'answer.txt');
  const counts = { models: 0, effects: 0, checks: 0 };
  const tools = [
    {
      name: 'write_answer',
      version: '1',
      description: 'Append the expected answer exactly once',
      category: 'file',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      execute(args) {
        counts.effects++;
        fs.appendFileSync(filename, args.value + '\n');
        if (uncertain) throw new Error('fixture lost acknowledgement');
        return { success: true, output: 'written', modifiedFiles: ['answer.txt'] };
      },
    },
  ];
  const reply = (text, calls = []) => ({
    text,
    calls,
    stop: calls.length ? 'tools' : 'complete',
    model: 'offline-fixture',
    usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: null },
  });
  const provider = {
    id: 'offline',
    version: '1',
    model: 'offline-fixture',
    local: true,
    generate(request) {
      counts.models++;
      if (request.system.startsWith('Inspect the relevant'))
        return reply('Inspect fixed answer file');
      if (request.system.startsWith('Produce an actionable'))
        return reply('Write the exact answer, then verify bytes');
      if (request.system.startsWith('Implement the assigned'))
        return request.messages.length === 1
          ? reply('Write answer', [
              { id: 'write', name: 'write_answer', arguments: { value: 'correct' } },
            ])
          : reply('Created answer.txt');
      const context = JSON.parse(request.messages[0].content).context;
      return reply(
        JSON.stringify({ approved: true, snapshotHash: context.snapshotHash, findings: [] }),
      );
    },
  };
  const verifier = {
    version: '1',
    verify() {
      counts.checks++;
      return {
        success: fs.readFileSync(filename, 'utf8') === 'correct\n',
        summary: 'Compared actual file bytes',
        evidence: { filename: 'answer.txt' },
      };
    },
  };
  const create = async () => {
    const hecaton = setup.engine({ tools });
    const gumiho = await Gumiho.create({
      ...setup.options,
      workspaceRoot: workspace,
      tools: hecaton.asGumihoTools(['write_answer']),
      provider,
      verifier,
      expertise: false,
      pipeline: { maxRepairs: 0 },
      limits: { modelTimeoutMs: 1000, jobTimeoutMs: 5000 },
    });
    setup.cleanup.push(() => gumiho.close());
    return { hecaton, gumiho };
  };
  return { ...setup, create, filename, counts };
}

test('one published Gumiho provider uses Hecaton, passes native verification and replays after restart without another effect', async (t) => {
  const setup = setupWorkflow(t);
  const first = await setup.create();
  const request = {
    runId: 'workflow-one',
    task: 'Create the correct answer',
    sessionId: 'shared-session',
  };
  const result = await first.gumiho.run(request);
  assert.equal(result.success, true);
  assert.equal(result.budget.modelRequests, 5);
  assert.equal(result.budget.toolCalls, 1);
  assert.equal(setup.counts.models, 5);
  assert.equal(setup.counts.effects, 1);
  assert.ok(setup.counts.checks > 0);
  assert.equal(first.hecaton.history().length, 1);
  const record = first.hecaton.status(first.hecaton.history()[0].requestId).call;
  assert.equal(record.sessionId, request.runId);
  assert.equal(record.state, 'completed');
  const db = setup.open();
  assert.equal(
    db.db.query("SELECT count(*) AS count FROM experiences WHERE category='hecaton_tool'")[0].count,
    1,
  );
  const tables = db.db
    .query("SELECT name FROM sqlite_master WHERE type='table'")
    .map((row) => row.name);
  assert.ok(tables.includes('hecaton_calls'));
  assert.ok(tables.includes('gumiho_runs'));
  assert.ok(tables.includes('n2r_runs'));
  assert.equal(db.db.query('PRAGMA integrity_check')[0].integrity_check, 'ok');
  await first.gumiho.close();
  await first.hecaton.close();
  const second = await setup.create();
  const replay = await second.gumiho.run(request);
  assert.equal(replay.success, true);
  assert.equal(setup.counts.models, 5);
  assert.equal(setup.counts.effects, 1);
  assert.equal(fs.readFileSync(setup.filename, 'utf8'), 'correct\n');
});

test('uncertain Hecaton side effects remain single across Gumiho retries and resume after evidence-based reconciliation', async (t) => {
  const setup = setupWorkflow(t, true);
  const { hecaton, gumiho } = await setup.create();
  const request = { runId: 'workflow-uncertain', task: 'Create the correct answer' };
  await assert.rejects(gumiho.run(request));
  assert.equal(setup.counts.effects, 1);
  const requestId = hecaton.history()[0].requestId;
  assert.equal(hecaton.status(requestId).needsReconciliation, true);
  await assert.rejects(gumiho.run(request));
  assert.equal(setup.counts.effects, 1);
  hecaton.reconcile(
    requestId,
    { success: true, output: 'written', modifiedFiles: ['answer.txt'] },
    'Read answer.txt and checked its single correct line',
  );
  const result = await gumiho.run(request);
  assert.equal(result.success, true);
  assert.equal(setup.counts.effects, 1);
  assert.equal(fs.readFileSync(setup.filename, 'utf8'), 'correct\n');
});
