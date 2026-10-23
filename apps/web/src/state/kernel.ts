/** Keeps the geometry kernel in sync with the document. */
import { produce } from "immer";
import type { EdgeRef, WhittleDocument } from "@whittle/core";
import { WorkerKernel } from "@whittle/kernel";
import { edgeRefFromPick, pickableBodies } from "./actions";
import { tangentChain } from "./edgeChain";
import { type Session, findFeature, useApp } from "./store";

let kernel: WorkerKernel | null = null;
let scheduled = false;
let pending = 0;

/** Stop a long rebuild (the engine restarts, and the design rebuilds from scratch on the next change). */
export function stopRebuild() {
  kernel?.cancel();
}

/**
 * After an engine error: rebuild again (a crashed engine restarts by itself on the next request), or reload the
 * page when the engine never started at all (autosave brings the design back).
 */
export function retryKernel() {
  if (!useApp.getState().kernelReady) return window.location.reload();
  useApp.setState({ kernelError: null });
  schedule();
}

export function getKernel(): WorkerKernel {
  if (!kernel) throw new Error("Kernel not started");
  return kernel;
}

function pickBeforeFor(): string | undefined {
  const { session, doc } = useApp.getState();
  if (!session) return undefined;
  const f = findFeature(doc, session.featureId);
  return f && ["fillet", "chamfer", "shell", "hole", "combine", "move", "draft", "offsetFace", "cplane", "construct", "curve", "surface", "thread", "replaceFace", "deleteFace", "align", "boundaryFill", "joint", "split", "offset", "scale", "mirror", "pattern", "boundingSolid"].includes(f.type) ? f.id : undefined;
}

function schedule() {
  if (scheduled || !kernel || !useApp.getState().kernelReady) return;
  scheduled = true;
  requestAnimationFrame(async () => {
    scheduled = false;
    const { doc, session, hoverEdges } = useApp.getState();
    pending++;
    useApp.setState({ regenBusy: true, regenProgress: null });
    try {
      const result = await kernel!.regen(withHoverEdges(doc, session, hoverEdges), session ? "preview" : "final", pickBeforeFor(), session?.featureId);
      if (result) useApp.setState({ regen: result, builtDoc: doc, kernelError: null });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A rebuild the person stopped is not an error.
      useApp.setState({ kernelError: message === "Cancelled." ? null : message });
    } finally {
      pending--;
      if (pending === 0) useApp.setState({ regenBusy: false, regenProgress: null });
    }
  });
}

const near = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) < 1e-6;

/** The document with the hovered edges added to the open fillet or chamfer (what clicking would give). */
function withHoverEdges(doc: WhittleDocument, session: Session | null, edges: EdgeRef[] | null): WhittleDocument {
  if (!session || !edges?.length) return doc;
  const f = findFeature(doc, session.featureId);
  if (f?.type !== "fillet" && f?.type !== "chamfer") return doc;
  const add = edges.filter((r) => !f.edges.some((e) => near(e.mid, r.mid)));
  if (!add.length) return doc;
  return produce(doc, (d) => {
    const x = d.features.find((y) => y.id === f.id);
    if (x?.type === "fillet" || x?.type === "chamfer") x.edges.push(...add);
  });
}

// ponytail: a preview costs a rebuild of the fillet step, so it waits until the pointer rests on an edge.
const HOVER_DELAY = 250;

/** While a fillet or chamfer is open, an edge the pointer rests on is previewed as if it were picked. */
function watchHoverEdges() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = useApp.getState().hover;
  let lastSession = useApp.getState().session?.featureId;
  useApp.subscribe((s) => {
    // A preview never outlives the tool it was for.
    if (s.session?.featureId !== lastSession) {
      lastSession = s.session?.featureId;
      clearTimeout(timer);
      if (s.hoverEdges) useApp.setState({ hoverEdges: null });
    }
    const f = s.session && findFeature(s.doc, s.session.featureId);
    // Once clicked, the previewed edges are part of the feature.
    if (s.hoverEdges && (f?.type === "fillet" || f?.type === "chamfer") && s.hoverEdges.every((r) => f.edges.some((e) => near(e.mid, r.mid)))) useApp.setState({ hoverEdges: null });
    if (s.hover === last) return;
    last = s.hover;
    clearTimeout(timer);
    const p = s.hover;
    if (!p || p.kind !== "edge" || (f?.type !== "fillet" && f?.type !== "chamfer")) {
      if (s.hoverEdges) useApp.setState({ hoverEdges: null });
      return;
    }
    timer = setTimeout(() => {
      const st = useApp.getState();
      if (st.hover !== p) return;
      const body = pickableBodies().find((b) => b.id === p.bodyId);
      if (!body) return;
      const idx = st.prefs.tangentChain ? tangentChain(body.edges, p.index) : [p.index];
      const cur = st.session && findFeature(st.doc, st.session.featureId);
      const have = cur?.type === "fillet" || cur?.type === "chamfer" ? cur.edges : [];
      // Edges already picked add nothing new to show.
      const refs = idx
        .map((i) => edgeRefFromPick({ kind: "edge", bodyId: p.bodyId, index: i }, [body]))
        .filter((x): x is EdgeRef => !!x && !have.some((e) => near(e.mid, x.mid)));
      useApp.setState({ hoverEdges: refs.length ? refs : null });
    }, HOVER_DELAY);
  });
}

export function startKernel() {
  if (kernel) return;
  kernel = new WorkerKernel();
  kernel.onProgress = (done, total) => useApp.setState({ regenProgress: { done, total } });
  kernel.ready
    .then(() => {
      useApp.setState({ kernelReady: true });
      schedule();
    })
    .catch((e: Error) => useApp.setState({ kernelError: e.message }));

  let lastDoc = useApp.getState().doc;
  let lastSession = useApp.getState().session;
  let lastHover = useApp.getState().hoverEdges;
  useApp.subscribe((s) => {
    if (s.doc !== lastDoc || s.session !== lastSession || s.hoverEdges !== lastHover) {
      lastDoc = s.doc;
      lastSession = s.session;
      lastHover = s.hoverEdges;
      schedule();
    }
  });
  watchHoverEdges();
}