import { originPattern } from './schema.js';

export async function hasOrigin(browser, origin) {
  const { approvedOrigins = [] } = await browser.storage.local.get('approvedOrigins');
  return approvedOrigins.includes(origin) &&
    await browser.permissions.contains({ origins: [originPattern(origin)] });
}

export async function grantSites(origins) {
  const patterns = [...new Set(origins.map(originPattern))];
  if (!await chrome.permissions.request({origins:patterns})) return false;
  await navigator.locks.request('approved-origins', async () => {
    const {approvedOrigins = []} = await chrome.storage.local.get('approvedOrigins');
    await chrome.storage.local.set({approvedOrigins:[...new Set([...approvedOrigins,...origins])]});
  });
  return true;
}
