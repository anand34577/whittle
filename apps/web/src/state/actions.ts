/** High-level commands used by the toolbar, shortcuts, palette and context bar. */
import {
  type EdgeRef,
  type FaceRef,
  type Feature,
  type Id,
  type OriginPlane,
  type PlaneRef,
  type PrimitiveShape,
  type Vec3,
  activeEnd,
  frameAxes,
  isSketchConsumed,
  planeOrigin,
  makeChamfer,
  makeCoil,
  makeCombine,
  makeConstructionPlane,
  makeDraft,
  makeOffsetFace,
  makeOffset,
  makeScale,
  makeSplit,
  makePipe,
  makeSweep,
  makeExtrude,
  makeFillet,
  makeHole,
  makeImport,
  makeLoft,
  makeMirror,
  makeMove,
  makePattern,
  makePrimitive,
  makeRevolve,
  makeShell,
  makeSketch,
  trim,
} from "@whittle/core";
import type { BodyResult, EdgeInfo, FaceInfo } from "@whittle/kernel";
import {
  type Pick,
  beginNewFeature,
  commitSession,
  enterSketch,
  findFeature,
  mutate,
  selectedBodyId,
  toast,
  useApp,
} from "./store";

const get = useApp.getState;
const set = useApp.setState;

/** Bodies that picks currently refer to (the "before" state while a feature previews). */
export function pickableBodies(): BodyResult[] {
  const { regen } = get();
  return regen?.pickBodies ?? regen?.bodies ?? [];
}

export function faceRefFromPick(p: Pick, bodies = pickableBodies()): FaceRef | null {
  if (p.kind !== "face") return null;
  const info = bodies.find((b) => b.id === p.bodyId)?.faces[p.index];
  return info ? { bodyId: p.bodyId, ...info } : null;
}

export function edgeRefFromPick(p: Pick, bodies = pickableBodies()): EdgeRef | null {
  if (p.kind !== "edge") return null;
  const info = bodies.find((b) => b.id === p.bodyId)?.edges[p.index];
  return info ? { bodyId: p.bodyId, mid: info.mid, tangent: info.tangent, curve: info.curve, length: info.length } : null;
}

/** A clicked world point in a face's hole/sketch frame (rounded to 0.1 mm). */
export function faceLocal(face: FaceRef, at: Vec3): [string, string] {
  const { xDir, yDir } = frameAxes(face.normal);
  const o = planeOrigin(face.center, face.normal);
  const d: Vec3 = [at[0] - o[0], at[1] - o[1], at[2] - o[2]];
  const x = d[0] * xDir[0] + d[1] * xDir[1] + d[2] * xDir[2];
  const y = d[0] * yDir[0] + d[1] * yDir[1] + d[2] * yDir[2];
  return [trim(Math.round(x * 10) / 10, 1), trim(Math.round(y * 10) / 10, 1)];
}

const sameFace = (a: FaceRef, b: FaceRef) => a.bodyId === b.bodyId && d3(a.center, b.center) < 1e-4 && dotv(a.normal, b.normal) > 0.999;

const d3 = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const dotv = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/** Index of the displayed edge matching a stored reference (for highlighting). */
export function matchEdge(edges: EdgeInfo[], ref: EdgeRef): number {
  let best = -1;
  let bestD = Infinity;
  edges.forEach((e, i) => {
    if (Math.abs(dotv(e.tangent, ref.tangent)) < 0.9) return;
    const d = d3(e.mid, ref.mid);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

export function matchFace(faces: FaceInfo[], ref: FaceRef): number {
  let best = -1;
  let bestD = Infinity;
  faces.forEach((f, i) => {
    if (dotv(f.normal, ref.normal) < 0.9) return;
    const d = d3(f.center, ref.center);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/* ───────────────────────────── Create ───────────────────────────── */

export function startSketch() {
  const sel = get().selection;
  const face = sel.find((p) => p.kind === "face");
  if (face) {
    const ref = faceRefFromPick(face);
    if (ref && ref.surface === "PLANE") return createSketchOn({ kind: "face", face: ref, offset: "0" });
  }
  const plane = sel.find((p) => p.kind === "plane");
  if (plane && plane.kind === "plane") return createSketchOn({ kind: "origin", plane: plane.plane, offset: "0" });
  if (get().session) commitSession();
  set({ mode: { kind: "pickPlane" }, selection: [] });
}

export function createSketchOn(plane: PlaneRef) {
  const f = makeSketch(get().doc, plane);
  beginNewFeature(f, `New ${f.name}`);
  enterSketch(f.id, true);
}

export function pickSketchPlane(p: Pick) {
  if (p.kind === "plane") return createSketchOn({ kind: "origin", plane: p.plane as OriginPlane, offset: "0" });
  if (p.kind === "cplane") return createSketchOn({ kind: "construction", plane: p.id, offset: "0" });
  if (p.kind === "face") {
    const ref = faceRefFromPick(p);
    if (!ref) return;
    if (ref.surface !== "PLANE") {
      toast("warn", "Sketches need a flat face. Pick a flat face or an origin plane.");
      return;
    }
    createSketchOn({ kind: "face", face: ref, offset: "0" });
  }
}

/** The sketch an extrude/revolve should use: selected one, else the newest unused one. */
function sketchForProfile(): Id | null {
  const { selection, doc } = get();
  const picked = selection.find((p) => p.kind === "sketch");
  if (picked && picked.kind === "sketch") return picked.sketchId;
  const end = activeEnd(doc);
  const sketches = doc.features.slice(0, end).filter((f) => f.type === "sketch" && f.entities.length > 0);
  const unused = sketches.filter((s) => !isSketchConsumed(doc, s.id));
  return (unused.pop() ?? sketches.pop())?.id ?? null;
}

export function startExtrude() {
  const sketch = sketchForProfile();
  if (!sketch) {
    toast("info", "Extrude needs a sketch. Start one with Sketch (S), draw a closed shape, then Extrude.", {
      label: "Start sketch",
      run: startSketch,
    });
    return;
  }
  const hasBodies = (get().regen?.bodies.length ?? 0) > 0;
  const f = makeExtrude(get().doc, sketch, "new");
  // On a face of an existing body, joining is what people usually want.
  const sk = findFeature(get().doc, sketch, "sketch");
  if (hasBodies && sk?.plane.kind === "face" && f.type === "extrude") {
    f.op = "join";
    f.target = sk.plane.face.bodyId;
  }
  beginNewFeature(f, `New ${f.name}`);
}

export function startRevolve() {
  const sketch = sketchForProfile();
  if (!sketch) {
    toast("info", "Revolve needs a sketch with a closed profile beside its axis.", { label: "Start sketch", run: startSketch });
    return;
  }
  const f = makeRevolve(get().doc, sketch);
  beginNewFeature(f, `New ${f.name}`);
}

export function startEdgeFeature(kind: "fillet" | "chamfer") {
  const edges = get()
    .selection.map((p) => edgeRefFromPick(p))
    .filter((x): x is EdgeRef => !!x);
  const f = kind === "fillet" ? makeFillet(get().doc) : makeChamfer(get().doc);
  if (f.type === "fillet" || f.type === "chamfer") f.edges = edges;
  beginNewFeature(f, `New ${f.name}`);
}

export function startShell() {
  const faces = get()
    .selection.map((p) => faceRefFromPick(p))
    .filter((x): x is FaceRef => !!x);
  const f = makeShell(get().doc);
  if (f.type === "shell") {
    f.faces = faces;
    f.bodyId = faces[0]?.bodyId ?? selectedBodyId();
  }
  beginNewFeature(f, `New ${f.name}`);
}

export function addPrimitive(shape: PrimitiveShape) {
  const f = makePrimitive(get().doc, shape);
  beginNewFeature(f, `New ${f.name}`);
}

export function startHole() {
  const f = makeHole(get().doc);
  const pick = get().selection.find((p) => p.kind === "face");
  if (pick && f.type === "hole") {
    const ref = faceRefFromPick(pick);
    if (ref?.surface === "PLANE") {
      f.face = ref;
      if (pick.kind === "face" && pick.at) f.points = [faceLocal(ref, pick.at)];
    }
  }
  beginNewFeature(f, `New ${f.name}`);
}

export function startLoft() {
  const { selection, doc } = get();
  let ids = selection.filter((p) => p.kind === "sketch").map((p) => (p.kind === "sketch" ? p.sketchId : ""));
  if (ids.length < 2) {
    const end = activeEnd(doc);
    const unused = doc.features.slice(0, end).filter((f) => f.type === "sketch" && f.entities.length > 0 && !isSketchConsumed(doc, f.id));
    ids = unused.slice(-2).map((f) => f.id);
  }
  beginNewFeature(makeLoft(get().doc, ids), "New Loft");
  if (ids.length < 2) toast("info", "Loft joins two or more sketches on different planes. Click sketches to add them.");
}

export function startMove() {
  const body = selectedBodyId() ?? lastBodyId();
  if (!body) return toast("info", "Create a body first, then move it.");
  beginNewFeature(makeMove(get().doc, body), "New Move");
}

export function startCombine() {
  const ids = [...new Set(get().selection.flatMap((p) => (p.kind === "body" || p.kind === "face" || p.kind === "edge" ? [p.bodyId] : [])))];
  const bodies = get().regen?.bodies ?? [];
  if (bodies.length < 2) return toast("info", "Combine needs at least two bodies. Make another body first.");
  const target = ids[0] ?? bodies[0]!.id;
  beginNewFeature(makeCombine(get().doc, target, ids.slice(1)), "New Combine");
}

/** Pick a STEP or STL file and add it as a body. */
export function importModel() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".step,.stp,.stl";
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) void importFile(file);
  };
  input.click();
}

export async function importFile(file: File) {
  const ext = file.name.toLowerCase().split(".").pop();
  const format = ext === "stl" ? "stl" : ext === "step" || ext === "stp" ? "step" : null;
  if (!format) return toast("warn", "Only STEP (.step, .stp) and STL files can be imported.");
  if (file.size > 40 * 1024 * 1024) return toast("warn", "That file is larger than 40 MB. Try a simplified version.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const f = makeImport(get().doc, file.name, format, btoa(bin));
  f.name = file.name.replace(/\.[^.]+$/, "");
  beginNewFeature(f, `Import ${file.name}`);
  commitSession();
  toast("ok", `Imported ${file.name}`);
}

export function startMirror() {
  const body = selectedBodyId() ?? lastBodyId();
  if (!body) return toast("info", "Create a body first, then mirror it.");
  beginNewFeature(makeMirror(get().doc, body), "New Mirror");
}

export function startPattern() {
  const body = selectedBodyId() ?? lastBodyId();
  if (!body) return toast("info", "Create a body first, then pattern it.");
  beginNewFeature(makePattern(get().doc, body), "New Pattern");
}

/** Sweep: the selected sketches (profile first), else the two newest unused ones. */
export function startSweep() {
  const { selection, doc } = get();
  let ids = selection.flatMap((p) => (p.kind === "sketch" ? [p.sketchId] : []));
  if (ids.length < 2) {
    const end = activeEnd(doc);
    const sketches = doc.features.slice(0, end).filter((f) => f.type === "sketch" && f.entities.length > 0 && !isSketchConsumed(doc, f.id));
    // A sketch with an open path is the path; the other one is the profile.
    const path = [...sketches].reverse().find((s) => s.type === "sketch" && s.entities.some((e) => e.type === "polyline" && e.open));
    const profile = [...sketches].reverse().find((s) => s.id !== path?.id);
    ids = [profile?.id ?? "", path?.id ?? ""];
  }
  beginNewFeature(makeSweep(doc, ids[0] ?? "", ids[1] ?? ""), "New Sweep");
  if (!ids[0] || !ids[1]) toast("info", "A sweep needs two sketches: a closed cross-section, and a path (an open line) for it to follow.");
}

/** Pipe: a tube along the selected (or newest unused) path sketch. */
export function startPipe() {
  const { selection, doc } = get();
  const sketches = doc.features.slice(0, activeEnd(doc)).filter((f) => f.type === "sketch" && f.entities.length > 0);
  const picked = selection.find((p) => p.kind === "sketch");
  const path =
    (picked?.kind === "sketch" ? picked.sketchId : undefined) ??
    [...sketches].reverse().find((s) => s.type === "sketch" && s.entities.some((e) => e.type === "polyline" && e.open))?.id ??
    "";
  beginNewFeature(makePipe(doc, path), "New Pipe");
  if (!path) toast("info", "A pipe needs a path: draw an open line with the Path tool, then click its sketch.");
}

export function startCoil(kind: "spring" | "thread") {
  const f = makeCoil(get().doc, kind);
  beginNewFeature(f, `New ${f.name}`);
}

export function startSplit() {
  const body = selectedBodyId() ?? lastBodyId();
  if (!body) return toast("info", "Create a body first, then split it.");
  beginNewFeature(makeSplit(get().doc, body), "New Split");
}

export function startOffset() {
  const body = selectedBodyId() ?? lastBodyId();
  if (!body) return toast("info", "Create a body first, then offset it.");
  beginNewFeature(makeOffset(get().doc, body), "New Offset");
}

export function startScale() {
  const body = selectedBodyId() ?? lastBodyId();
  if (!body) return toast("info", "Create a body first, then scale it.");
  beginNewFeature(makeScale(get().doc, body), "New Scale");
}

export function startDraft() {
  const faces = get()
    .selection.map((p) => faceRefFromPick(p))
    .filter((x): x is FaceRef => !!x);
  const f = makeDraft(get().doc);
  if (f.type === "draft") f.faces = faces;
  beginNewFeature(f, `New ${f.name}`);
}

/** A new construction plane: 10 mm off the selected face, plane or construction plane (else the XY plane). */
export function startConstructionPlane() {
  const { selection, doc } = get();
  const face = selection.map((p) => faceRefFromPick(p)).find((x): x is FaceRef => !!x && x.surface === "PLANE");
  const cp = selection.find((p) => p.kind === "cplane");
  const op = selection.find((p) => p.kind === "plane");
  const base: PlaneRef = face
    ? { kind: "face", face, offset: "10" }
    : cp?.kind === "cplane"
      ? { kind: "construction", plane: cp.id, offset: "10" }
      : { kind: "origin", plane: op?.kind === "plane" ? op.plane : "XY", offset: "10" };
  const f = makeConstructionPlane(doc, base);
  beginNewFeature(f, `New ${f.name}`);
}

/** Press/Pull: starts with any flat faces already selected. */
export function startOffsetFace() {
  const faces = get()
    .selection.map((p) => faceRefFromPick(p))
    .filter((x): x is FaceRef => !!x && x.surface === "PLANE");
  const f = makeOffsetFace(get().doc);
  if (f.type === "offsetFace") f.faces = faces;
  beginNewFeature(f, `New ${f.name}`);
}

/** Fillet or chamfer every edge of the selected (or latest) body. */
export function startEdgeFeatureAll(kind: "fillet" | "chamfer") {
  const id = selectedBodyId() ?? lastBodyId();
  const body = pickableBodies().find((b) => b.id === id);
  if (!body) return toast("info", "Create a body first.");
  const f = kind === "fillet" ? makeFillet(get().doc) : makeChamfer(get().doc);
  if (f.type === "fillet" || f.type === "chamfer") f.edges = body.edges.map((e) => ({ bodyId: body.id, mid: e.mid, tangent: e.tangent, curve: e.curve, length: e.length }));
  if (f.type === "fillet") f.radius = "1";
  if (f.type === "chamfer") f.distance = "0.5";
  beginNewFeature(f, `New ${f.name}`);
}

function lastBodyId(): Id | undefined {
  return get().regen?.bodies.at(-1)?.id;
}

/* ───────────────────────────── Selection ───────────────────────────── */

export function samePick(a: Pick, b: Pick): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "face":
    case "edge":
      return a.bodyId === (b as typeof a).bodyId && a.index === (b as typeof a).index;
    case "body":
      return a.bodyId === (b as typeof a).bodyId;
    case "plane":
      return a.plane === (b as typeof a).plane;
    case "cplane":
      return a.id === (b as typeof a).id;
    case "sketch":
      return a.sketchId === (b as typeof a).sketchId;
  }
}

/** Route a viewport click according to the current mode/session. */
export function handlePick(p: Pick | null, additive: boolean) {
  const { mode, session, doc, selection } = get();
  if (mode.kind === "pickPlane") {
    if (p && (p.kind === "plane" || p.kind === "cplane" || p.kind === "face")) pickSketchPlane(p);
    return;
  }
  if (mode.kind === "measure") {
    if (!p || p.kind === "plane" || p.kind === "cplane" || p.kind === "sketch") return set({ measure: [] });
    const m = get().measure;
    set({ measure: m.length >= 2 ? [p] : [...m, p] });
    return;
  }
  const f = session ? findFeature(doc, session.featureId) : undefined;
  if (f && f.type === "hole" && p?.kind === "face") {
    const ref = faceRefFromPick(p);
    if (!ref || !p.at) return;
    if (ref.surface !== "PLANE") return toast("warn", "Holes go on flat faces.");
    if (f.face && !sameFace(f.face, ref) && f.points.length > 0) {
      return toast("info", "All holes in one Hole feature share a face. Finish this one (Enter) to drill on another face.");
    }
    const pt = faceLocal(ref, p.at);
    mutate("Place hole", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (!x || x.type !== "hole") return;
      x.face = ref;
      x.points.push(pt);
    });
    return;
  }
  if (f && f.type === "sweep" && p?.kind === "sketch") {
    mutate("Pick sketch", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (!x || x.type !== "sweep") return;
      if (x.pipe) x.path = x.path === p.sketchId ? "" : p.sketchId;
      else if (x.profile === p.sketchId) x.profile = "";
      else if (x.path === p.sketchId) x.path = "";
      else if (!x.profile) x.profile = p.sketchId;
      else x.path = p.sketchId;
    });
    return;
  }
  if (f && f.type === "offsetFace" && p?.kind === "face") {
    const ref = faceRefFromPick(p);
    if (!ref) return;
    if (ref.surface !== "PLANE") return toast("warn", "Only flat faces can be pushed or pulled.");
    mutate("Pick face", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (!x || x.type !== "offsetFace") return;
      const i = x.faces.findIndex((e) => d3(e.center, ref.center) < 1e-6);
      if (i >= 0) x.faces.splice(i, 1);
      else x.faces.push(ref);
    });
    return;
  }
  if (f && f.type === "draft" && p?.kind === "face") {
    const ref = faceRefFromPick(p);
    if (!ref) return;
    if (ref.surface !== "PLANE" && ref.surface !== "CYLINDRE" && ref.surface !== "CONE") return toast("warn", "Only flat, cylindrical or conical faces can be drafted.");
    mutate("Pick face", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (!x || x.type !== "draft") return;
      const i = x.faces.findIndex((e) => d3(e.center, ref.center) < 1e-6);
      if (i >= 0) x.faces.splice(i, 1);
      else x.faces.push(ref);
    });
    return;
  }
  if (f && (f.type === "fillet" || f.type === "chamfer") && p?.kind === "face") {
    // Clicking a face takes all of its edges (click again to remove them).
    const body = pickableBodies().find((b) => b.id === p.bodyId);
    const idx = body?.faceEdges?.[p.index] ?? [];
    const refs = idx.map((i) => edgeRefFromPick({ kind: "edge", bodyId: p.bodyId, index: i }, body ? [body] : undefined)).filter((x): x is EdgeRef => !!x);
    if (!refs.length) return;
    mutate("Pick face edges", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (!x || (x.type !== "fillet" && x.type !== "chamfer")) return;
      const has = (r: EdgeRef) => x.edges.findIndex((e) => d3(e.mid, r.mid) < 1e-6);
      if (refs.every((r) => has(r) >= 0)) x.edges = x.edges.filter((e) => !refs.some((r) => d3(e.mid, r.mid) < 1e-6));
      else for (const r of refs) if (has(r) < 0) x.edges.push(r);
    });
    return;
  }
  if (f && f.type === "loft" && p?.kind === "sketch") {
    mutate("Pick profile", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (!x || x.type !== "loft") return;
      const i = x.sketches.indexOf(p.sketchId);
      if (i >= 0) x.sketches.splice(i, 1);
      else x.sketches.push(p.sketchId);
    });
    return;
  }
  const bodyOf = p && (p.kind === "body" || p.kind === "face" || p.kind === "edge") ? p.bodyId : null;
  if (f && f.type === "combine" && bodyOf) {
    mutate("Pick body", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (!x || x.type !== "combine") return;
      if (!x.target) x.target = bodyOf;
      else if (x.target === bodyOf) return;
      else {
        const i = x.tools.indexOf(bodyOf);
        if (i >= 0) x.tools.splice(i, 1);
        else x.tools.push(bodyOf);
      }
    });
    return;
  }
  if (f && (f.type === "move" || f.type === "mirror" || f.type === "pattern" || f.type === "split" || f.type === "offset" || f.type === "scale") && bodyOf && bodyOf !== f.id) {
    mutate("Pick body", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (x && (x.type === "move" || x.type === "mirror" || x.type === "pattern" || x.type === "split" || x.type === "offset" || x.type === "scale")) x.bodyId = bodyOf;
    });
    return;
  }
  if (f && (f.type === "fillet" || f.type === "chamfer") && p?.kind === "edge") {
    const ref = edgeRefFromPick(p);
    if (!ref) return;
    mutate("Pick edge", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (!x || (x.type !== "fillet" && x.type !== "chamfer")) return;
      const i = x.edges.findIndex((e) => d3(e.mid, ref.mid) < 1e-6);
      if (i >= 0) x.edges.splice(i, 1);
      else x.edges.push(ref);
    });
    return;
  }
  if (f && f.type === "shell" && p?.kind === "face") {
    const ref = faceRefFromPick(p);
    if (!ref) return;
    mutate("Pick face", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (!x || x.type !== "shell") return;
      const i = x.faces.findIndex((e) => d3(e.center, ref.center) < 1e-6);
      if (i >= 0) x.faces.splice(i, 1);
      else x.faces.push(ref);
      x.bodyId ??= ref.bodyId;
    });
    return;
  }
  if (session && !p) return;
  if (!p) {
    if (!additive) set({ selection: [] });
    return;
  }
  if (additive) {
    const exists = selection.some((s) => samePick(s, p));
    set({ selection: exists ? selection.filter((s) => !samePick(s, p)) : [...selection, p] });
  } else set({ selection: [p] });
}

export type { Feature };