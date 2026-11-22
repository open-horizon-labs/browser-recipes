import { executeDom } from './dom.js';
import { RecipeError } from './schema.js';
import { hasOrigin } from './access.js';

// A read can use the foreground page if every step leaves the page unchanged.
export function canReadActiveTab(adapter, recipe, tab) {
  if (!recipe || !tab.url || adapter.identity?.reveal || adapter.frame ||
      recipe.effect === 'write' || recipe.calendarRange) return false;
  return recipe.steps.every(step =>
    ['assert','assertValue','assertValues','read','readValue','readList'].includes(step.op) ||
    (step.op === 'navigate' && !step.under && !step.query &&
      new URL(step.path,adapter.origin).href === tab.url));
}

export function operationOrigins(adapter) {
  return [...new Set([adapter.origin, adapter.frame?.origin].filter(Boolean))];
}

export async function adapterGranted(browser, adapter) {
  return (await Promise.all(operationOrigins(adapter).map(origin => hasOrigin(browser, origin)))).every(Boolean);
}

export function withinPaths(pathname, paths) {
  if (!paths) return true;
  return !/%(?:25|2e|2f|5c|00)/i.test(pathname) && paths.some(path =>
    path.endsWith('/') ? pathname.startsWith(path) : pathname === path);
}

export async function frameTarget(browser, tabId, adapter) {
  if (!adapter.frame) return {tabId};
  // Enumerate only metadata in documents Chrome already grants to this extension.
  const frames = await browser.scripting.executeScript({
    target:{tabId,allFrames:true},
    func:() => ({origin:location.origin, pathname:location.pathname, parent:location.ancestorOrigins[0]}),
  });
  const matches = frames.filter(f => f.frameId !== 0 && f.documentId &&
    f.result?.origin === adapter.frame.origin && f.result?.parent === adapter.origin &&
    withinPaths(f.result.pathname,adapter.frame.paths));
  if (matches.length !== 1) throw new RecipeError('FRAME_UNAVAILABLE','Expected exactly one matching app frame on this tab.');
  return {tabId,documentIds:[matches[0].documentId]};
}

export async function boundAccount(browser, target, adapter, {verify = false, identity} = {}) {
  if (!adapter.identity) return null;
  if (adapter.identity.reveal) await assertSiteOperation(browser,adapter,'click');
  const key = bindingKey(adapter);
  const saved = await browser.storage.local.get(key);
  if (identity && !verify) return identity;
  if (saved[key] && !verify) return saved[key];
  const [{result}] = await browser.scripting.executeScript({
    target,
    func:executeDom,
    args:[{op:'identify',identity:adapter.identity,origin:adapter.frame?.origin ?? adapter.origin,paths:adapter.frame?.paths ?? adapter.paths}],
  });
  if (!result?.ok || !result.value) {
    const code = result?.code;
    if (code === 'ORIGIN_CHANGED' || code === 'PATH_NOT_ALLOWED') throw new RecipeError(code,'The app left the approved location.');
    throw new RecipeError('ACCOUNT_UNAVAILABLE','The app did not show an unambiguous account identity.');
  }
  function checked(value) {
    if (verify && value !== result.value) throw new RecipeError('ACCOUNT_CHANGED','The signed-in account differs from the account bound in Settings.');
    return value;
  }
  if (identity) return checked(identity);
  if (saved[key]) return checked(saved[key]);
  // A single lock also covers concurrent first runs in different tabs.
  return navigator.locks.request(key, async () => {
    const current = (await browser.storage.local.get(key))[key];
    if (current) return checked(current);
    await browser.storage.local.set({[key]:result.value});
    return result.value;
  });
}

export function bindingKey(adapter) {
  return 'account:' + adapter.origin + ':' + (adapter.frame?.origin ?? '') + ':' + adapter.id;
}

export const siteOperations = {
  navigate:'Navigate',
  read:'Read pages',
  write:'Change forms or click controls',
  documents:'Read documents and attachments',
};

export function operationKey(origin,operation) {
  return 'allow:' + origin + ':' + operation;
}

export async function assertSiteOperation(browser,adapter,op) {
  const group = op === 'navigate' ? 'navigate'
    : ['click','fill','attach'].includes(op) ? 'write'
    : ['readAttachment','document'].includes(op) ? 'documents' : 'read';
  for (const origin of operationOrigins(adapter)) {
    const key = operationKey(origin,group);
    if ((await browser.storage.local.get(key))[key] === false) {
      throw new RecipeError('OPERATION_DISABLED',siteOperations[group] + ' is disabled for ' + origin + ' in Settings.');
    }
  }
}
