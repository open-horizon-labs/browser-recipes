// Catalog packages are a transport format. Installed definitions have independent keys.
import {unpackCatalog, validateBundle, roleAdapters} from './workflow.js';

const names = ['adapters', 'recipes', 'workflows'];
let database;
function open() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('browser-recipes-library', 1);
    request.onupgradeneeded = () => {
      for (const name of names) request.result.createObjectStore(name);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
  return database;
}
function finished(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('The library update was interrupted.'));
  });
}
async function records() {
  const tx = (await open()).transaction(names);
  const reads = names.map(name => new Promise((resolve, reject) => {
    const req = tx.objectStore(name).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const [adapters, recipes, workflows] = await Promise.all(reads);
  return {adapters:adapters.map(adapter => ({...adapter, recipes:recipes.filter(row => row.adapterId === adapter.id).sort((a,b) => a.position - b.position).map(row => row.recipe)})), workflows};
}
function rows(bundle) {
  return {
    adapters:bundle.adapters.map(({recipes, ...adapter}) => [adapter.id, adapter]),
    recipes:bundle.adapters.flatMap(a => a.recipes.map((recipe,position) => [[a.id, recipe.id], {adapterId:a.id, recipe, position}])),
    workflows:bundle.workflows.map(w => [w.id, w]),
  };
}
async function persist(before, after) {
  const prev = rows(before), next = rows(after);
  const tx = (await open()).transaction(names, 'readwrite');
  const done = finished(tx);
  for (const name of names) {
    const store = tx.objectStore(name);
    const previous = new Map(prev[name].map(([key,value]) => [JSON.stringify(key), JSON.stringify(value)]));
    for (const [key,value] of next[name]) {
      const id = JSON.stringify(key);
      if (previous.get(id) !== JSON.stringify(value)) store.put(value, key);
      previous.delete(id);
    }
    for (const id of previous.keys()) store.delete(JSON.parse(id));
  }
  await done;
}
export function mergeDefinitions(current, incoming) {
  const merge = (items, updates) => [...new Map([...items,...updates].map(item => [item.id,item])).values()];
  return {
    adapters:merge(current.adapters, incoming.adapters.map(adapter => ({
      ...adapter, recipes:merge(current.adapters.find(a => a.id === adapter.id)?.recipes ?? [],adapter.recipes),
    }))),
    workflows:merge(current.workflows,incoming.workflows),
  };
}
export function combined(defaults, local) {
  return validateBundle({adapters:[...defaults.adapters,...local.adapters], workflows:[...defaults.workflows,...local.workflows]});
}
async function migrate(defaults) {
  const {localCatalog} = await chrome.storage.local.get('localCatalog');
  let saved = await records();
  if (localCatalog !== undefined) {
    const old = unpackCatalog(localCatalog);
    combined(defaults,old);
    const migrated = mergeDefinitions(saved,old);
    combined(defaults,migrated);
    await persist(saved,migrated);
    await chrome.storage.local.remove('localCatalog');
    saved = migrated;
  }
  return saved;
}
export async function localDefinitions(defaults) {
  if ((await chrome.storage.local.get('localCatalog')).localCatalog === undefined) return records();
  return navigator.locks.request('installed-definitions', () => migrate(defaults));
}
export async function updateDefinitions(defaults, change, afterCommit) {
  return navigator.locks.request('installed-definitions', async () => {
    const before = await migrate(defaults);
    const after = change(before);
    const installed = combined(defaults,after);
    await persist(before,after);
    await afterCommit(installed);
    return installed;
  });
}
export function removeDefinition(local, all, kind, id, adapterId) {
  const users = all.workflows.filter(w => kind === 'adapter'
    ? Object.values(w.tabs).some(role => roleAdapters(role).includes(id))
    : kind === 'recipe' && w.steps.some(s => s.op === 'recipe' && s.recipeId === id && roleAdapters(w.tabs[s.tab]).includes(adapterId)));
  if (users.length) throw new Error('Used by ' + users.map(w => w.title).join(', ') + '. Remove or update those workflows first.');
  if (kind === 'workflow') return {...local, workflows:local.workflows.filter(w => w.id !== id)};
  if (kind === 'adapter') return {...local, adapters:local.adapters.filter(a => a.id !== id)};
  return {...local, adapters:local.adapters.map(a => a.id === adapterId ? {...a, recipes:a.recipes.filter(r => r.id !== id)} : a)};
}
