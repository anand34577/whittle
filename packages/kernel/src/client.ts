/** Main-thread handle to the kernel worker (the default KernelHost). */
import type { Id, WhittleDocument } from "@whittle/core";
import type { ExportFormat, InspectKind, InspectResult, KernelRequest, KernelResponse, MeshQuality, RegenResult } from "./protocol";

export interface KernelHost {
  readonly ready: Promise<number>;
  regen(doc: WhittleDocument, quality?: "preview" | "final", pickBefore?: Id, preview?: Id): Promise<RegenResult | null>;
  export(doc: WhittleDocument, format: ExportFormat, bodyIds?: Id[], quality?: MeshQuality): Promise<{ data: Uint8Array; mime: string; ext: string }>;
  inspect(doc: WhittleDocument, kind: InspectKind): Promise<InspectResult>;
  dispose(): void;
  /** Stops a long operation by restarting the engine. */
  cancel?(): void;
}

/** How long one request may run before the engine is judged stuck and restarted. */
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export class WorkerKernel implements KernelHost {
  private worker!: Worker;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void; regen: boolean; timer: ReturnType<typeof setTimeout> }>();
  private crashed = false;
  /** Import file contents the current engine already holds, so they aren't copied over again on every rebuild. */
  private sentImports = new Map<Id, string>();
  ready!: Promise<number>;
  /** Progress of the rebuild in flight: timeline steps finished out of the total. */
  onProgress: ((done: number, total: number) => void) | null = null;

  constructor() {
    this.spawn();
  }

  private spawn() {
    this.crashed = false;
    this.sentImports.clear();
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "whittle-kernel" });
    let onReady!: (ms: number) => void;
    let onFail!: (e: Error) => void;
    this.ready = new Promise<number>((res, rej) => {
      onReady = res;
      onFail = rej;
    });
    this.ready.catch(() => {}); // a crash is reported through the requests, not as an unhandled rejection
    const mine = this.worker;
    mine.onmessage = (ev: MessageEvent<KernelResponse>) => {
      const msg = ev.data;
      if (msg.type === "ready") return onReady(msg.ms);
      if (msg.type === "progress") return void (this.pending.has(msg.seq) && this.onProgress?.(msg.done, msg.total));
      if (msg.type === "error" && msg.seq === -1) return onFail(new Error(msg.message));
      const seq = msg.type === "regen" ? msg.result.seq : msg.seq;
      const p = this.pending.get(seq);
      if (!p) return;
      this.settle(seq);
      if (msg.type === "error") p.reject(new Error(msg.message));
      else if (msg.type === "regen" || msg.type === "inspect") p.resolve(msg.result as never);
      else p.resolve({ data: msg.data, mime: msg.mime, ext: msg.ext } as never);
    };
    mine.onerror = (e) => {
      if (mine !== this.worker) return;
      // The engine died (for example it ran out of memory). Nothing will answer the requests in flight, so fail them
      // instead of hanging; the next request starts a fresh engine.
      this.crashed = true;
      const err = new Error(e.message || "The geometry engine stopped (it may have run out of memory). It will restart on your next change.");
      onFail(err);
      this.failAll(err);
    };
  }

  private settle(seq: number) {
    const p = this.pending.get(seq);
    if (p) clearTimeout(p.timer);
    this.pending.delete(seq);
  }

  private failAll(err: Error) {
    for (const [seq, p] of [...this.pending]) {
      this.settle(seq);
      p.reject(err);
    }
  }

  /** Stop whatever the engine is doing and start a new one (the rebuild cache is lost). In-flight requests fail with `reason`. */
  restart(reason = "Cancelled."): void {
    this.worker.onerror = null;
    this.worker.terminate();
    this.failAll(new Error(reason));
    this.spawn();
  }

  /** Stop a long rebuild or export. */
  cancel(): void {
    this.restart("Cancelled.");
  }

  regen(doc: WhittleDocument, quality: "preview" | "final" = "final", pickBefore?: Id, preview?: Id): Promise<RegenResult | null> {
    const seq = ++this.seq;
    // Older regens that never answer (superseded) resolve to null.
    for (const [s, p] of [...this.pending]) {
      if (s < seq && p.regen) {
        this.settle(s);
        p.resolve(null as never);
      }
    }
    return this.send({ type: "regen", seq, doc, quality, pickBefore, preview }, true);
  }

  export(doc: WhittleDocument, format: ExportFormat, bodyIds?: Id[], quality?: MeshQuality) {
    return this.send<{ data: Uint8Array; mime: string; ext: string }>({ type: "export", seq: ++this.seq, doc, format, bodyIds, quality });
  }

  inspect(doc: WhittleDocument, kind: InspectKind) {
    return this.send<InspectResult>({ type: "inspect", seq: ++this.seq, doc, kind });
  }

  private send<T>(req: KernelRequest, regen = false): Promise<T> {
    if (this.crashed) this.spawn();
    if ("doc" in req) req = { ...req, doc: this.slim(req.doc) };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.restart("This is taking too long, so the geometry engine was restarted. Try a simpler change."), REQUEST_TIMEOUT_MS);
      this.pending.set(req.seq, { resolve: resolve as (v: never) => void, reject, regen, timer });
      this.worker.postMessage(req);
    });
  }

  /**
   * The document without the heavy parts the engine doesn't need to be sent again: reference pictures are never used by
   * geometry, and an embedded file (up to tens of MB of base64) is sent only the first time.
   */
  private slim(doc: WhittleDocument): WhittleDocument {
    let changed = false;
    const features = doc.features.map((f) => {
      if (f.type === "import") {
        if (f.data && this.sentImports.get(f.id) === f.data) {
          changed = true;
          return { ...f, data: "" };
        }
        this.sentImports.set(f.id, f.data);
      } else if (f.type === "sketch" && f.image?.src) {
        changed = true;
        return { ...f, image: { ...f.image, src: "" } };
      }
      return f;
    });
    return changed ? { ...doc, features } : doc;
  }

  dispose() {
    this.worker.onerror = null;
    this.worker.terminate();
    this.failAll(new Error("The geometry engine was closed."));
  }
}
