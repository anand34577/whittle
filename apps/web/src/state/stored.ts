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
  if (mode === "remote") {
    await api(`/me/data/${encodeURIComponent(key)}`, { method: "DELETE" }).catch(() => {});
    return;
  }
  if (mode === "local") {
    try {
      localStorage.removeItem(localKey(key));
    } catch {
      /* storage may be unavailable */
    }
  }
}

/** Keys starting with `prefix`, newest first. */
export async function listStored(prefix: string): Promise<{ key: string; updatedAt: number }[]> {
  if (mode === "remote") return apiJson(`/me/data?prefix=${encodeURIComponent(prefix)}`);
  if (mode === "pending") return [];
  const out: { key: string; updatedAt: number }[] = [];
  try {
    const want = localKey(prefix);
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(want)) out.push({ key: prefix + k.slice(want.length).replace(/^\./, ""), updatedAt: 0 });
    }
  } catch {
    /* storage may be unavailable */
  }
  return out;
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
