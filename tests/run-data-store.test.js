import assert from 'node:assert/strict';
import test from 'node:test';
import { createRunDataStore } from '../extension/run-data-store.js';

const key = 'run-data/test-run';
const privateData = { output: 'Private browser values. '.repeat(20_000) };

function harness() {
  const sessionRecords = new Map();
  const spillRecords = new Map();
  const controls = { time: 0, quotaForInline: false, quotaForPointers: false };
  const browser = { storage: { session: {
    async get(key) {
      return sessionRecords.has(key) ? { [key]: structuredClone(sessionRecords.get(key)) } : {};
    },
    async set(entries) {
      for (const [key, value] of Object.entries(entries)) {
        if (value?.runDataSpill ? controls.quotaForPointers : controls.quotaForInline) {
          throw new DOMException('Storage quota reached', 'QuotaExceededError');
        }
        sessionRecords.set(key, structuredClone(value));
      }
    },
    async remove(key) { sessionRecords.delete(key); },
  } } };
  const spill = {
    async get(id) {
      return structuredClone(spillRecords.get(JSON.stringify(id)));
    },
    async put(id, value) {
      spillRecords.set(JSON.stringify(id), structuredClone(value));
    },
    async delete(id) {
      spillRecords.delete(JSON.stringify(id));
    },
    async oldEntries(cutoff, after) {
      return [...spillRecords.entries()]
        .filter(([_id, value]) => value.created <= cutoff &&
          (!after || value.created > after[0] || value.created === after[0] && value.token > after[1]))
        .map(([id, { created, token }]) => ({ id: JSON.parse(id), cursor: [created, token] }))
        .sort((a, b) => a.cursor[0] - b.cursor[0] || a.cursor[1].localeCompare(b.cursor[1], 'en'))
        .slice(0, 32);
    },
  };
  const worker = () => createRunDataStore(browser, { spill, now: () => controls.time });
  return { worker, controls, sessionRecords, spillRecords };
}

test('small private run data stays in session storage', async () => {
  const { worker, spillRecords, sessionRecords } = harness();
  const store = worker();
  await store.set({ [key]: { output: 'small' } });
  assert.deepEqual(sessionRecords.get(key), { output: 'small' });
  assert.deepEqual(await store.get(key), { [key]: { output: 'small' } });
  assert.equal(spillRecords.size, 0);
});

test('large data survives worker restart and stores only ciphertext durably', async () => {
  const { worker, spillRecords, sessionRecords, controls } = harness();
  await worker().set({ [key]: privateData });
  assert.equal(sessionRecords.get(key).output, undefined);
  assert.equal(spillRecords.size, 1);
  const [{ ciphertext, iv, ...metadata }] = spillRecords.values();
  assert.ok(ciphertext instanceof ArrayBuffer);
  assert.ok(iv instanceof Uint8Array);
  assert.equal(iv.length, 12);
  assert.doesNotMatch(new TextDecoder().decode(ciphertext), /Private browser values/);
  assert.deepEqual(Object.keys(metadata).sort(), ['created', 'token']);
  assert.deepEqual(await worker().get(key), { [key]: privateData });

  // Browser restart discards the session key. The orphaned ciphertext is swept later.
  sessionRecords.clear();
  assert.deepEqual(await worker().get(key), {});
  controls.time += 11 * 60 * 1000;
  await worker().set({ 'run-data/new-run': { output: 'unrelated' } });
  assert.equal(spillRecords.size, 0);
});

test('falls back after an inline quota error and keeps the prior checkpoint if pointer commit fails', async () => {
  const { worker, spillRecords, sessionRecords, controls } = harness();
  const store = worker();
  const previous = { output: 'small but over remaining quota' };
  controls.quotaForInline = true;
  await store.set({ [key]: previous });
  assert.equal(sessionRecords.get(key).runDataSpill, 1);
  assert.equal(spillRecords.size, 1);

  controls.quotaForPointers = true;
  await assert.rejects(store.set({ [key]: privateData }), { name: 'QuotaExceededError' });
  assert.equal(spillRecords.size, 1);
  assert.deepEqual(await store.get(key), { [key]: previous });

  controls.quotaForInline = false;
  controls.quotaForPointers = false;
  await store.set({ [key]: { output: 'new' } });
  assert.deepEqual(await store.get(key), { [key]: { output: 'new' } });
  assert.equal(spillRecords.size, 0);
});

test('removing a retained run deletes its session pointer and stored ciphertext', async () => {
  const { worker, spillRecords } = harness();
  const store = worker();
  await store.set({ [key]: privateData });
  await store.remove(key);
  assert.deepEqual(await store.get(key), {});
  assert.equal(spillRecords.size, 0);
});
