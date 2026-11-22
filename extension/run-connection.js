import {originOf, RecipeError} from './schema.js';
import {adapterGranted, assertSiteOperation, boundAccount, frameTarget, withinPaths} from './scope.js';
import {roleAdapters} from './workflow.js';

const fail = (code, message) => { throw new RecipeError(code, message); };

function tabState(adapter, tab) {
  const url = tab.pendingUrl || tab.url;
  if (!url) return 'unknown';
  const origin = originOf(url);
  if (adapter.auth?.origins?.includes(origin)) return 'auth';
  if (origin !== adapter.origin) return 'other';
  const path = new URL(url).pathname;
  if (adapter.auth?.paths && withinPaths(path, adapter.auth.paths)) return 'auth';
  return withinPaths(path, adapter.paths) ? 'app' : 'other';
}

async function getTab(browser, id) {
  try { return await browser.tabs.get(id); }
  catch (error) {
    if (/no tab with id|invalid tab id|tab (?:was )?closed/i.test(error.message)) return null;
    throw error;
  }
}

async function approved(browser, adapter) {
  if (!await adapterGranted(browser, adapter)) {
    fail('PERMISSION_REQUIRED', 'Grant the app access in Browser Recipes settings.');
  }
}

// This check runs only on approved app documents, never on a sign-in provider.
async function inspectApp(browser, adapter, tab) {
  if (adapter.backgroundOnly && tab.active) fail('ACTIVE_TAB', 'Return to the run in another tab before resuming this background-only adapter.');
  if (!adapter.identity && !adapter.auth?.signedOutSelector) return false;
  await assertSiteOperation(browser, adapter, 'read');
  if (adapter.auth?.signedOutSelector) {
    const [{result}] = await browser.scripting.executeScript({
      target: {tabId: tab.id},
      func: (url, selector) => location.href === url &&
        [...document.querySelectorAll(selector)].some(node => node.checkVisibility()),
      args: [tab.url, adapter.auth.signedOutSelector],
    });
    if (result) return true;
  }
  if (!adapter.identity) return false;
  const target = await frameTarget(browser, tab.id, adapter);
  await boundAccount(browser, target, adapter, {verify:true});
  return false;
}

export async function resolveConnection(browser, adapters, role, tabId) {
  const candidates = roleAdapters(role).map(id => adapters.find(item => item.id === id));
  if (!candidates.length || candidates.some(item => !item)) fail('ADAPTER_NOT_FOUND', 'Install the adapter for this connection.');
  const granted = [];
  for (const adapter of candidates) if (await adapterGranted(browser, adapter)) granted.push(adapter);
  if (!granted.length) fail('PERMISSION_REQUIRED', 'Grant the app access in Browser Recipes settings.');
  const missing = {adapterId:granted[0].id, tabId:null, needsAuth:false, missingTab:true};
  let tab;
  let adapter;
  if (tabId != null) {
    if (!Number.isInteger(tabId) || tabId < 0) fail('INVALID_INPUTS', 'Choose a valid browser tab.');
    tab = await getTab(browser, tabId);
    if (!tab) return missing;
    adapter = granted.find(a => tabState(a, tab) === 'app');
    if (!adapter) {
      const authMatches = granted.filter(a => tabState(a, tab) === 'auth');
      // Two apps can share an identity provider. Start from an approved app entry
      // rather than binding an unrecognized provider tab to an arbitrary realm.
      if (authMatches.length > 1) return missing;
      [adapter] = authMatches;
    }
    if (!adapter && tabState(granted[0], tab) === 'unknown') return {...missing, tabId:tab.id};
    if (!adapter) fail('ORIGIN_CHANGED', 'The selected tab is outside the configured app and sign-in locations.');
  } else {
    const matches = (await browser.tabs.query({})).flatMap(t => {
      const a = granted.find(item => ['app', 'auth'].includes(tabState(item, t)) &&
        originOf(t.pendingUrl || t.url) === item.origin);
      return a ? [{tab:t, adapter:a}] : [];
    });
    if (!matches.length) return missing;
    if (matches.length > 1) fail('TAB_REQUIRED', 'Choose which app tab to use for this run.');
    ({tab, adapter} = matches[0]);
  }
  const needsAuth = tabState(adapter, tab) !== 'app' || await inspectApp(browser, adapter, tab);
  return {adapterId:adapter.id, tabId:tab.id, needsAuth};
}

// The message dispatcher restricts this to an explicit action on the extension page.
export async function showConnection(browser, adapter, tabId) {
  await approved(browser, adapter);
  let tab = tabId == null ? null : await getTab(browser, tabId);
  const state = tab && tabState(adapter, tab);
  if (state === 'other') fail('ORIGIN_CHANGED', 'The selected tab is outside this app’s sign-in locations.');
  if (!tab || state === 'unknown') {
    const path = adapter.auth?.entryPath ?? adapter.paths?.[0] ?? '/';
    tab = await browser.tabs.create({url:new URL(path, adapter.origin).href, active:true});
  } else {
    tab = await browser.tabs.update(tab.id, {active:true});
  }
  if (Number.isInteger(tab.windowId)) await browser.windows.update(tab.windowId, {focused:true});
  return tab.id;
}
