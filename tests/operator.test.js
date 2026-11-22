import assert from 'node:assert/strict';
import test from 'node:test';
import { developerObserver, observedRecipe } from '../extension/dev-observer.js';
import { availableGuideActions, guidePrompt, guideReply } from '../extension/guide.js';
import { canWrite, checkpointSummary, currentItem, mapItemInputs, newCheckpoint, updateCheckpoint, writeItems } from '../extension/write-session.js';
import { validateBundle } from '../extension/workflow.js';

test('Guide shows only current offered actions and accepts instruction suggestions only on an agent step', () => {
  const actions = availableGuideActions({ op: 'recipe', effect: 'write' }, true, false);
  const reply = { answer: 'Review the destination', actions: ['run-write', 'review-write'], instructions: ['Do it automatically.'] };
  assert.deepEqual(guideReply(reply, actions, false), {
    answer: 'Review the destination', actions: [{ id: 'review-write', label: 'Review the write and destination' }], instructions: [],
  });
  const conversation = Array.from({ length: 8 }, (_, index) => ({ question: 'question' + index, answer: 'answer' + index }));
  const prompt = guidePrompt({ question: ' Next? ', workflow: 'Fixture', step: 'Review', actions, history: conversation });
  const payload = JSON.parse(prompt.split('\n').at(-1));
  assert.equal(payload.question, 'Next?');
  assert.equal(payload.history.length, 6);
  assert.equal(payload.history[0].question, 'question2');
  assert.deepEqual(payload.actions, actions);
});

test('repeat writes checkpoint uncertainty before dispatch and require an explicit recovery transition', () => {
  const items = writeItems([{ title: 'First', place: 'Room D' }, { title: 'Second', place: 'Room B' }], { label: 'title' });
  assert.deepEqual(mapItemInputs({ name: 'title', room: 'place', order: '$index' }, items[1].raw, 1), {
    name: 'Second', room: 'Room B', order: '2',
  });
  const first = newCheckpoint('fixture-run', items.length);
  const uncertain = updateCheckpoint(first, 0, 'begin');
  assert.equal(canWrite(uncertain.status[0]), false);
  assert.throws(() => updateCheckpoint(uncertain, 0, 'begin'), /checkpoint/);
  const recovered = updateCheckpoint(uncertain, 0, 'missing');
  assert.equal(canWrite(recovered.status[0]), true);
  const completed = updateCheckpoint(updateCheckpoint(recovered, 0, 'begin'), 0, 'confirm');
  assert.equal(currentItem(completed), 1);
  const finished = updateCheckpoint(completed, 1, 'skip');
  assert.equal(currentItem(finished), -1);
  assert.deepEqual(checkpointSummary(finished).items.map(item => item.status), ['complete', 'skipped']);
  assert.doesNotMatch(JSON.stringify(finished), /First|Room/);
});

test('repeat validation maps required inputs and refuses a mutating verification recipe', () => {
  const adapters = [{
    id: 'fixture-site', title: 'Fixture site', origin: 'https://fixture.example',
    recipes: [
      { id: 'read', title: 'Read rows', steps: [{ op: 'readList', selector: 'article', as: 'rows' }] },
      { id: 'write', title: 'Write one', inputs: { text: { type: 'string' }, ordinal: { type: 'string' } },
        steps: [{ op: 'fill', selector: '#text', input: 'text' }, { op: 'fill', selector: '#ordinal', input: 'ordinal' }] },
      { id: 'verify', title: 'Verify status', steps: [{ op: 'read', selector: '#status', as: 'status' }] },
    ],
  }];
  const repeat = {
    items: 'collect.rows', map: { text: 'text', ordinal: '$index' }, label: 'text',
    verify: { recipeId: 'verify', output: 'status', equals: 'Saved' },
  };
  const workflows = [{
    id: 'fixture', title: 'Fixture', tabs: { page: { adapterId: 'fixture-site', label: 'Page' } },
    steps: [
      { id: 'collect', label: 'Collect', op: 'recipe', tab: 'page', recipeId: 'read', effect: 'read' },
      { id: 'save-items', label: 'Save items', op: 'recipe', tab: 'page', recipeId: 'write', effect: 'write', repeat },
    ],
  }];
  assert.doesNotThrow(() => validateBundle({ adapters, workflows }));
  const map = repeat.map;
  repeat.map = { text: 'text' };
  assert.throws(() => validateBundle({ adapters, workflows }), /Missing recipe input: ordinal/);
  repeat.map = map;
  adapters[0].recipes[2].steps.push({ op: 'click', selector: 'button' });
  assert.throws(() => validateBundle({ adapters, workflows }), /read-only recipe output/);
});

function eventHub() {
  const listeners = new Set();
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    emit: (...args) => listeners.forEach(listener => listener(...args)),
  };
}

function observerFixture() {
  const origin = 'https://site.example';
  const state = { devMode: true, approvedOrigins: [origin] };
  const storage = Object.create(null);
  const tab = { id: 7, windowId: 5, active: true, url: origin };
  const tabs = {
    get: async () => ({ ...tab }), captureVisibleTab: async () => 'data:image/jpeg;base64,AAAA',
    onActivated: eventHub(), onUpdated: eventHub(), onRemoved: eventHub(),
  };
  const browser = {
    storage: {
      local: { get: async key => ({ [key]: state[key] }) },
      session: {
        get: async key => key ? { [key]: storage[key] } : { ...storage },
        set: async entries => Object.assign(storage, entries),
        remove: async key => delete storage[key],
      },
    },
    permissions: { contains: async () => true },
    tabs,
    scripting: { executeScript: async () => [{ result: true, documentId: 'fixture-document' }] },
  };
  const control = developerObserver(browser, async () => [{ id: 'fixture', origin }], (_key, operation) => operation());
  return { control, state, storage, tab, tabs, args: { tabId: tab.id, adapterId: 'fixture' } };
}

test('recording refuses untrusted documents and retains structural actions without data values', async () => {
  const { control, state, storage, tab, args } = observerFixture();
  state.devMode = false;
  await assert.rejects(control.start(args), { code: 'RECORDER_UNAVAILABLE' });
  state.devMode = true;
  await control.start(args);
  const [{ token }] = Object.values(storage);
  const message = { token, op: 'fill', selector: 'body > input:nth-of-type(1)', value: 'secret text' };
  const sender = { tab, frameId: 0, documentId: 'another-document', url: tab.url };
  assert.deepEqual(await control.event(message, sender), { keep: false });
  sender.documentId = 'fixture-document';
  assert.deepEqual(await control.event(message, sender), { keep: true });
  assert.doesNotMatch(JSON.stringify(storage), /secret text/);
  const stopped = await control.stop(args);
  assert.equal(stopped.count, 1);
  assert.deepEqual(stopped.recipe.steps, [{ op: 'fill', selector: message.selector, input: 'field-1' }]);
  assert.equal(stopped.recipe.inputs['field-1'].required, true);
  assert.equal(observedRecipe([{ op: 'fill', selector: '[value="secret"]' }]).steps.length, 0);
});

test('evidence capture rejects inactive targets and discards frames when activation changes', async () => {
  const { control, tab, tabs, args } = observerFixture();
  tab.active = false;
  await assert.rejects(control.capture(args), { code: 'ACTIVE_TAB_REQUIRED' });
  tab.active = true;
  assert.deepEqual(await control.capture(args), { dataUrl: 'data:image/jpeg;base64,AAAA' });
  tabs.captureVisibleTab = async () => {
    tabs.onActivated.emit({ windowId: tab.windowId, tabId: 8 });
    return 'data:image/jpeg;base64,BBBB';
  };
  await assert.rejects(control.capture(args), { code: 'RECORDER_UNAVAILABLE' });
});

test('agent attachment approval drops unchecked files and indexes only referenced approved binaries', async () => {
  const { agentDocumentInputs, reviewedDocumentInputs } = await import('../extension/workflow-documents.js');
  const pdf = btoa('%PDF-1.7\nsynthetic');
  const file = name => ({ kind: 'file', name, mimeType: 'application/pdf', base64: pdf });
  const { inputs, attachments } = agentDocumentInputs({ first: file('one.pdf'), second: file('two.pdf') });
  assert.doesNotMatch(JSON.stringify(inputs), new RegExp(pdf.replaceAll('+', '\\+')));
  const result = reviewedDocumentInputs(inputs, attachments, new Set([2]));
  assert.equal(result.inputs.first.kind, 'omitted-attachment');
  assert.equal(result.inputs.second.attachment, 1);
  assert.deepEqual(result.attachments.map(item => item.name), ['two.pdf']);
  assert.throws(() => reviewedDocumentInputs(file('unreviewed.pdf'), attachments, new Set()), /attachment options/);
});
