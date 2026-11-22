const maxItems = 100;
const retryStates = new Set(['pending', 'not-applied']);
const finishedStates = new Set(['complete', 'skipped']);
const transitions = {
  begin: { pending: 'uncertain', 'not-applied': 'uncertain' },
  confirm: { uncertain: 'complete' },
  missing: { uncertain: 'not-applied' },
  skip: { pending: 'skipped', uncertain: 'skipped', 'not-applied': 'skipped' },
};

export function mappedItemInput(item, property, index) {
  if (property === '$index') return String(index + 1);
  if (!property) return item;
  if (item == null || !Object.hasOwn(item, property)) throw new Error(`A write item is missing ${property}.`);
  return item[property];
}

export function writeItems(list, repeat) {
  if (!Array.isArray(list) || list.length > maxItems) throw new Error(`Expected a list of up to ${maxItems} write items.`);
  return list.map((item, index) => {
    const label = repeat.label ? mappedItemInput(item, repeat.label, index) : undefined;
    return {
      raw: item,
      value: mappedItemInput(item, repeat.value, index),
      label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 200) : `Item ${index + 1}`,
    };
  });
}

export function mapItemInputs(mapping, item, index) {
  return Object.fromEntries(Object.entries(mapping).map(([key, property]) => [key, mappedItemInput(item, property, index)]));
}

export function newCheckpoint(runId, count) {
  return { runId, status: Array.from({ length: count }, () => 'pending') };
}

export function currentItem(checkpoint) {
  return checkpoint.status.findIndex(status => !finishedStates.has(status));
}

export function canWrite(status) {
  return retryStates.has(status);
}

export function updateCheckpoint(checkpoint, index, action) {
  const status = transitions[action]?.[checkpoint.status[index]];
  if (currentItem(checkpoint) !== index || !status) throw new Error('This item changed. Review the current checkpoint.');
  const next = [...checkpoint.status];
  next[index] = status;
  return { ...checkpoint, status: next };
}

export function checkpointSummary(checkpoint) {
  return { items: checkpoint.status.map((status, index) => ({ item: index + 1, status })) };
}
