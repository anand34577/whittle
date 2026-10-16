/** Per-person data goes to the server, and nothing is written to the browser (October 2026 audit follow-up). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteStored, listStored, readStored, setStorageMode, writeStored } from "../src/state/stored";

const calls: { url: string; method: string; body?: string }[] = [];

function fakeServer() {
  const data = new Map<string, string>();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body as string | undefined });
    const key = decodeURIComponent(url.split("/me/data/")[1] ?? "");
    if (url.includes("/me/data?")) return new Response(JSON.stringify([...data.keys()].map((k) => ({ key: k, updatedAt: 1 }))), { status: 200 });
    if (method === "PUT") {
      data.set(key, init.body as string);
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE") {
      data.delete(key);
      return new Response(null, { status: 204 });
    }
    return data.has(key) ? new Response(data.get(key), { status: 200 }) : new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  });
}

afterEach(() => {
  calls.length = 0;
  setStorageMode("pending");
  vi.unstubAllGlobals();
});

describe("stored data on a server", () => {
  it("is read, written, listed and deleted through the API, never in local storage", async () => {
    const local = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), key: vi.fn(), length: 0 };
    vi.stubGlobal("localStorage", local);
    fakeServer();
    setStorageMode("remote");
    expect(await readStored("ai")).toBeNull();
    await writeStored("ai", { providers: [{ apiKey: "sk-secret" }] });
    expect(await readStored("ai")).toEqual({ providers: [{ apiKey: "sk-secret" }] });
    expect((await listStored("a")).map((e) => e.key)).toEqual(["ai"]);
    await deleteStored("ai");
    expect(await readStored("ai")).toBeNull();
    expect(local.setItem).not.toHaveBeenCalled();
    expect(local.getItem).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === "PUT")).toBe(true);
  });

  it("changes made in quick succession are sent once", async () => {
    fakeServer();
    setStorageMode("remote");
    const a = writeStored("prefs", { n: 1 }, 20);
    const b = writeStored("prefs", { n: 2 }, 20);
    await Promise.race([b, new Promise((r) => setTimeout(r, 200))]);
    void a;
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toBe(JSON.stringify({ n: 2 }));
  });

  it("saves nothing before it is known where data lives", async () => {
    fakeServer();
    const local = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), key: vi.fn(), length: 0 };
    vi.stubGlobal("localStorage", local);
    await writeStored("ai", { x: 1 });
    expect(calls).toHaveLength(0);
    expect(local.setItem).not.toHaveBeenCalled();
  });
});
