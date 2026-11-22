// Model replies can replace existing scalar fields and remove list entries.
// Array indices always refer to the original data, even when several rows are removed.
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
const file = value => value && typeof value === 'object' && Object.hasOwn(value, 'base64');

export function promptView(value) {
  if (file(value)) return '[attachment omitted]';
  if (Array.isArray(value)) return value.map(promptView);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, promptView(child)]));
  }
  return value;
}

export function proposeEdits(original, edits) {
  if (!Array.isArray(edits) || edits.length > 1000) throw new Error('Expected a list of up to 1000 edits.');
  const value = structuredClone(original);
  const removals = new Map();
  const paths = new Set();
  for (const edit of edits) {
    const path = edit?.path;
    if (!Array.isArray(path) || !path.length || path.length > 40) throw new Error('Invalid edit path.');
    const signature = JSON.stringify(path);
    if (paths.has(signature)) throw new Error('The reply edits a field twice.');
    paths.add(signature);
    let parent = value;
    for (const [position, key] of path.entries()) {
      if (!parent || typeof parent !== 'object' || file(parent) || unsafe.has(key) ||
          (Array.isArray(parent) ? !Number.isSafeInteger(key) || key < 0 : typeof key !== 'string') ||
          !Object.hasOwn(parent, key)) throw new Error('The reply references an unavailable field.');
      if (position < path.length - 1) { parent = parent[key]; continue; }
      if (edit.op === 'remove' && Array.isArray(parent)) {
        if (!removals.has(parent)) removals.set(parent, []);
        removals.get(parent).push(key);
      } else if (edit.op === 'replace' && ['string','number','boolean'].includes(typeof parent[key]) &&
          typeof parent[key] === typeof edit.value) {
        parent[key] = edit.value;
      } else throw new Error('Only scalar replacements and removal of list items are supported.');
    }
  }
  for (const [array, indexes] of removals) {
    for (const index of indexes.sort((a,b) => b-a)) array.splice(index, 1);
  }
  return value;
}
