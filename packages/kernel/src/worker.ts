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
import { Builder } from "./build";
import { exportShapes } from "./exporters";
import type { KernelRequest, KernelResponse } from "./protocol";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// The geometry library prints internal debug dumps when an operation fails.
// Failures already reach the user as friendly feature messages, so keep the
// console for real problems.
console.error = (...args: unknown[]) => console.debug("[kernel]", ...args);
const post = (msg: KernelResponse, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);

const builder = new Builder();
let latestRegen = 0;
const queue: KernelRequest[] = [];
let ready = false;

async function boot() {
  const t0 = performance.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = await (opencascade as any)({ locateFile: () => wasmUrl });
  setOC(oc);
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
      const r = builder.regen(req.doc, req.quality, req.pickBefore);
      const transfer: Transferable[] = [];
      for (const b of [...r.bodies, ...(r.pickBodies ?? [])]) {
        transfer.push(b.positions.buffer, b.normals.buffer, b.indices.buffer, b.faceRanges.buffer, b.edgePositions.buffer, b.edgeRanges.buffer);
      }
      for (const s of r.sketches) if (s.fill) transfer.push(s.fill.buffer);
      post({ type: "regen", result: { ...r, seq: req.seq } }, transfer);
    } else {
      await builder.prepareImports(req.doc);
      const shapes = builder.shapes(req.doc);
      const file = await exportShapes(req.doc, shapes, req.format, req.bodyIds);
      post({ type: "export", seq: req.seq, ...file }, [file.data.buffer]);
    }
  } catch (e) {
    post({ type: "error", seq: req.seq, message: e instanceof Error ? e.message : String(e) });
  }
}

ctx.onmessage = (ev: MessageEvent<KernelRequest>) => {
  const req = ev.data;
  if (req.type === "regen") latestRegen = Math.max(latestRegen, req.seq);
  queue.push(req);
  // Let a burst of messages (e.g. dragging a value) coalesce before building.
  setTimeout(drain, 0);
};

boot().catch((e) => post({ type: "error", seq: -1, message: "The geometry engine failed to load: " + String(e) }));