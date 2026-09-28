// Remembers the last used list file handle in IndexedDB (handles can't go in localStorage).

const DB = 'cansin-veri';
const STORE = 'handles';
const KEY = 'last-list';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function saveLastHandle(handle: FileSystemFileHandle): Promise<void> {
  try {
    await tx('readwrite', (s) => s.put(handle, KEY));
  } catch {
    /* not critical */
  }
}

export async function loadLastHandle(): Promise<FileSystemFileHandle | null> {
  try {
    return ((await tx('readonly', (s) => s.get(KEY))) as FileSystemFileHandle | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function clearLastHandle(): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(KEY));
  } catch {
    /* ignore */
  }
}
