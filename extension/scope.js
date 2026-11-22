import { RecipeError } from './schema.js';
import { hasOrigin } from './access.js';

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

export async function boundAccount(browser, target, adapter) {
  if (!adapter.identity) return null;
  const key = bindingKey(adapter);
  const saved = await browser.storage.local.get(key);
  if (saved[key]) return saved[key];
  const [{result}] = await browser.scripting.executeScript({
    target,
    func:({identity,origin}) => {
      if (location.origin !== origin) return null;
      const elements = [...document.querySelectorAll(identity.selector)].filter(element =>
        element.getClientRects().length && getComputedStyle(element).visibility === 'visible');
      if (elements.length !== 1 || elements[0].matches('input,textarea,[contenteditable]')) return null;
      const value = (identity.attribute ? elements[0].getAttribute(identity.attribute) : elements[0].innerText)?.trim();
      return value && value.length <= 512 ? value : null;
    },
    args:[{identity:adapter.identity,origin:adapter.frame?.origin ?? adapter.origin}],
  });
  if (!result) throw new RecipeError('ACCOUNT_UNAVAILABLE','The app did not show an unambiguous account identity.');
  // A single lock also covers concurrent first runs in different tabs.
  return navigator.locks.request(key, async () => {
    const current = (await browser.storage.local.get(key))[key];
    if (current) return current;
    await browser.storage.local.set({[key]:result});
    return result;
  });
}

export function bindingKey(adapter) {
  return 'account:' + adapter.origin + ':' + (adapter.frame?.origin ?? '') + ':' + adapter.id;
}
