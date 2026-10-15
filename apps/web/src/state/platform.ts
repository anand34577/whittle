import { confirmDialog } from "./dialogs";

/**
 * Where Whittle is running, and the small set of things that differ:
 *
 *   desktop  Tauri app: native dialogs, files on disk, local version history.
 *   server   served by whittle-server: accounts (optional) and designs stored on the server.
 *   browser  any static host: files via the browser, version history in IndexedDB.
 */

export interface ServerConfig {
  version: string;
  auth: "none" | "required";
  local: boolean;
  oidc: string | null;
  signup: boolean;
  needsSetup: boolean;
  maxUploadBytes: number;
  maxVersions: number;
  /** "Forgot password?" is available (email is set up). */
  passwordReset: boolean;
  requireEmail: boolean;
  /** The AI assistant is allowed (servers can turn it off). */
  ai?: boolean;
}

export interface ServerUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  isAdmin: boolean;
  disabled: boolean;
  hasPassword: boolean;
  sso: boolean;
  /** Waiting to be linked to single sign-on by email. */
  ssoLink: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

export type Platform =
  | { kind: "browser" }
  | { kind: "desktop" }
  | { kind: "server"; config: ServerConfig; user: ServerUser | null };

/* ───────────────────────────── Desktop (Tauri) ───────────────────────────── */

interface TauriGlobal {
  core: { invoke<T>(cmd: string, args?: unknown, options?: { headers?: Record<string, string> }): Promise<T> };
  event: { listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<() => void> };
}

export function tauri(): TauriGlobal | null {
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

export function invoke<T>(cmd: string, args?: unknown, options?: { headers?: Record<string, string> }): Promise<T> {
  const t = tauri();
  if (!t) return Promise.reject(new Error("Not running in the desktop app"));
  return t.core.invoke<T>(cmd, args, options).catch((e: unknown) => {
    throw e instanceof Error ? e : new Error(String(e));
  });
}

/* ───────────────────────────── Server API ───────────────────────────── */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Called when the server says the session ended (set by the store). */
export const apiHooks: { unauthorized: (() => void) | null } = { unauthorized: null };

/** Fetch an API path. Throws ApiError with the server's message on failure. */
export async function api(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Whittle", "1");
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(`./api${path}`, { ...init, headers, body, credentials: "same-origin" });
  } catch {
    throw new ApiError("Can't reach the Whittle server. Check your connection.", 0);
  }
  if (!res.ok) {
    let msg = `The server answered ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* not JSON */
    }
    if (res.status === 401 && !path.startsWith("/auth/")) apiHooks.unauthorized?.();
    throw new ApiError(msg, res.status);
  }
  return res;
}

export async function apiJson<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const res = await api(path, init);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/* ───────────────────────────── Detection ───────────────────────────── */

/** Work out where we are running. Never throws. */
export async function detectPlatform(): Promise<Platform> {
  if (tauri()) return { kind: "desktop" };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch("./api/config", { signal: ctrl.signal, credentials: "same-origin" });
    clearTimeout(timer);
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.includes("json")) return { kind: "browser" };
    const config = (await res.json()) as ServerConfig;
    let user: ServerUser | null = null;
    const me = await fetch("./api/auth/me", { credentials: "same-origin" });
    if (me.ok) user = (await me.json()) as ServerUser;
    return { kind: "server", config, user };
  } catch {
    return { kind: "browser" };
  }
}

/** Yes/no question in Whittle's own dialog (the same on desktop, server and browser). */
export function ask(opts: { title: string; message: string; confirmLabel?: string; danger?: boolean; details?: string[] }): Promise<boolean> {
  return confirmDialog(opts);
}
