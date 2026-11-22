import { hasOrigin } from './access.js';
import { originOf, RecipeError } from './schema.js';

const lifetime = 5 * 60 * 1000;
const limit = 30;
const keyFor = tabId => `browser-recipes-observer-${tabId}`;
const invalid = () => new RecipeError('RECORDER_UNAVAILABLE', 'Choose an approved top-level tab and enable developer tools.');
const selectorPattern = /^body(?: > [a-z][a-z0-9-]*:nth-of-type\([1-9][0-9]*\))+$/;

export function observedRecipe(events) {
  const inputs = Object.create(null);
  let fields = 0;
  const steps = [];
  for (const event of events.slice(0, limit)) {
    if (!['click', 'fill'].includes(event.op) || !selectorPattern.test(event.selector) || event.selector.length > 512) continue;
    const step = { op: event.op, selector: event.selector };
    if (event.op === 'fill') {
      step.input = `field-${++fields}`;
      inputs[step.input] = { type: 'string', required: true };
    }
    steps.push(step);
  }
  return { id: 'recorded-draft', title: 'Recorded draft', ...(fields ? { inputs } : {}), steps };
}

// Serialized by Chrome into the selected document's isolated extension world.
function observe({ origin, token, ttl, activate }) {
  if (location.origin !== origin) return false;
  globalThis.browserRecipesObserver?.abort();
  delete globalThis.browserRecipesObserver;
  if (!activate) return true;
  const observer = new AbortController();
  globalThis.browserRecipesObserver = observer;
  setTimeout(() => observer.abort(), ttl);
  const options = { capture: true, signal: observer.signal };
  const fieldSelector = 'input,textarea,select,[contenteditable]';
  const secret = 'input[type="password"],input[type="hidden"],input[autocomplete*="password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]';

  function selector(element) {
    const parts = ['body'];
    const parents = [];
    for (let cursor = element; cursor && cursor !== document.body; cursor = cursor.parentElement) {
      if (!cursor.parentElement || !/^[a-z][a-z0-9-]*$/.test(cursor.localName)) return;
      const peers = [...cursor.parentElement.children].filter(peer => peer.localName === cursor.localName);
      parents.unshift(`${cursor.localName}:nth-of-type(${peers.indexOf(cursor) + 1})`);
    }
    parts.push(...parents);
    const target = parts.join(' > ');
    if (parents.length && target.length <= 512) return target;
  }

  function send(op, target) {
    const targetSelector = selector(target);
    if (!targetSelector || target.matches(secret) || target.closest('form')?.querySelector(secret)) return;
    // Values, visible text, titles, labels, and URLs never enter the event.
    void chrome.runtime.sendMessage({ command: 'dev.record.event', token, op, selector: targetSelector })
      .then(response => { if (response?.keep !== true) observer.abort(); })
      .catch(() => observer.abort());
  }

  document.addEventListener('click', event => {
    if (!event.isTrusted || !(event.target instanceof Element) || event.button !== 0) return;
    const target = event.target.closest('button,a[href],[role="button"],[role="link"],input[type="submit"],input[type="checkbox"],input[type="radio"]');
    if (target) send('click', target);
  }, options);
  document.addEventListener('change', event => {
    const target = event.target;
    if (!event.isTrusted || !(target instanceof HTMLElement) || !target.matches(fieldSelector)) return;
    if (target instanceof HTMLInputElement && !['text', 'search', 'email', 'url', 'tel', 'number', 'date', 'datetime-local', 'time', 'month', 'week'].includes(target.type)) return;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) send('fill', target);
  }, options);
  return true;
}

export function developerObserver(browser, loadCatalog, lock = (key, task) => navigator.locks.request(key, task)) {
  async function enabled() {
    return (await browser.storage.local.get('devMode')).devMode === true;
  }

  async function target(args, topLevelOnly = true) {
    if (!Number.isSafeInteger(args?.tabId) || args.tabId < 0 || !await enabled()) throw invalid();
    const adapter = (await loadCatalog()).find(item => item.id === args.adapterId);
    if (!adapter || topLevelOnly && adapter.frame || !await hasOrigin(browser, adapter.origin)) throw invalid();
    const tab = await browser.tabs.get(args.tabId).catch(() => null);
    if (!tab || originOf(tab.pendingUrl || tab.url) !== adapter.origin || tab.pendingUrl) throw invalid();
    return { tab, origin: adapter.origin };
  }

  async function disarm(tabId, session) {
    await browser.scripting.executeScript({
      target: { tabId },
      func: observe,
      args: [{ origin: session.origin, activate: false }],
    }).catch(() => {});
  }

  async function start(args) {
    const { tab, origin } = await target(args);
    const key = keyFor(tab.id);
    return await lock(key, async () => {
      const previous = (await browser.storage.session.get(key))[key];
      if (previous && previous.expiry > Date.now()) throw new RecipeError('RECORDER_BUSY', 'Stop the existing recording first.');
      const token = crypto.randomUUID();
      const session = { origin, token, adapterId: args.adapterId, events: [], expiry: Date.now() + lifetime };
      await browser.storage.session.set({ [key]: session });
      try {
        const frames = await browser.scripting.executeScript({
          target: { tabId: tab.id },
          func: observe,
          args: [{ origin, token, ttl: lifetime, activate: true }],
        });
        if (!frames[0]?.result) throw invalid();
        await browser.storage.session.set({ [key]: { ...session, documentId: frames[0].documentId } });
      } catch {
        await browser.storage.session.remove(key);
        throw invalid();
      }
      return { recording: true, maxActions: limit };
    });
  }

  async function event(message, sender) {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId) || sender.frameId !== 0 || !['click', 'fill'].includes(message.op) ||
        typeof message.selector !== 'string' || message.selector.length > 512 || !selectorPattern.test(message.selector)) return { keep: false };
    const key = keyFor(tabId);
    return await lock(key, async () => {
      const session = (await browser.storage.session.get(key))[key];
      if (!session || session.expiry <= Date.now() || session.token !== message.token ||
          session.documentId !== sender.documentId || originOf(sender.url) !== session.origin ||
          !await enabled() || !await hasOrigin(browser, session.origin)) return { keep: false };
      if (session.events.length >= limit) return { keep: false };
      session.events.push({ op: message.op, selector: message.selector });
      await browser.storage.session.set({ [key]: session });
      return { keep: session.events.length < limit };
    });
  }

  async function stop(args) {
    if (!Number.isSafeInteger(args?.tabId) || !await enabled()) throw invalid();
    const key = keyFor(args.tabId);
    return await lock(key, async () => {
      const session = (await browser.storage.session.get(key))[key];
      if (!session || session.adapterId !== args.adapterId || !await hasOrigin(browser, session.origin)) throw invalid();
      await browser.storage.session.remove(key);
      await disarm(args.tabId, session);
      return { recipe: observedRecipe(session.events), count: session.events.length };
    });
  }

  async function capture(args) {
    const { tab, origin } = await target(args, false);
    if (!tab.active) throw new RecipeError('ACTIVE_TAB_REQUIRED', 'Keep the selected site tab active and open Recipes from the toolbar.');
    let changed = false;
    const onActivated = info => {
      if (info.windowId === tab.windowId && info.tabId !== tab.id) changed = true;
    };
    const onUpdated = (tabId, change) => {
      if (tabId === tab.id && (change.url || change.status === 'loading')) changed = true;
    };
    const onRemoved = tabId => {
      if (tabId === tab.id) changed = true;
    };
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
    try {
      const before = await browser.tabs.get(tab.id);
      if (!before.active || before.pendingUrl || originOf(before.url) !== origin || changed) throw invalid();
      const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 75 }).catch(() => {
        throw new RecipeError('CAPTURE_UNAVAILABLE', 'Open Recipes from the toolbar on the active site tab to authorize capture.');
      });
      const after = await browser.tabs.get(tab.id);
      if (!after.active || after.pendingUrl || originOf(after.url) !== origin || changed || !await enabled() ||
          !await hasOrigin(browser, origin)) throw invalid();
      return { dataUrl };
    } finally {
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
    }
  }

  async function revoke() {
    const sessions = await browser.storage.session.get(null);
    for (const [key, session] of Object.entries(sessions)) {
      if (!key.startsWith('browser-recipes-observer-')) continue;
      if (await enabled() && await hasOrigin(browser, session.origin)) continue;
      const tabId = Number(key.slice('browser-recipes-observer-'.length));
      await lock(key, async () => {
        await browser.storage.session.remove(key);
        await disarm(tabId, session);
      });
    }
  }

  return { start, event, stop, capture, revoke };
}
