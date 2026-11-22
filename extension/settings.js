import {operationOrigins} from './scope.js';
import {hasOrigin} from './access.js';
import {roleAdapters, unpackCatalog, validateBundle} from './workflow.js';
import {assertConnectorSharingAllowed} from './connector.js';

const bundled = fetch(chrome.runtime.getURL('catalog.json')).then(response => response.json()).then(unpackCatalog);

async function installedBundle(localCatalog) {
  const local = unpackCatalog(localCatalog === undefined ? (await chrome.storage.local.get('localCatalog')).localCatalog ?? [] : localCatalog);
  const defaults = await bundled;
  return validateBundle({
    adapters:[...defaults.adapters,...local.adapters],
    workflows:[...defaults.workflows,...local.workflows],
  });
}

export async function getCatalog(localCatalog) {
  return (await installedBundle(localCatalog)).adapters;
}

export async function getWorkflows() {
  return (await installedBundle()).workflows;
}

export async function assertWorkflowModelAccess(workflow, step, results) {
  const bundle = await installedBundle();
  const current = bundle.workflows.find(item => item.id === workflow.id);
  if (JSON.stringify(current) !== JSON.stringify(workflow)) throw new Error('The workflow changed. Reload it before sharing data.');
  const sources = new Set();
  function collect(item) {
    if (sources.has(item.id)) return;
    sources.add(item.id);
    const refs = Object.values(item.inputs ?? {});
    if (item.repeat) refs.push(item.repeat.items);
    for (const ref of refs) collect(workflow.steps.find(s => s.id === ref.split('.')[0]));
  }
  collect(step);
  await assertConnectorSharingAllowed(new Set(workflow.steps
    .filter(item => sources.has(item.id) && item.op === 'connector')
    .map(item => item.connector)));
  const {blockedModelOrigins = []} = await chrome.storage.local.get('blockedModelOrigins');
  for (const item of workflow.steps.filter(s => sources.has(s.id) && s.op === 'recipe')) {
    const role = workflow.tabs[item.tab];
    const recorded = results?.get(item.id)?.audit?.adapterId;
    const candidates = roleAdapters(role);
    if (recorded && !candidates.includes(recorded)) throw new Error('Saved results belong to an unknown adapter.');
    for (const id of recorded ? [recorded] : candidates) {
      for (const origin of operationOrigins(bundle.adapters.find(adapter => adapter.id === id))) {
        if (blockedModelOrigins.includes(origin) || !await hasOrigin(chrome,origin)) throw new Error('This workflow needs permission to include data from ' + origin + ' in an AI prompt. Check Site access in Settings.');
      }
    }
  }
}
