/** The worker handle recovers from a dead or stuck engine (October 2026 audit, D-01 and G-02). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { newDocument } from "@whittle/core";
import { WorkerKernel } from "../src/client";

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: unknown) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  terminated = false;
  posted: unknown[] = [];
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: unknown) {
    this.posted.push(m);
  }
  terminate() {
    this.terminated = true;
  }
}

afterEach(() => {
  FakeWorker.all = [];
  vi.unstubAllGlobals();
});

describe("WorkerKernel", () => {
  it("fails in-flight work when the engine dies, then starts a new engine on the next request", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const k = new WorkerKernel();
    const first = k.regen(newDocument());
    FakeWorker.all[0]!.onerror!({ message: "out of memory" });
    await expect(first).rejects.toThrow("out of memory");
    expect(FakeWorker.all).toHaveLength(1);
    void k.regen(newDocument());
    expect(FakeWorker.all).toHaveLength(2);
    expect(FakeWorker.all[1]!.posted).toHaveLength(1);
  });

  it("cancel stops the old engine, fails its request and starts a fresh one", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const k = new WorkerKernel();
    const run = k.regen(newDocument());
    k.cancel();
    await expect(run).rejects.toThrow("Cancelled.");
    expect(FakeWorker.all[0]!.terminated).toBe(true);
    expect(FakeWorker.all).toHaveLength(2);
  });

  it("a request that never answers restarts the engine", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
    const k = new WorkerKernel();
    const run = k.inspect(newDocument(), "interference" as never);
    const caught = run.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    expect(await caught).toMatch(/taking too long/);
    expect(FakeWorker.all).toHaveLength(2);
    vi.useRealTimers();
  });
});
