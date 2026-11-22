import assert from 'node:assert/strict';
import test from 'node:test';
import { driveWorkflow, validateWorkflowAction } from '../extension/workflow-execution.js';
import { validateBundle } from '../extension/workflow.js';

const hold = new Error('Paused');
const noAction = () => assert.fail('Unexpected action');
const step = (id, op, properties = {}) => ({ id, op, label: id, ...properties });

function harness(steps, options = {}) {
  const stored = new Map();
  const events = [];
  const settings = {
    workflow: { steps },
    tabs: new Map([['source', 11], ['target', 22]]),
    executeRecipe: async () => assert.fail('Unexpected recipe'),
    checkpoint: async ({ id }, value) => {
      events.push([id, structuredClone(value)]);
      stored.set(id, structuredClone(value));
    },
    requestAction: noAction,
    ...options,
  };
  return {
    stored, events,
    drive: (requestAction = settings.requestAction) => driveWorkflow({ ...settings, requestAction, results: new Map(stored) }),
  };
}

test('resumes across handoffs using fixed tab bindings and resolves the acknowledged value downstream', async () => {
  const steps = [
    step('inspect', 'recipe', { effect: 'read', tab: 'source', recipeId: 'read' }),
    step('review', 'handoff', { tab: 'target', tags: ['confirm', 'choose'], inputs: { current: 'inspect.value' } }),
    step('compare', 'transform', { transform: 'compare-values', inputs: { left: 'inspect.value', right: 'review' } }),
  ];
  let reads = 0;
  const run = harness(steps, {
    executeRecipe: (step, inputs, tabId) => {
      assert.equal(step.recipeId, 'read');
      assert.equal(tabId, 11);
      assert.deepEqual(inputs, {});
      reads++;
      return { outputs: { value: 'A' }, adapterId: 'source', runId: 'read-one' };
    },
  });
  const review = (_step, tag, context) => {
    assert.equal(tag, 'handoff');
    assert.deepEqual(context, { id: 'review:handoff', tabId: 22, tags: ['confirm', 'choose'],
      label: 'review', fields: {}, inputs: { current: 'A' } });
  };
  await assert.rejects(run.drive((...args) => { review(...args); throw hold; }), error => error === hold);
  const results = await run.drive((...args) => { review(...args); return { value: ' A ' }; });
  assert.equal(reads, 1);
  assert.equal(results.get('compare').value.equal, true);
  assert.deepEqual(results.get('inspect').audit, { adapterId: 'source', runId: 'read-one' });
});

test('validates handoff tags and optional tab roles', () => {
  const base = { id: 'review', title: 'Review', tabs: {}, steps: [step('handoff', 'handoff', { tags: ['review'] })] };
  validateBundle({ adapters: [], workflows: [base] });
  for (const change of [{ tags: [] }, { tags: ['review', 'review'] }, { tags: ['constructor'] }, { tab: 'missing' }]) {
    const workflows = [{ ...base, steps: [{ ...base.steps[0], ...change }] }];
    assert.throws(() => validateBundle({ adapters: [], workflows }), /handoff tags or tab role/);
  }
});

test('checkpoints submitted fields and reviews choices by index after resuming', async () => {
  const steps = [
    step('source', 'connector', { connector: 'local', operation: 'records' }),
    step('pick', 'transform', { transform: 'select-rows', select: true, inputs: { rows: 'source.rows' },
      fields: { note: { label: 'Note', type: 'text' }, day: { label: 'Day', type: 'date' } } }),
  ];
  const run = harness(steps, {
    initialInputs: { pick: { note: 'Review' } },
    executeConnector: () => ({ rows: [{ label: 'One', value: 'first' }, { label: 'Two', value: 'second' }] }),
  });
  await assert.rejects(run.drive((_step, tag, context) => {
    if (tag === 'fields') {
      assert.deepEqual(context.fields, { note: 'Review' });
      assert.throws(() => validateWorkflowAction(tag, context, { fields: { day: '2026-02-31' } }), /valid date/);
      return { fields: { day: '2026-02-10' } };
    }
    throw hold;
  }), error => error === hold);
  assert.equal(run.stored.get('pick').pending, true);
  const results = await run.drive((_step, tag, context) => {
    assert.equal(tag, 'selection');
    assert.deepEqual(context.choices, [{ index: 0, label: 'One' }, { index: 1, label: 'Two' }]);
    assert.throws(() => validateWorkflowAction(tag, context, { indices: [1, 1] }), /listed items/);
    return { indices: [1, 0] };
  });
  assert.deepEqual(results.get('pick').fields, { note: 'Review', day: '2026-02-10' });
  assert.deepEqual(results.get('pick').selected.map(row => row.value), ['first', 'second']);
  assert.deepEqual(results.get('pick').sources, ['local']);
});

test('agent step offers a manual result and strips document payloads from its action context', async () => {
  const file = { kind: 'file', name: 'in.pdf', mimeType: 'application/pdf', base64: btoa('%PDF-1.7\ncontent') };
  const run = harness([
    step('source', 'connector', { connector: 'local', operation: 'document' }),
    step('agent', 'agent', { instruction: 'Return a JSON value', inputs: { document: 'source.document' } }),
  ], { executeConnector: () => ({ document: file }) });
  const results = await run.drive((_step, tag, context) => {
    assert.equal(tag, 'agent');
    assert.equal(context.inputs.document.kind, 'attachment');
    assert.equal(context.inputs.document.name, file.name);
    assert.equal(context.inputs.document.base64, undefined);
    return { value: { complete: true } };
  });
  assert.deepEqual(results.get('agent').value, { complete: true });
  assert.deepEqual(results.get('agent').sources, ['local']);
});

test('a repeated write persists uncertainty before execution and never retries an uncertain item implicitly', async () => {
  let writes = 0;
  let checks = 0;
  const steps = [
    step('source', 'connector', { connector: 'local', operation: 'records' }),
    step('apply', 'recipe', { effect: 'write', tab: 'target', recipeId: 'write',
      repeat: { items: 'source.rows', map: { name: 'label', ordinal: '$index' }, label: 'label',
        verify: { recipeId: 'verify', map: { name: 'label' }, output: 'found', equals: true } } }),
  ];
  const run = harness(steps, {
    executeConnector: () => ({ rows: [{ label: 'First' }, { label: 'Second' }] }),
    executeRecipe(step, inputs, tabId) {
      assert.equal(tabId, 22);
      if (step.recipeId === 'verify') {
        assert.deepEqual(inputs, { name: 'First' });
        assert.equal(step.effect, 'read');
        return { outputs: { found: ++checks === 2 }, runId: 'verify-two', adapterId: 'target' };
      }
      assert.deepEqual(inputs, { name: 'First', ordinal: '1' });
      assert.deepEqual(run.stored.get('apply').write.status, ['uncertain', 'pending']);
      writes++;
      throw new Error('Connection lost after writing');
    },
  });
  await assert.rejects(run.drive((_step, tag, { id }) => {
    if (tag === 'write') {
      assert.equal(id, 'apply:write:0:0');
      return { decision: 'run' };
    }
    throw hold;
  }), error => error === hold);
  const results = await run.drive((_step, tag, context) => {
    if (tag === 'uncertain-write') {
      assert.equal(context.id, 'apply:uncertain-write:0:0:' + checks);
      assert.equal(context.verificationFailed, checks > 0);
      assert.equal(context.canVerify, true);
      return { decision: 'verify' };
    }
    assert.equal(context.id, 'apply:write:1:0');
    return { decision: 'skip' };
  });
  assert.equal(writes, 1);
  assert.equal(checks, 2);
  assert.deepEqual(results.get('apply').value.items, [{ item: 1, status: 'complete' }, { item: 2, status: 'skipped' }]);
  assert.deepEqual(results.get('apply').audit.items, [{ runId: 'verify-two', adapterId: 'target' }, null]);
});

test('does not replay a single write after the completion checkpoint fails', async () => {
  const steps = [step('apply', 'recipe', { effect: 'write', tab: 'target', recipeId: 'write' })];
  const stored = new Map();
  let writes = 0;
  let failCheckpoint = true;
  const drive = requestAction => driveWorkflow({
    workflow: { steps }, tabs: { target: 22 }, results: new Map(stored), requestAction,
    executeRecipe: () => ({ outputs: { complete: true }, runId: ++writes }),
    checkpoint: (step, entry) => {
      if (!entry.pending && failCheckpoint) throw hold;
      stored.set(step.id, structuredClone(entry));
    },
  });
  await assert.rejects(drive(() => ({ decision: 'run' })), error => error === hold);
  assert.deepEqual(stored.get('apply').write.status, ['uncertain']);
  failCheckpoint = false;
  const results = await drive((_step, tag, { canVerify }) => {
    assert.equal(tag, 'uncertain-write');
    assert.equal(canVerify, false);
    return { decision: 'mark-applied' };
  });
  assert.equal(writes, 1);
  assert.equal(results.get('apply').audit.status, 'complete');
});

test('recipe review approves actual edited inputs and checkpoints original outputs across pauses', async () => {
  let runs = 0;
  const apply = step('update', 'recipe', { effect: 'write', tab: 'target', recipeId: 'write',
    fields: { approved: { label: 'Approved', type: 'checkbox' } } });
  const run = harness([apply], {
    reviewRecipes: true,
    initialInputs: { update: { approved: false } },
    recipeInputs: { update: { description: 'Original' } },
    executeRecipe(_step, inputs) {
      runs++;
      assert.deepEqual(inputs, { description: 'Reviewed', approved: 'true' });
      return { outputs: { summary: 'Original output' }, adapterId: 'target', runId: 'original' };
    },
  });
  await assert.rejects(run.drive((_step, tag, context) => {
    if (tag === 'edit-inputs') {
      assert.deepEqual(context.data, { description: 'Original', approved: false });
      return { edits: [
        { path: ['description'], op: 'replace', value: 'Reviewed' },
        { path: ['approved'], op: 'replace', value: true },
      ] };
    }
    if (tag === 'write') {
      assert.deepEqual(context.inputs, { description: 'Reviewed', approved: 'true' });
      return { decision: 'run' };
    }
    assert.equal(tag, 'edit-outputs');
    throw hold;
  }), error => error === hold);
  assert.equal(runs, 1);
  assert.equal(run.stored.get('update').outputReview.value.summary, 'Original output');
  const results = await run.drive((_step, tag, context) => {
    assert.equal(tag, 'edit-outputs');
    assert.equal(context.id, 'update:edit-outputs');
    assert.equal(context.adapterId, 'target');
    return { edits: [{ path: ['summary'], op: 'replace', value: 'Reviewed output' }] };
  });
  assert.equal(runs, 1);
  assert.deepEqual(results.get('update').fields, { approved: true });
  assert.deepEqual(results.get('update').value, { summary: 'Reviewed output' });
  assert.deepEqual(results.get('update').audit.originalOutputs, { summary: 'Original output' });
});

test('an edited repeated item has separate review per attempt and does not verify the original item', async () => {
  let writes = 0;
  const run = harness([
    step('source', 'connector', { connector: 'local', operation: 'records' }),
    step('apply', 'recipe', { effect: 'write', tab: 'target', recipeId: 'write',
      repeat: { items: 'source.rows', map: { name: 'label' }, label: 'label',
        verify: { recipeId: 'verify', map: { name: 'label' }, output: 'found', equals: true } } }),
  ], {
    reviewRecipes: true,
    executeConnector: () => ({ rows: [{ label: 'Original' }] }),
    executeRecipe(step, inputs) {
      assert.equal(step.recipeId, 'write');
      assert.equal(inputs.name, writes === 0 ? 'Edited' : 'Original');
      if (++writes === 1) throw new Error('Disconnected');
      return { outputs: {}, adapterId: 'target' };
    },
  });
  await assert.rejects(run.drive((_step, tag, context) => {
    if (tag === 'edit-inputs') {
      assert.equal(context.id, 'apply:edit-inputs:0:0');
      return { edits: [{ path: ['name'], op: 'replace', value: 'Edited' }] };
    }
    if (tag === 'write') return { decision: 'run' };
    throw hold;
  }), error => error === hold);
  assert.equal(writes, 1);
  await run.drive((_step, tag, context) => {
    if (tag === 'uncertain-write') {
      assert.equal(context.canVerify, false);
      assert.equal(context.inputs.name, 'Edited');
      return { decision: 'mark-not-applied' };
    }
    if (tag === 'edit-inputs') {
      assert.equal(context.id, 'apply:edit-inputs:0:1');
      assert.equal(context.data.name, 'Original');
      return { edits: [] };
    }
    if (tag === 'write') return { decision: 'run' };
    assert.equal(tag, 'edit-outputs');
    return { edits: [] };
  });
  assert.equal(writes, 2);
});
