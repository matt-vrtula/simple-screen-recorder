// Recordings live in the extension's IndexedDB, so the player tab can open them independently of
// the recorder tab. "meta" holds the small record shown in lists, "data" the video and the logs.
const RecordingsDB = (() => {
  let dbPromise;

  function open() {
    dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('screen-recorder', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('meta', { keyPath: 'id' });
        req.result.createObjectStore('data', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  const done = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

  const result = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return {
    async save(meta, data) {
      const tx = (await open()).transaction(['meta', 'data'], 'readwrite');
      tx.objectStore('meta').put(meta);
      tx.objectStore('data').put({ id: meta.id, ...data });
      await done(tx);
    },

    async list() {
      const all = await result((await open()).transaction('meta').objectStore('meta').getAll());
      return all.sort((a, b) => b.createdAt - a.createdAt);
    },

    async get(id) {
      const tx = (await open()).transaction(['meta', 'data']);
      const [meta, data] = await Promise.all([
        result(tx.objectStore('meta').get(id)),
        result(tx.objectStore('data').get(id)),
      ]);
      return meta && data ? { ...data, meta } : null;
    },

    async remove(id) {
      const tx = (await open()).transaction(['meta', 'data'], 'readwrite');
      tx.objectStore('meta').delete(id);
      tx.objectStore('data').delete(id);
      await done(tx);
    },
  };
})();
