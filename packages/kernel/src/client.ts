/** Main-thread handle to the kernel worker (the default KernelHost). */
import type { Id, WhittleDocument } from "@whittle/core";
import type { ExportFormat, InspectKind, InspectResult, KernelRequest, KernelResponse, RegenResult } from "./protocol";

export interface KernelHost {
  readonly ready: Promise<number>;
  regen(doc: WhittleDocument, quality?: "preview" | "final", pickBefore?: Id): Promise<RegenResult | null>;
  export(doc: WhittleDocument, format: ExportFormat, bodyIds?: Id[]): Promise<{ data: Uint8Array; mime: string; ext: string }>;
  inspect(doc: WhittleDocument, kind: InspectKind): Promise<InspectResult>;
  dispose(): void;
}

export class WorkerKernel implements KernelHost {
  private worker: Worker;
  private seq = 0;
  private latestRegen = 0;
  private pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  readonly ready: Promise<number>;

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "whittle-kernel" });
    let onReady!: (ms: number) => void;
    let onFail!: (e: Error) => void;
    this.ready = new Promise<number>((res, rej) => {
      onReady = res;
      onFail = rej;
    });
    this.worker.onmessage = (ev: MessageEvent<KernelResponse>) => {
      const msg = ev.data;
      if (msg.type === "ready") return onReady(msg.ms);
      if (msg.type === "error" && msg.seq === -1) return onFail(new Error(msg.message));
      const seq = msg.type === "regen" ? msg.result.seq : msg.seq;
      const p = this.pending.get(seq);
      if (!p) return;
      this.pending.delete(seq);
      if (msg.type === "error") p.reject(new Error(msg.message));
      else if (msg.type === "regen" || msg.type === "inspect") p.resolve(msg.result as never);
      else p.resolve({ data: msg.data, mime: msg.mime, ext: msg.ext } as never);
    };
    this.worker.onerror = (e) => {
      const err = new Error(e.message || "The geometry engine crashed. Save your work and reload.");
      onFail(err);
      // Nothing will answer the requests in flight: fail them instead of hanging.
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  regen(doc: WhittleDocument, quality: "preview" | "final" = "final", pickBefore?: Id): Promise<RegenResult | null> {
    const seq = ++this.seq;
    this.latestRegen = seq;
    // Older regens that never answer (superseded) resolve to null.
    for (const [s, p] of this.pending) {
      if (s < seq && (p as unknown as { regen?: boolean }).regen) {
        this.pending.delete(s);
        p.resolve(null as never);
      }
    }
    return this.send({ type: "regen", seq, doc, quality, pickBefore }, true);
  }

  export(doc: WhittleDocument, format: ExportFormat, bodyIds?: Id[]) {
    return this.send<{ data: Uint8Array; mime: string; ext: string }>({ type: "export", seq: ++this.seq, doc, format, bodyIds });
  }

  inspect(doc: WhittleDocument, kind: InspectKind) {
    return this.send<InspectResult>({ type: "inspect", seq: ++this.seq, doc, kind });
  }

  private send<T>(req: KernelRequest, regen = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry = { resolve: resolve as (v: never) => void, reject, regen };
      this.pending.set(req.seq, entry);
      this.worker.postMessage(req);
    });
  }

  dispose() {
    this.worker.terminate();
  }
}