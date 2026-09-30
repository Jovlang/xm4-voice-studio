// Tiny IndexedDB key/value store so Sony files and uploaded sounds survive reloads.
const DB = "xm4-voice-studio";
const STORE = "files";

let dbPromise: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

/**
 * Ask the browser not to evict our data (Sony's packs, uploaded sounds) under storage pressure.
 * Best-effort storage can be cleared silently; persisted storage is only cleared by the user.
 */
export async function persist(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    return (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch {
    return false;
  }
}

export const get = (key: string) => tx<Uint8Array | undefined>("readonly", (s) => s.get(key));
export const set = (key: string, value: Uint8Array) => tx("readwrite", (s) => s.put(value, key));
export const del = (key: string) => tx("readwrite", (s) => s.delete(key));
export const keys = () => tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys()).then((k) => k.map(String));
