/**
 * Where per-person data lives (preferences, AI assistant settings with their keys, crash-recovery drafts).
 * On a Whittle server it is kept in the server's database and nothing is written to the browser.
 * Only the standalone web app and the desktop app, which have no server, fall back to this device's local storage.
 */
import { ApiError, api, apiJson } from "./platform";

type Mode = "pending" | "local" | "remote";
let mode: Mode = "pending";

/** Set once the platform is known. Until then nothing is saved anywhere. */
export function setStorageMode(m: Mode) {
  mode = m;
}

export const storesOnServer = () => mode === "remote";

const localKey = (key: string) => `whittle.${key.replace(/:/g, ".")}`;

/*
 * Without a server, crash-recovery drafts go to IndexedDB, not localStorage: a design with an embedded
 * import or picture is far over localStorage's ~5 MB, and IndexedDB keeps the time each draft was written.
 * Drafts an older version left in localStorage are still read (and removed when replaced).
 */
const isDraft = (key: string) => key.startsWith("draft:");
const IDB = "whittle-data";
const IDB_STORE = "drafts";
interface IdbRow {
  key: string;
  value: unknown;
  updatedAt: number;
}

function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(IDB, 1);
    } catch (e) {
      return reject(e);
    }
    req.onupgradeneeded = () => void req.result.createObjectStore(IDB_STORE, { keyPath: "key" });
    req.onerror = () => reject(req.error ?? new Error("Browser storage is unavailable"));
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction(IDB_STORE, mode);
        const r = run(tx.objectStore(IDB_STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(r.result);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error("Browser storage is unavailable"));
        };
      } catch (e) {
        db.close();
        reject(e);
      }
    };
  });
}

function removeLocal(key: string) {
  try {
    localStorage.removeItem(localKey(key));
  } catch {
    /* storage may be unavailable */
  }
}

export async function readStored<T>(key: string): Promise<T | null> {
  if (mode === "remote") {
    try {
      return await apiJson<T>(`/me/data/${encodeURIComponent(key)}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }
  if (mode === "pending") return null;
  if (isDraft(key)) {
    const row = await idb<IdbRow | undefined>("readonly", (st) => st.get(key)).catch(() => undefined);
    if (row) return row.value as T;
  }
  try {
    const raw = localStorage.getItem(localKey(key));
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Resolvers of writes replaced by a newer one before they were sent. */
const superseded = new Map<string, () => void>();

/** Save a value. On the server, quick successive changes are sent once. Rejects if it could not be kept. */
export function writeStored(key: string, value: unknown, delayMs = 0): Promise<void> {
  if (mode === "pending") return Promise.resolve();
  if (mode === "local") {
    if (isDraft(key)) {
      return idb("readwrite", (st) => st.put({ key, value, updatedAt: Date.now() } satisfies IdbRow)).then(() => removeLocal(key));
    }
    try {
      localStorage.setItem(localKey(key), JSON.stringify(value));
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }
  clearTimeout(timers.get(key));
  superseded.get(key)?.();
  return new Promise<void>((resolve, reject) => {
    superseded.set(key, resolve);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        superseded.delete(key);
        api(`/me/data/${encodeURIComponent(key)}`, { method: "PUT", json: value }).then(() => resolve(), reject);
      }, delayMs),
    );
  });
}

export async function deleteStored(key: string): Promise<void> {
  clearTimeout(timers.get(key));
  timers.delete(key);
  // A write still waiting to be sent is dropped: let whoever awaits it carry on.
  superseded.get(key)?.();
  superseded.delete(key);
  if (mode === "remote") {
    await api(`/me/data/${encodeURIComponent(key)}`, { method: "DELETE" }).catch(() => {});
    return;
  }
  if (mode === "local") {
    if (isDraft(key)) await idb("readwrite", (st) => st.delete(key)).catch(() => {});
    removeLocal(key);
  }
}

/** Keys starting with `prefix`, newest first. */
export async function listStored(prefix: string): Promise<{ key: string; updatedAt: number }[]> {
  if (mode === "remote") return apiJson(`/me/data?prefix=${encodeURIComponent(prefix)}`);
  if (mode === "pending") return [];
  const out: { key: string; updatedAt: number }[] = [];
  if (isDraft(prefix)) {
    const rows = await idb<IdbRow[]>("readonly", (st) => st.getAll()).catch(() => [] as IdbRow[]);
    for (const r of rows) if (r.key.startsWith(prefix)) out.push({ key: r.key, updatedAt: r.updatedAt });
  }
  try {
    const want = localKey(prefix);
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(want)) continue;
      const key = prefix + k.slice(want.length).replace(/^\./, "");
      if (out.some((o) => o.key === key)) continue;
      // localStorage keeps no time: use the draft's own `at` when it has one.
      let updatedAt = 0;
      try {
        updatedAt = Date.parse((JSON.parse(localStorage.getItem(k) ?? "null") as { at?: string } | null)?.at ?? "") || 0;
      } catch {
        /* not JSON */
      }
      out.push({ key, updatedAt });
    }
  } catch {
    /* storage may be unavailable */
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Move data an earlier version kept in this browser onto the server, then forget the browser copy. */
export async function adoptBrowserCopy(key: string): Promise<void> {
  if (mode !== "remote") return;
  try {
    const raw = localStorage.getItem(localKey(key));
    if (raw === null) return;
    if ((await readStored(key)) === null) await writeStored(key, JSON.parse(raw));
    localStorage.removeItem(localKey(key));
  } catch {
    /* nothing to adopt, or storage unavailable */
  }
}
