const inlineLimit = 256 * 1024;
const orphanGrace = 10 * 60 * 1000;
const sweepInterval = 60 * 1000;
const sweepLimit = 32;

function createSpill(indexedDB) {
  let opened;
  function database() {
    opened ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('browser-recipes-run-data', 1);
      request.onupgradeneeded = () => {
        const entries = request.result.createObjectStore('entries');
        entries.createIndex('created', ['created', 'token']);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(error => {
      opened = undefined;
      throw error;
    });
    return opened;
  }

  async function operation(mode, perform) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('entries', mode);
      const request = perform(tx.objectStore('entries'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
    });
  }

  return {
    put: (id, value) => operation('readwrite', store => store.put(value, id)),
    get: id => operation('readonly', store => store.get(id)),
    delete: id => operation('readwrite', store => store.delete(id)),
    async oldEntries(cutoff, after) {
      const db = await database();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('entries');
        const ceiling = [cutoff, []];
        const range = after ? IDBKeyRange.bound(after, ceiling, true) : IDBKeyRange.upperBound(ceiling);
        const request = tx.objectStore('entries').index('created').openKeyCursor(range);
        const entries = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          entries.push({ id: cursor.primaryKey, cursor: cursor.key });
          if (entries.length < sweepLimit) cursor.continue();
        };
        tx.oncomplete = () => resolve(entries);
        tx.onabort = () => reject(tx.error);
      });
    },
  };
}

function pointer(value) {
  return value?.runDataSpill === 1 ? value : undefined;
}

function quotaExceeded(error) {
  return error?.name === 'QuotaExceededError' || /quota/i.test(error?.message ?? '');
}

// Chrome keeps the key in trusted session storage. Durable storage holds only
// ciphertext, whose key and browser-session access disappear on browser restart.
export function createRunDataStore(browser, { spill = globalThis.indexedDB && createSpill(globalThis.indexedDB), now = Date.now } = {}) {
  const { session } = browser.storage;
  if (!spill) return session;
  let lastSweep = -Infinity;
  let sweepCursor;

  async function sweep() {
    const time = now();
    if (time - lastSweep < sweepInterval) return;
    lastSweep = time;
    const entries = await spill.oldEntries(time - orphanGrace, sweepCursor);
    for (const { id } of entries) {
      const [key, token] = id;
      const current = pointer((await session.get(key))[key]);
      if (current?.token !== token) await spill.delete(id);
    }
    sweepCursor = entries.length === sweepLimit ? entries.at(-1).cursor : undefined;
  }

  function removeSpill(key, previous) {
    if (previous) void spill.delete([key, previous.token]).catch(() => {});
  }

  async function setOne(key, value) {
    const previous = pointer((await session.get(key))[key]);
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    if (encoded.byteLength <= inlineLimit) {
      try {
        await session.set({ [key]: value });
        removeSpill(key, previous);
        return;
      } catch (error) {
        if (!quotaExceeded(error)) throw error;
      }
    }

    const token = crypto.randomUUID();
    const id = [key, token];
    const keyMaterial = crypto.getRandomValues(new Uint8Array(32));
    const cipherKey = await crypto.subtle.importKey('raw', keyMaterial, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cipherKey, encoded);
    await spill.put(id, { iv, ciphertext, created: now(), token });
    try {
      await session.set({ [key]: { runDataSpill: 1, token, keyMaterial: [...keyMaterial] } });
    } catch (error) {
      await spill.delete(id).catch(() => {});
      throw error;
    }
    removeSpill(key, previous);
  }

  return {
    async get(key) {
      // A concurrent checkpoint can replace the pointer before its ciphertext is read.
      for (let retry = 0; retry < 2; retry++) {
        const found = await session.get(key);
        const current = pointer(found[key]);
        if (!current) return found;
        const saved = await spill.get([key, current.token]);
        if (!saved) continue;
        const cipherKey = await crypto.subtle.importKey('raw', Uint8Array.from(current.keyMaterial), 'AES-GCM', false, ['decrypt']);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: saved.iv }, cipherKey, saved.ciphertext);
        return { [key]: JSON.parse(new TextDecoder().decode(plain)) };
      }
      return {};
    },
    async set(entries) {
      await sweep().catch(() => {});
      for (const [key, value] of Object.entries(entries)) await setOne(key, value);
    },
    async remove(key) {
      const previous = pointer((await session.get(key))[key]);
      await session.remove(key);
      removeSpill(key, previous);
    },
  };
}
