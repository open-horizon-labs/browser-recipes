import { validateCatalog } from './schema.js';

const bundled = fetch(chrome.runtime.getURL('catalog.json')).then(response => response.json()).then(validateCatalog);

export async function getCatalog(localCatalog) {
  const installed = localCatalog === undefined ? ((await chrome.storage.local.get('localCatalog')).localCatalog ?? []) : localCatalog;
  return validateCatalog([...(await bundled), ...validateCatalog(installed)]);
}
