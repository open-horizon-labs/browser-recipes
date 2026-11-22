import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatcher, safeError } from '../extension/runtime.js';
import { validateCatalog, validateInputs, validateRecipe } from '../extension/schema.js';

const adapter = {
  id: 'workshop',
  title: 'Workshop',
  origin: 'http://localhost:8765',
  targets: { name: 'h1', message: '#message', file: '#file' },
  documentPaths: ['/files/'],
  recipes: [
    {
      id: 'update',
      title: 'Update',
      inputs: { message: { type: 'string', required: true } },
      steps: [
        { op: 'navigate', path: '/ticket' },
        { op: 'fill', target: 'message', input: 'message' },
        { op: 'read', target: 'name', as: 'name' },
      ],
    },
    {
      id: 'upload',
      title: 'Upload',
      inputs: { file: { type: 'attachment' } },
      steps: [{ op: 'attach', target: 'file', input: 'file' }],
    },
  ],
};

function mockBrowser() {
  const storage = { approvedOrigins: [adapter.origin] };
  const tabs = [
    { id: 44, url: adapter.origin, active: false },
    { id: 45, url: 'http://localhost:9000', active: true },
  ];
  const operations = [];
  const browser = {
    permissions: { async contains() { return true; } },
    storage: {
      local: {
        async get(key) { return { [key]: storage[key] }; },
        async set(entries) { Object.assign(storage, entries); },
      },
    },
    tabs: {
      async query(query) {
        assert.deepEqual(query, {});
        return tabs;
      },
      async get(tabId) {
        const tab = tabs.find(tab => tab.id === tabId);
        if (!tab) throw new Error('missing');
        return tab;
      },
      async update(tabId, changes) {
        assert.equal(tabId, 44);
        assert.deepEqual(Object.keys(changes), ['url']);
        tabs[0] = { ...tabs[0], ...changes };
      },
    },
    scripting: {
      async executeScript({ target, args: [operation] }) {
        assert.deepEqual(target, { tabId: 44 });
        operations.push(operation);
        return [{ result: { ok: true, value: operation.op === 'read' ? 'Ticket' : undefined } }];
      },
    },
  };
  return { browser, storage, tabs, operations };
}

function request(overrides = {}) {
  return { tabId: 44, adapterId: adapter.id, recipeId: 'update', inputs: { message: 'secret input' }, ...overrides };
}

test('validates data-only recipes and constrains navigation, element targets and documents', () => {
  assert.equal(validateCatalog([adapter])[0], adapter);
  const valid = steps => validateRecipe({ id: 'draft', title: 'Draft', steps }, adapter);
  assert.throws(() => valid([{ op: 'navigate', path: '//external.example' }]), /Invalid recipe step/);
  assert.throws(() => valid([{ op: 'navigate', path: '/\\external.example' }]), /Invalid recipe step/);
  assert.throws(() => valid([{ op: 'read', selector: 'h1', target: 'name', as: 'title' }]), /Invalid recipe step/);
  assert.throws(() => valid([{ op: 'read', target: 'missing', as: 'title' }]), /Invalid recipe step/);
  assert.throws(() => valid([{ op: 'javascript', source: 'alert(1)' }]), /Invalid recipe step/);
  assert.throws(() => valid([{ op: 'readAttachment', selector: '#file', as: 'file', allowedPathPrefix: '/other/' }]), /Invalid recipe step/);
  assert.throws(() => validateCatalog([{ ...adapter, documentPaths: ['/'] }]), /Invalid adapter document paths/);
  assert.throws(() => validateCatalog([{ ...adapter, origin: 'https://username:password@localhost' }]), /Invalid adapter identity/);
});

test('requires typed inputs used by operations, including base64 files', () => {
  const recipe = adapter.recipes[1];
  const file = { name: 'note.txt', mimeType: 'text/plain', base64: 'YQ==' };
  assert.doesNotThrow(() => validateInputs(recipe, { file }));
  assert.throws(() => validateInputs(recipe, {}), /Provide inputs/);
  assert.throws(() => validateInputs(recipe, { file: { ...file, name: '../note.txt' } }), /Provide inputs/);
  assert.throws(() => validateInputs(recipe, { file: { ...file, base64: '!!!a' } }), /Provide inputs/);
});

test('grants exact origins and executes only on the explicitly addressed tab', async () => {
  const { browser, storage, tabs, operations } = mockBrowser();
  const dispatch = createDispatcher(browser, async () => [adapter]);
  assert.deepEqual(await dispatch('tabs'), [{ tabId: 44, adapterIds: [adapter.id] }]);
  assert.equal((await dispatch('catalog'))[0].recipes[0].id, 'update');
  assert.equal((await dispatch('run', request())).outputs.name, 'Ticket');
  assert.equal(operations[0].selector, '#message');
  assert.equal(tabs[1].active, true);
  await assert.rejects(dispatch('run', request({ tabId: 45 })), { code: 'ORIGIN_CHANGED' });
  await assert.rejects(dispatch('run', request({ tabId: undefined })), { code: 'TAB_REQUIRED' });
  storage.approvedOrigins = [];
  assert.deepEqual(await dispatch('catalog'), []);
  await assert.rejects(dispatch('run', request()), { code: 'PERMISSION_REQUIRED' });
});

test('enables drafting and failure handoffs only after opt-in and redacts operation data', async () => {
  const { browser, storage } = mockBrowser();
  const dispatch = createDispatcher(browser, async () => [adapter]);
  await assert.rejects(dispatch('dev.inspect', request()), { code: 'DEV_DISABLED' });
  await assert.rejects(dispatch('dev.failures'), { code: 'DEV_DISABLED' });
  storage.devMode = true;

  browser.scripting.executeScript = async () => {
    throw new Error('secret error text');
  };
  await assert.rejects(dispatch('run', request()), error => {
    assert.equal(error.code, 'SCRIPT_FAILED');
    assert.equal(error.details.step, 2);
    assert.equal(error.details.adapterId, adapter.id);
    assert.equal(error.details.recipeId, 'update');
    assert.equal(error.details.target, 'message');
    assert.deepEqual(error.details.completed.map(({ step, op }) => ({ step, op })), [{ step: 1, op: 'navigate' }]);
    assert.doesNotMatch(JSON.stringify(safeError(error)), /secret/i);
    return true;
  });
  const failures = await dispatch('dev.failures');
  assert.equal(failures[0].step, 2);
  assert.equal(failures[0].op, 'fill');
  assert.doesNotMatch(JSON.stringify(failures), /secret|#message/i);
});

test('holds a per-tab run lock across asynchronous operations', async () => {
  const { browser } = mockBrowser();
  let started;
  let release;
  const pending = new Promise(resolve => { started = resolve; });
  browser.scripting.executeScript = async () => {
    if (release) return [{ result: { ok: true, value: 'done' } }];
    return await new Promise(resolve => {
      release = () => resolve([{ result: { ok: true } }]);
      started();
    });
  };
  const dispatch = createDispatcher(browser, async () => [adapter]);
  const first = dispatch('run', request());
  await pending;
  await assert.rejects(dispatch('run', request()), { code: 'TAB_BUSY' });
  release();
  await first;
  assert.equal((await dispatch('run', request())).outputs.name, 'done');
});

test('does not inject into the old document while a direct navigation commits', async () => {
  const { browser, tabs, operations } = mockBrowser();
  const originalGet = browser.tabs.get;
  let pending;
  browser.tabs.update = async (tabId, { url }) => {
    pending = url;
  };
  browser.tabs.get = async tabId => {
    const tab = await originalGet(tabId);
    if (!pending) return tab;
    if (tab.pendingUrl) {
      assert.equal(operations.length, 0);
      delete tab.pendingUrl;
      tab.url = pending;
      pending = undefined;
    } else {
      tab.pendingUrl = pending;
    }
    return { ...tab };
  };
  const dispatch = createDispatcher(browser, async () => [adapter]);
  assert.equal((await dispatch('run', request())).outputs.name, 'Ticket');
  assert.equal(tabs[0].url, adapter.origin + '/ticket');
});

test('exact caller text is forwarded as a match operand, never added to a selector', async () => {
  const tested = structuredClone(adapter);
  tested.recipes = [{
    id: 'pick', title: 'Pick an exact label',
    inputs: { label: { type: 'string' }, value: { type: 'string' } },
    steps: [
      { op: 'click', selector: 'button', match: { input: 'label', attribute: 'aria-label' } },
      { op: 'assertValue', selector: '#message', input: 'value' },
      { op: 'readList', selector: '.receipt', attributes: ['aria-label'], as: 'receipts' },
    ],
  }];
  validateCatalog([tested]);
  const { browser, operations } = mockBrowser();
  const dispatch = createDispatcher(browser, async () => [tested]);
  const label = 'A ["quoted"] label';
  await dispatch('run', request({ recipeId: 'pick', inputs: { label, value: 'Reviewed' } }));
  assert.equal(operations[0].selector, 'button');
  assert.equal(operations[0].match.text, label);
  assert.equal(operations[1].input, 'Reviewed');
  assert.deepEqual(operations[2].attributes, ['aria-label']);
  await assert.rejects(dispatch('run', request({ recipeId: 'pick', inputs: { value: 'Reviewed' } })), { code: 'INVALID_INPUTS' });
});

test('ordered field verification accepts only a bounded array of strings', () => {
  const recipe = {
    id: 'check-split', title: 'Check reviewed percentages',
    inputs: { split: { type: 'string' } },
    steps: [{ op: 'assertValues', selector: '.percent', input: 'split' }],
  };
  validateRecipe(recipe, adapter);
  validateInputs(recipe, { split: '["60","40"]' });
  for (const split of ['60,40', '[]', '[60,40]', '{"first":"60"}']) {
    assert.throws(() => validateInputs(recipe, { split }), { code: 'INVALID_INPUTS' });
  }
});

test('a background-only adapter stops before injecting into an active tab', async () => {
  const tested = { ...adapter, backgroundOnly: true };
  validateCatalog([tested]);
  const { browser, operations, tabs } = mockBrowser();
  const dispatch = createDispatcher(browser, async () => [tested]);
  tabs[0].active = true;
  await assert.rejects(dispatch('run', request()), { code: 'ACTIVE_TAB' });
  assert.deepEqual(operations, []);
});

test('an active app page allows an in-place read without relaxing the background guard for navigation', async () => {
  const {browser,tabs,operations} = mockBrowser();
  tabs[0].active = true;
  tabs[0].url = adapter.origin + '/ticket';
  browser.tabs.update = async () => assert.fail('An in-place read navigated the tab');
  const recipe = {id:'summary',title:'Summary',effect:'read',steps:[
    {op:'navigate',path:'/ticket'},
    {op:'assert',target:'name'},
    {op:'read',target:'name',as:'summary'},
  ]};
  const a = {...adapter,backgroundOnly:true,recipes:[recipe]};
  const dispatch = createDispatcher(browser,async () => [a]);
  const args = {tabId:44,adapterId:a.id,recipeId:recipe.id};
  assert.equal((await dispatch('run',args)).outputs.summary,'Ticket');
  assert.deepEqual(operations.map(step=>step.op),['assert','read']);
  tabs[0].url = adapter.origin + '/other';
  await assert.rejects(dispatch('run',args),{code:'ACTIVE_TAB'});
});
