import {originOf, RecipeError} from './schema.js';
import {adapterGranted, assertSiteOperation, boundAccount, canReadActiveTab, frameTarget, withinPaths} from './scope.js';
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
async function inspectApp(browser, adapter, tab, identity, recipe) {
  if (adapter.backgroundOnly && tab.active && !canReadActiveTab(adapter,recipe,tab)) fail('ACTIVE_TAB', 'Return to the run in another tab before resuming this background-only adapter.');
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
  await boundAccount(browser, target, adapter, {verify:true,identity});
  return false;
}

export async function resolveConnection(browser, adapters, role, tabId, recipe) {
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
  const needsAuth = tabState(adapter, tab) !== 'app' || await inspectApp(browser, adapter, tab, undefined, recipe);
  return {adapterId:adapter.id, tabId:tab.id, needsAuth};
}

function recipePage(tab, entryPath, accountPrefix) {
  if (!entryPath) return true;
  let path = new URL(tab.pendingUrl || tab.url).pathname;
  if (accountPrefix && path.startsWith(accountPrefix)) {
    const parts = path.slice(accountPrefix.length).split('/');
    parts.shift();
    path = accountPrefix.slice(0,-1).replace(/[^/]+$/,'') + parts.join('/');
  }
  return path === entryPath || path.startsWith(entryPath.replace(/\/$/,'')+'/');
}

export async function findRecipeTab(browser, adapter, recipe, tabId) {
  await approved(browser,adapter);
  const existing = tabId == null ? null : await getTab(browser,tabId);
  if (existing) {
    return findAccountTab(browser,adapter,undefined,tabId,undefined,undefined,recipe);
  }
  const windowTabs = await browser.tabs.query({lastFocusedWindow:true});
  const candidates = windowTabs.filter(tab => tabState(adapter,tab) === 'app' &&
    (!adapter.backgroundOnly || !tab.active || canReadActiveTab(adapter,recipe,tab)) && !tab.pendingUrl && tab.status !== 'loading' &&
    recipePage(tab,recipe.entryPath,recipe.accountPrefix));
  candidates.sort((a,b) => Number(b.active)-Number(a.active) ||
    (b.lastAccessed ?? 0)-(a.lastAccessed ?? 0) || a.id-b.id);
  for (const tab of candidates) {
    try {
      if (!await inspectApp(browser,adapter,tab,undefined,recipe)) return {adapterId:adapter.id,tabId:tab.id};
    } catch (error) {
      if (!['ACCOUNT_CHANGED','ACCOUNT_UNAVAILABLE','FRAME_UNAVAILABLE'].includes(error.code)) throw error;
    }
  }
  const path = recipe.entryPath ?? adapter.auth?.entryPath ?? adapter.paths?.[0] ?? '/';
  const windowId = windowTabs[0]?.windowId;
  const tab = await browser.tabs.create({url:new URL(path,adapter.origin).href,active:false,
    ...(Number.isInteger(windowId) ? {windowId} : {})});
  return waitForAccount(browser,adapter,undefined,tab.id);
}

// A labeled run may only inspect tabs for its approved adapter. Keep the chosen tab across handoffs.
export async function findAccountTab(browser, adapter, identity, tabId, entryPath, accountPrefix, recipe) {
  await approved(browser,adapter);
  const matchesPage = tab => recipePage(tab,entryPath,accountPrefix);
  const existing = tabId == null ? null : await getTab(browser,tabId);
  const tabs = existing ? [existing] : (await browser.tabs.query({})).filter(t =>
    tabState(adapter,t) === 'app' && matchesPage(t) && !t.active).sort((a,b) => a.id-b.id);
  let handoff;
  for (const tab of tabs) {
    const state = tabState(adapter,tab);
    const connection = {adapterId:adapter.id,tabId:tab.id};
    if (state === 'auth' || state === 'unknown') return {...connection,needsAuth:true};
    if (state !== 'app') fail('ORIGIN_CHANGED','The account tab left the approved app.');
    if (tab.active && (identity || adapter.backgroundOnly && !canReadActiveTab(adapter,recipe,tab))) return {...connection,needsBackground:true};
    try {
      if (!await inspectApp(browser,adapter,tab,identity,recipe)) {
        if (!matchesPage(tab)) {
          await browser.tabs.update(tab.id,{url:new URL(entryPath,adapter.origin).href});
          return await waitForAccount(browser,adapter,identity,tab.id);
        }
        return connection;
      }
    } catch (error) {
      if (!['ACCOUNT_CHANGED','ACCOUNT_UNAVAILABLE'].includes(error.code)) throw error;
      if (!existing && error.code === 'ACCOUNT_CHANGED') continue;
    }
    handoff ??= {...connection,needsAuth:true};
  }
  if (handoff) return handoff;
  const path = entryPath ?? adapter.auth?.entryPath ?? adapter.paths?.[0] ?? '/';
  const tab = await browser.tabs.create({url:new URL(path,adapter.origin).href,active:false});
  return await waitForAccount(browser,adapter,identity,tab.id);
}

async function waitForAccount(browser,adapter,identity,id) {
  const until = Date.now()+8000;
  let tab;
  do {
    tab = await getTab(browser,id);
    if (!tab) fail('TAB_CLOSED','The new account tab was closed.');
    if (tab.status !== 'loading' && !tab.pendingUrl && tabState(adapter,tab) !== 'unknown') break;
    await new Promise(resolve=>setTimeout(resolve,100));
  } while (Date.now()<until);
  // A redirect to a recognized sign-in page can be handed off without inspecting it.
  return findAccountTab(browser,adapter,identity,id);
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
