import assert from 'node:assert/strict';
import test from 'node:test';
import { createRunService } from '../extension/run-service.js';
import { validateBundle } from '../extension/workflow.js';

const app = 'https://app.example.test';
const signIn = 'https://signin.example.test';
const adapter = {
  id: 'app', title: 'App', origin: app, auth: { entryPath: '/', origins: [signIn] }, targets: { title: 'h1', apply: '#apply' },
  recipes: [
    { id: 'inspect', title: 'Inspect', steps: [{ op: 'read', target: 'title', as: 'value' }] },
    { id: 'apply', title: 'Apply', steps: [{ op: 'click', target: 'apply' }] },
    { id: 'echo', title: 'Read with inputs', inputs: { text: { type: 'string', required: true } },
      steps: [{ op: 'read', target: 'title', as: 'value' }] },
  ],
};
const steps = [
  { id: 'inspect', label: 'Inspect', op: 'recipe', tab: 'target', recipeId: 'inspect', effect: 'read' },
  { id: 'review', label: 'Review', op: 'handoff', tab: 'target', tags: ['review-data'], inputs: { value: 'inspect.value' } },
  { id: 'apply', label: 'Apply', op: 'recipe', tab: 'target', recipeId: 'apply', effect: 'write' },
];
const bundle = validateBundle({ adapters: [adapter], workflows: [
  { id: 'review-and-apply', title: 'Review and apply', tabs: { target: { label: 'App', adapterId: adapter.id } }, steps },
] });

function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async key => data.has(key) ? { [key]: structuredClone(data.get(key)) } : {},
    set: async entries => { for (const [key, entry] of Object.entries(entries)) data.set(key, structuredClone(entry)); },
    getKeys: async () => [...data.keys()],
    remove: async key => { data.delete(key); },
  };
}

function harness(url = app) {
  const tabs = new Map([[44, { id: 44, url, active: false, windowId: 2 }]]);
  const browser = {
    storage: { local: storage({ approvedOrigins: [app] }), session: storage() },
    permissions: { contains: async () => true },
    tabs: {
      query: async () => [...tabs.values()],
      get: async id => tabs.get(id),
      update: async () => assert.fail('A run changed tab focus'),
      create: async () => assert.fail('A run opened a tab'),
    },
    windows: { update: async () => assert.fail('A run changed window focus') },
  };
  const calls = [];
  const options = {
    browser, loadBundle: async () => bundle,
    dispatch: async (command, args) => {
      assert.equal(command, 'run');
      assert.equal(args.tabId, 44);
      calls.push(args.recipeId);
      if (args.recipeId === 'apply') throw new Error('Destination reply interrupted');
      if (args.recipeId === 'echo') return { outputs: { value: args.inputs.text } };
      return { outputs: { value: 'private ticket title' } };
    },
    allowModel: async () => assert.fail('A run called the model permission workflow'),
    plan: async () => assert.fail('A run sent an inference request'),
  };
  return { freshWorker: () => createRunService(options), calls, tabs, browser };
}

test('worker resumes one ordered run, rejects stale or invalid answers, and keeps private values out of history', async () => {
  const { freshWorker, calls, tabs, browser } = harness();
  let service = freshWorker();
  let run = await service('runs.start', { kind: 'workflow', workflowId: 'review-and-apply' }, 'cli');
  const id = run.runId;
  assert.equal(run.status, 'waiting');
  assert.deepEqual(run.pending.tags, ['handoff', 'review-data']);
  assert.equal(run.pending.tabId, 44);
  assert.equal(run.steps[0].childRunIds.length, 1);
  assert.deepEqual(calls, ['inspect']);
  assert.doesNotMatch(JSON.stringify([...browser.storage.local.data.values()]), /private ticket title/);
  const inspect = await service('runs.get', { runId: id, includeData: true });
  assert.equal(inspect.pending.context.inputs.value, 'private ticket title');

  // A newly opened matching tab must never displace the run's already selected tab.
  tabs.set(45, { id: 45, url: app, active: false, windowId: 2 });
  service = freshWorker();
  await assert.rejects(service('runs.resume', { runId: id, actionId: 'stale', answer: {} }), /stale/);
  run = await service('runs.resume', { runId: id, actionId: run.pending.id, answer: {} });
  assert.equal(run.status, 'waiting');
  assert.equal(run.pending.tags[0], 'write');
  await assert.rejects(service('runs.resume', { runId: id, actionId: run.pending.id, answer: { decision: 'verify' } }), /run or skip/);
  run = await service('runs.resume', { runId: id, actionId: run.pending.id, answer: { decision: 'run' } });
  assert.equal(run.status, 'waiting');
  assert.equal(run.pending.tags[0], 'uncertain-write');

  service = freshWorker();
  run = await service('runs.resume', { runId: id, actionId: run.pending.id, answer: { decision: 'mark-applied' } });
  assert.equal(run.status, 'completed');
  assert.deepEqual(calls, ['inspect', 'apply']);
  assert.equal(run.steps.find(step => step.id === 'apply').childRunIds.length, 1);
  assert.equal((await service('runs.get', { runId: id, includeData: true })).entries, undefined);
});

test('authentication acknowledgments recheck the real app tab and do not run on the sign-in origin', async () => {
  const { freshWorker, calls, tabs } = harness(signIn);
  const service = freshWorker();
  let run = await service('runs.start', { kind: 'workflow', workflowId: 'review-and-apply', tabs: { target: 44 } });
  const id = run.runId;
  assert.equal(run.pending.tags[0], 'auth');
  const previous = run.pending.id;
  run = await service('runs.resume', { runId: id, actionId: previous, answer: {} });
  assert.equal(run.pending.tags[0], 'auth');
  assert.notEqual(run.pending.id, previous);
  assert.deepEqual(calls, []);

  tabs.get(44).url = app;
  run = await service('runs.resume', { runId: id, actionId: run.pending.id, answer: {} });
  assert.equal(run.pending.tags[0], 'handoff');
  assert.deepEqual(calls, ['inspect']);
});

test('standalone recipe review runs with revised inputs and retains original outputs when requested', async () => {
  const { freshWorker, calls } = harness();
  let service = freshWorker();
  let run = await service('runs.start', {
    kind: 'recipe', adapterId: adapter.id, recipeId: 'echo', inputs: { text: 'original' },
    reviewRecipes: true, retainData: true,
  });
  const runId = run.runId;
  assert.equal(run.pending.tag, 'edit-inputs');
  assert.deepEqual(calls, []);
  run = await service('runs.resume', { runId, actionId: run.pending.id,
    answer: { edits: [{ op: 'replace', path: ['text'], value: 'changed before read' }] } });
  assert.equal(run.pending.tag, 'edit-outputs');
  assert.deepEqual(calls, ['echo']);
  service = freshWorker();
  run = await service('runs.resume', { runId, actionId: run.pending.id,
    answer: { edits: [{ op: 'replace', path: ['value'], value: 'changed after read' }] } });
  assert.equal(run.status, 'completed');
  assert.deepEqual(calls, ['echo']);
  const retained = await service('runs.get', { runId, includeData: true });
  assert.deepEqual(retained.result, { value: 'changed after read' });
  assert.deepEqual(retained.entries.echo.audit.originalOutputs, { value: 'changed before read' });
});

test('connection checks leave a blocked action alone and stop at the next human action', async () => {
  const {freshWorker,calls,tabs} = harness(signIn);
  const service = freshWorker();
  const run = await service('runs.start',{kind:'workflow',workflowId:'review-and-apply',tabs:{target:44}});
  const check = actionId => service('runs.checkConnection',{runId:run.runId,actionId});
  const blocked = await check(run.pending.id);
  assert.deepEqual(blocked.actions,run.actions);
  assert.deepEqual(calls,[]);
  tabs.get(44).url = app;
  const next = await check(run.pending.id);
  assert.equal(next.pending.tag,'handoff');
  assert.deepEqual(calls,['inspect']);
  assert.deepEqual((await check(next.pending.id)).pending,next.pending);
  const write = await service('runs.resume',{runId:run.runId,actionId:next.pending.id,answer:{}});
  assert.equal(write.pending.tag,'write');
  assert.deepEqual((await check(write.pending.id)).pending,write.pending);
  assert.deepEqual(calls,['inspect']);
});
