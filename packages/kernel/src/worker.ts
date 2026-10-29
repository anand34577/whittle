/// <reference lib="webworker" />
/**
 * Kernel worker: owns OpenCascade (WASM). The UI thread never runs geometry,
 * so the interface stays smooth while heavy operations compute.
 */
import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import sansUrl from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff?url";
import boldUrl from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-700-normal.woff?url";
import { loadFont, setOC } from "replicad";
import gcsWasmUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import { Builder, isValidShape } from "./build";
import { isEngineAbort } from "./shared";
import { initSolver } from "./solver";
import { exportShapes } from "./exporters";
import { interference, minDistance, radii, textOutlines } from "./inspect";
import type { InspectResult, KernelRequest, KernelResponse } from "./protocol";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// The geometry library prints internal debug dumps when an operation fails.
// Failures already reach the user as friendly feature messages, so keep the
// console for real problems (an actual Error object still goes to the console).
const realError = console.error.bind(console);
console.error = (...args: unknown[]) => (args.some((a) => a instanceof Error) ? realError(...args) : console.debug("[kernel]", ...args));
const post = (msg: KernelResponse, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);

const builder = new Builder();
/** Embedded file contents received earlier; the UI thread sends them only once (see WorkerKernel.slim). */
const importData = new Map<string, string>();

function restoreImports(doc: KernelRequest extends { doc: infer D } ? D : never) {
  for (const f of doc.features) {
    if (f.type !== "import") continue;
    if (f.data) importData.set(f.id, f.data);
    else f.data = importData.get(f.id) ?? "";
  }
}
let latestRegen = 0;
const queue: KernelRequest[] = [];
let ready = false;

async function boot() {
  const t0 = performance.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = await (opencascade as any)({ locateFile: () => wasmUrl });
  setOC(oc);
  await initSolver(gcsWasmUrl);
  // Fonts for sketch text. Failing to load them only disables text.
  await Promise.all(
    [
      [sansUrl, "sans"],
      [boldUrl, "bold"],
    ].map(async ([url, name]) => {
      try {
        await loadFont(await (await fetch(url!)).arrayBuffer(), name);
      } catch {
        /* text entities will report the missing font */
      }
    }),
  );
  ready = true;
  post({ type: "ready", ms: performance.now() - t0 });
  drain();
}

function drain() {
  while (ready && queue.length) {
    const req = queue.shift()!;
    // Only the newest regen matters: drop superseded ones.
    if (req.type === "regen" && req.seq < latestRegen) continue;
    void handle(req);
  }
}

async function handle(req: KernelRequest) {
  try {
    if (req.type === "regen") {
      await builder.prepareImports(req.doc);
      if (req.seq < latestRegen) return;
      // Report how far a long rebuild has got (at most every 100 ms; the main thread keeps running meanwhile).
      let lastReport = 0;
      builder.onProgress = (done, total) => {
        const now = performance.now();
        if (done < total && now - lastReport < 100) return;
        lastReport = now;
        post({ type: "progress", seq: req.seq, done, total });
      };
      const r = builder.regen(req.doc, req.quality, req.pickBefore, req.preview);
      builder.onProgress = null;
      const transfer: Transferable[] = [];
      for (const b of [...r.bodies, ...(r.pickBodies ?? []), ...(r.ghost ? [r.ghost] : [])]) {
        transfer.push(b.positions.buffer, b.normals.buffer, b.indices.buffer, b.faceRanges.buffer, b.edgePositions.buffer, b.edgeRanges.buffer);
      }
      for (const s of r.sketches) if (s.fill) transfer.push(s.fill.buffer);
      post({ type: "regen", result: { ...r, seq: req.seq } }, transfer);
    } else if (req.type === "inspect" && req.kind === "text") {
      post({ type: "inspect", seq: req.seq, result: { kind: "text", items: textOutlines(req.doc) } });
    } else if (req.type === "inspect") {
      await builder.prepareImports(req.doc);
      const shapes = builder.shapes(req.doc);
      const result: InspectResult =
        req.kind === "distance"
          ? { kind: "distance", result: minDistance(shapes, req.picks ?? []) }
          : req.kind === "interference"
          ? { kind: "interference", items: interference(shapes) }
          : req.kind === "validity"
            ? { kind: "validity", items: [...shapes].map(([bodyId, s]) => ({ bodyId, valid: isValidShape(s) })) }
            : { kind: "radii", items: radii(shapes) };
      post({ type: "inspect", seq: req.seq, result });
    } else {
      await builder.prepareImports(req.doc);
      const shapes = builder.shapes(req.doc);
      const file = await exportShapes(req.doc, shapes, req.format, req.bodyIds, req.quality, req.drawing);
      post({ type: "export", seq: req.seq, ...file }, [file.data.buffer]);
    }
  } catch (e) {
    if (isEngineAbort(e)) {
      post({ type: "error", seq: req.seq, fatal: true, message: "The geometry engine ran out of memory or stopped, so it was restarted. Try a simpler change, or a coarser preview." });
      return;
    }
    post({ type: "error", seq: req.seq, message: e instanceof Error ? e.message : String(e) });
  }
}

ctx.onmessage = (ev: MessageEvent<KernelRequest>) => {
  const req = ev.data;
  restoreImports(req.doc); // before the queue, so a dropped (superseded) request still records its files
  if (req.type === "regen") latestRegen = Math.max(latestRegen, req.seq);
  queue.push(req);
  // Let a burst of messages (e.g. dragging a value) coalesce before building.
  setTimeout(drain, 0);
};

boot().catch((e) => post({ type: "error", seq: -1, message: "The geometry engine failed to load: " + String(e) }));