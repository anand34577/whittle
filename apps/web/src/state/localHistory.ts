/**
 * Version history for the browser build: every save keeps a copy in
 * IndexedDB, keyed by the document's id. (The desktop app keeps history on
 * disk, the server in its own storage.)
 */

const DB = "whittle";
const STORE = "versions";
/** Copies kept per design. */
const KEEP = 30;

export interface LocalVersion {
  key?: number;
  docId: string;
  name: string;
  at: number;
  bytes: Uint8Array;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: "key", autoIncrement: true });
      s.createIndex("docId", "docId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Browser storage is unavailable"));
  });
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listLocalVersions(docId: string): Promise<LocalVersion[]> {
  const db = await open();
  try {
    const all = await done(db.transaction(STORE).objectStore(STORE).index("docId").getAll(docId) as IDBRequest<LocalVersion[]>);
    return all.sort((a, b) => b.at - a.at);
  } finally {
    db.close();
  }
}

export async function addLocalVersion(v: Omit<LocalVersion, "key">): Promise<void> {
  const db = await open();
  try {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    await done(store.add(v));
    const keys = (await done(store.index("docId").getAll(v.docId) as IDBRequest<LocalVersion[]>)).sort((a, b) => b.at - a.at).slice(KEEP);
    for (const k of keys) store.delete(k.key!);
  } finally {
    db.close();
  }
}
