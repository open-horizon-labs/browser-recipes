import { companionAgentRequest, companionPermission, companionSetting } from './chatgpt-agent-transport.js';
import { bindingKey, operationKey, operationOrigins, siteOperations } from './scope.js';
import { hasOrigin } from './access.js';
import { getCatalog, getWorkflows } from './settings.js';
import { RecipeError, originPattern } from './schema.js';

const origins = document.querySelector('#origins');
const catalog = document.querySelector('#catalog');
const status = document.querySelector('#status');
const bridge = document.querySelector('#bridge');
const bridgeStatus = document.querySelector('#bridge-status');
const dev = document.querySelector('#dev');
const saveButton = document.querySelector('#save');
let changingOrigin = false;

function show(message) {
  status.textContent = message;
}

async function renderOrigins() {
  origins.replaceChildren();
  const sites = new Map();
  const adapters = await getCatalog();
  for (const adapter of adapters) {
    for (const origin of operationOrigins(adapter)) {
      if (!sites.has(origin)) sites.set(origin, []);
      sites.get(origin).push(adapter.title);
    }
  }
  if (sites.size === 0) {
    const empty = document.createElement('li');
    empty.textContent = 'Install an adapter to grant its site access.';
    origins.append(empty);
    return;
  }
  for (const [origin, titles] of sites) {
    const granted = await hasOrigin(chrome, origin);
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${origin} · ${titles.join(', ')}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = granted ? 'Revoke access' : 'Grant access';
    button.setAttribute('aria-label', `${button.textContent} for ${origin}`);
    button.addEventListener('click', () => void changeOrigin(origin, granted));
    const aiLabel = document.createElement('label');
    const ai = document.createElement('input');
    ai.type = 'checkbox';
    const settingKey = 'blockedModelOrigins';
    const {blockedModelOrigins = []} = await chrome.storage.local.get(settingKey);
    ai.checked = !blockedModelOrigins.includes(origin);
    ai.setAttribute('aria-label', 'Use data from ' + origin + ' in AI prompts');
    ai.addEventListener('change', async () => {
      const state = await chrome.storage.local.get(settingKey);
      const blocked = new Set(state[settingKey] ?? []);
      if (ai.checked) blocked.delete(origin);
      else blocked.add(origin);
      await chrome.storage.local.set({[settingKey]: [...blocked]});
      show('AI prompt permission saved.');
    });
    aiLabel.append(ai, ' Use data from this site in AI prompts');
    const access = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Allowed operations';
    access.append(summary, aiLabel);
    for (const [op,title] of Object.entries(siteOperations)) {
      const key = operationKey(origin,op);
      const setting = document.createElement('label');
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = (await chrome.storage.local.get(key))[key] !== false;
      toggle.addEventListener('change',async () => {
        await chrome.storage.local.set({[key]:toggle.checked});
        show('Site operation setting saved.');
      });
      setting.append(toggle, ' ' + title);
      access.append(setting);
    }
    item.append(label, button, access);
    for (const adapter of adapters.filter(a => a.origin === origin && a.identity)) {
      const key = bindingKey(adapter);
      const bound = (await chrome.storage.local.get(key))[key];
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.textContent = bound ? 'Forget account (' + bound + ')' : 'Account will be checked on first use';
      reset.disabled = !bound;
      reset.addEventListener('click', async () => {
        await chrome.storage.local.remove(key);
        await renderOrigins();
      });
      const expectedLabel = document.createElement('label');
      expectedLabel.textContent = adapter.title + ' expected account';
      const expected = document.createElement('input');
      expected.type = adapter.identity.format === 'email' ? 'email' : 'text';
      expected.maxLength = 512;
      expected.value = bound ?? '';
      expectedLabel.append(expected);
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.textContent = 'Set expected account';
      pin.addEventListener('click', async () => {
        let value = expected.value.trim();
        if (!value || !expected.reportValidity()) {
          show('Enter the exact account identifier displayed by the app.');
          return;
        }
        if (adapter.identity.format === 'email') value = value.toLowerCase();
        await navigator.locks.request(key, () => chrome.storage.local.set({[key]:value}));
        await renderOrigins();
        show('Expected account saved.');
      });
      access.append(expectedLabel, pin, reset);
    }
    origins.append(item);
  }
}

async function renderSources() {
  const list = document.querySelector('#sources');
  const { connectors = {} } = await chrome.storage.local.get('connectors');
  const workflows = await getWorkflows();
  const ids = [...new Set([
    ...Object.keys(connectors),
    ...workflows.flatMap(workflow => workflow.steps.filter(step => step.op === 'connector').map(step => step.connector)),
  ])].sort();
  list.replaceChildren();
  if (!ids.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No installed workflow uses a local data source.';
    list.append(empty);
    return;
  }
  for (const id of ids) {
    const current = Object.hasOwn(connectors, id) ? connectors[id] : {};
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = id;
    const enable = document.createElement('input');
    const share = document.createElement('input');
    enable.type = share.type = 'checkbox';
    enable.checked = current.enabled === true;
    share.checked = enable.checked && current.share === true;
    share.disabled = !enable.checked;
    const enableLabel = document.createElement('label');
    const shareLabel = document.createElement('label');
    enableLabel.append(enable, ' Enable ' + id);
    shareLabel.append(share, ' Use data from ' + id + ' in AI prompts');
    async function save() {
      if (!enable.checked) share.checked = false;
      share.disabled = !enable.checked;
      const { connectors = {} } = await chrome.storage.local.get('connectors');
      await chrome.storage.local.set({
        connectors: { ...connectors, [id]: { enabled: enable.checked, share: share.checked } },
      });
      show('Local data source setting saved.');
    }
    for (const checkbox of [enable, share]) checkbox.addEventListener('change', () => {
      void save().catch(() => show('Could not save the local data source setting.'));
    });
    row.append(name, enableLabel, shareLabel);
    list.append(row);
  }
}

async function changeOrigin(origin, granted) {
  if (changingOrigin) return;
  changingOrigin = true;
  try {
    const pattern = originPattern(origin);
    // Call permissions.request synchronously inside the user's click.
    if (!granted && !await chrome.permissions.request({ origins: [pattern] })) {
      show('Site access was declined.');
      return;
    }
    const { approvedOrigins = [] } = await chrome.storage.local.get('approvedOrigins');
    const updated = granted ? approvedOrigins.filter(entry => entry !== origin) : [...new Set([...approvedOrigins, origin])];
    await chrome.storage.local.set({ approvedOrigins: updated });
    if (granted && !updated.some(entry => originPattern(entry) === pattern)) {
      await chrome.permissions.remove({ origins: [pattern] });
    }
    await renderOrigins();
    show(granted ? 'Site access revoked.' : 'Site access granted.');
  } catch {
    show('Could not change site access.');
  } finally {
    changingOrigin = false;
  }
}

saveButton.addEventListener('click', async () => {
  try {
    const localCatalog = JSON.parse(catalog.value);
    const installed = await getCatalog(localCatalog);
    // Remove grants for origins no longer represented in the installed catalog.
    const { approvedOrigins = [] } = await chrome.storage.local.get('approvedOrigins');
    const updated = approvedOrigins.filter(origin => installed.some(adapter => operationOrigins(adapter).includes(origin)));
    await chrome.storage.local.set({ localCatalog, approvedOrigins: updated });
    const retainedPatterns = new Set(updated.map(originPattern));
    const removedPatterns = [...new Set(approvedOrigins.map(originPattern))].filter(pattern => !retainedPatterns.has(pattern));
    if (removedPatterns.length) await chrome.permissions.remove({ origins: removedPatterns });
    await Promise.all([renderOrigins(), renderSources()]);
    show('Catalog saved.');
  } catch (error) {
    if (error instanceof RecipeError) show(error.message);
    else if (error instanceof SyntaxError) show('Enter valid catalog JSON.');
    else show('Could not save the catalog.');
  }
});

document.querySelector('#catalog-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 2000000) {
    show('Select a catalog smaller than 2 MB.');
    return;
  }
  try {
    catalog.value = await file.text();
    show('Review the catalog, then choose Save catalog.');
  } catch {
    show('Could not read the catalog file.');
  }
});

async function renderBridge(refresh = false) {
  try {
    const { status: message } = await chrome.runtime.sendMessage({ command: refresh ? 'bridge.refresh' : 'bridge.status' });
    const descriptions = {
      Disabled: 'Terminal access is off.',
      Connecting: 'Connecting to the command-line helper…',
      'Bridge open': 'Waiting for a terminal command.',
      Connected: 'Terminal access is connected.',
      'Native host unavailable': 'Command-line helper unavailable. Check that it is installed for this browser profile.',
      'Native host disconnected': 'Command-line helper disconnected.',
    };
    bridgeStatus.textContent = descriptions[message] ?? 'Terminal connection status unknown.';
  } catch {
    bridgeStatus.textContent = 'Could not check the terminal connection.';
  }
}

bridge.addEventListener('change', async () => {
  await chrome.storage.local.set({ bridgeEnabled: bridge.checked });
  await renderBridge(true);
  setTimeout(() => void renderBridge(), 1000);
});
dev.addEventListener('change', async () => {
  await chrome.storage.local.set({ devMode: dev.checked });
  show(dev.checked ? 'Developer tools enabled.' : 'Developer tools disabled.');
});

async function initialize() {
  const { localCatalog = [], devMode = false, bridgeEnabled = false } = await chrome.storage.local.get(null);
  catalog.value = JSON.stringify(localCatalog, null, 2);
  dev.checked = devMode;
  bridge.checked = bridgeEnabled;
  await Promise.all([renderOrigins(), renderSources(), renderBridge(true)]);
  setInterval(() => void renderBridge(), 3000);
}

initialize().catch(() => show('Could not load settings.'));

const companionForm = document.querySelector('#companion-form');
const companionCode = document.querySelector('#companion-code');
const companionStatus = document.querySelector('#companion-status');
const companionSave = document.querySelector('#companion-save');
const companionRemove = document.querySelector('#companion-remove');

async function showCompanion() {
  const paired = Boolean((await chrome.storage.local.get(companionSetting))[companionSetting]);
  companionCode.value = '';
  companionRemove.disabled = !paired;
  companionStatus.textContent = paired ? 'Local ChatGPT helper paired.' : '';
}

companionForm.addEventListener('submit', async event => {
  event.preventDefault();
  const code = companionCode.value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
    companionStatus.textContent = 'Use the pairing code printed by the running local ChatGPT helper.';
    return;
  }
  companionSave.disabled = true;
  companionRemove.disabled = true;
  try {
    if (!await chrome.permissions.request(companionPermission)) throw new Error('Local helper permission was declined.');
    const status = await companionAgentRequest(code, 'status');
    if (typeof status?.connected !== 'boolean') throw new Error('The local helper returned an invalid session status.');
    await chrome.storage.local.set({ [companionSetting]: code });
    await showCompanion();
  } catch (error) {
    companionRemove.disabled = !(await chrome.storage.local.get(companionSetting))[companionSetting];
    companionStatus.textContent = error.message;
  } finally {
    companionSave.disabled = false;
  }
});

companionRemove.addEventListener('click', async () => {
  await chrome.storage.local.remove(companionSetting);
  await showCompanion();
  companionStatus.textContent = 'Local pairing removed.';
});

void showCompanion().catch(() => { companionStatus.textContent = 'Could not read local helper pairing.'; });
