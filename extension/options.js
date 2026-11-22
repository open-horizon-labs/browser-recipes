import { hasOrigin } from './access.js';
import { getCatalog } from './settings.js';
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
  for (const { origin, title } of await getCatalog()) {
    if (!sites.has(origin)) sites.set(origin, []);
    sites.get(origin).push(title);
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
    item.append(label, button);
    origins.append(item);
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
    const updated = approvedOrigins.filter(origin => installed.some(adapter => adapter.origin === origin));
    await chrome.storage.local.set({ localCatalog, approvedOrigins: updated });
    const retainedPatterns = new Set(updated.map(originPattern));
    const removedPatterns = [...new Set(approvedOrigins.map(originPattern))].filter(pattern => !retainedPatterns.has(pattern));
    if (removedPatterns.length) await chrome.permissions.remove({ origins: removedPatterns });
    await renderOrigins();
    show('Catalog saved.');
  } catch (error) {
    if (error instanceof RecipeError) show(error.message);
    else if (error instanceof SyntaxError) show('Enter a valid JSON array.');
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
    bridgeStatus.textContent = message;
  } catch {
    bridgeStatus.textContent = 'Could not read bridge status.';
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
  await Promise.all([renderOrigins(), renderBridge(true)]);
  setInterval(() => void renderBridge(), 3000);
}

initialize().catch(() => show('Could not load settings.'));
