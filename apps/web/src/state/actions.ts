/** High-level commands used by the toolbar, shortcuts, palette and context bar. */
import { startTask } from "./tasks";
import {
  CONSTRUCT_MODES,
  CURVE_SOURCES,
  SURFACE_OPS,
  type SurfaceOp,
  type ConstructMode,
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
  makeAlign,
  makeBoundaryFill,
  makeConstruct,
  makeCurve,
  makeSurface,
  makeDeleteFace,
  makeReplaceFace,
  makeRib,
  makeThread,
  makeConstructionPlane,
  makeDraft,
  makeJoint,
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
import { tangentChain } from "./edgeChain";
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
  // Edges already selected carry over; so do all the edges of any selected face (as clicking a face in the tool does).
  const edges: EdgeRef[] = [];
  const add = (r: EdgeRef | null) => {
    if (r && !edges.some((e) => d3(e.mid, r.mid) < 1e-6)) edges.push(r);
  };
  for (const p of get().selection) {
    if (p.kind === "edge") add(edgeRefFromPick(p));
    else if (p.kind === "face") {
      const body = pickableBodies().find((b) => b.id === p.bodyId);
      for (const i of body?.faceEdges?.[p.index] ?? []) add(edgeRefFromPick({ kind: "edge", bodyId: p.bodyId, index: i }, body ? [body] : undefined));
    }
  }
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
  input.accept = ".step,.stp,.stl,.whittle";
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) void importFile(file);
  };
  input.click();
}

export async function importFile(file: File) {
  const ext = file.name.toLowerCase().split(".").pop();
  const format = ext === "stl" ? "stl" : ext === "step" || ext === "stp" ? "step" : ext === "whittle" ? "whittle" : null;
  if (!format) return toast("warn", "Only STEP (.step, .stp), STL and Whittle (.whittle) files can be inserted.");
  if (file.size > 40 * 1024 * 1024) return toast("warn", "That file is larger than 40 MB. Try a simplified version.");
  // Reading and encoding a big file takes a moment: show how far along it is, and let the window breathe meanwhile.
  const task = startTask(`Reading ${file.name}…`, 0);
  let data: string;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0, n = 0; i < bytes.length; i += 0x8000, n++) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      if (n % 32 === 31) {
        task.update(i / bytes.length);
        await new Promise((r) => setTimeout(r));
      }
    }
    data = btoa(bin);
  } finally {
    task.done();
  }
  const f = makeImport(get().doc, file.name, format, data);
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

/** A joint: the selected body moves (first pick), attached to the second pick if there is one. */
export function startJoint() {
  const picked = [...new Set(get().selection.flatMap((p) => (p.kind === "body" || p.kind === "face" || p.kind === "edge" ? [p.bodyId] : [])))];
  const bodies = get().regen?.bodies ?? [];
  if (bodies.length < 2) return toast("info", "A joint connects two bodies. Make another body first.");
  const moving = picked[0] ?? bodies.at(-1)!.id;
  const fixed = picked[1] ?? bodies.find((b) => b.id !== moving)?.id;
  beginNewFeature(makeJoint(get().doc, moving, fixed), "New Joint");
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

/** Surface tools: start with whatever fits the tool already selected. */
export function startSurface(op: SurfaceOp) {
  const f = makeSurface(get().doc, op);
  if (f.type === "surface") {
    const sel = get().selection;
    if (op === "patch" || op === "ruled") f.edges = sel.map((p) => edgeRefFromPick(p)).filter((x): x is EdgeRef => !!x);
    else if (op === "offset" || op === "untrim" || op === "extend") f.faces = sel.map((p) => faceRefFromPick(p)).filter((x): x is FaceRef => !!x);
    else if (op === "stitch") f.bodies = [...new Set(sel.flatMap((p) => (p.kind === "body" || p.kind === "face" || p.kind === "edge" ? [p.bodyId] : [])))];
    else f.bodyId = selectedBodyId();
  }
  beginNewFeature(f, `New ${f.name}`);
  toast("info", SURFACE_OPS[op].hint);
}

/** 3D curve: through points, from edges, where faces meet, or a sketch projected onto a face. */
export function startCurve(source: "points" | "edges" | "faces" | "project") {
  const f = makeCurve(get().doc, source);
  if (f.type === "curve") {
    const sel = get().selection;
    if (source === "edges") f.edges = sel.map((p) => edgeRefFromPick(p)).filter((x): x is EdgeRef => !!x);
    if (source === "faces") f.faces = sel.map((p) => faceRefFromPick(p)).filter((x): x is FaceRef => !!x).slice(0, 2);
    if (source === "project") {
      const face = sel.map((p) => faceRefFromPick(p)).find((x): x is FaceRef => !!x);
      if (face) f.faces = [face];
      const sk = sel.find((p) => p.kind === "sketch");
      if (sk?.kind === "sketch") f.sketch = sk.sketchId;
    }
  }
  beginNewFeature(f, `New ${f.name}`);
  toast("info", CURVE_SOURCES[source].hint);
}

/** The newest sketch with an open line (or the selected one): a rib or web path. */
function openLineSketch(): Id | null {
  const { selection, doc } = get();
  const picked = selection.find((p) => p.kind === "sketch");
  if (picked?.kind === "sketch") return picked.sketchId;
  const sketches = doc.features.slice(0, activeEnd(doc)).filter((f) => f.type === "sketch" && f.entities.some((e) => e.type === "polyline" && e.open));
  return sketches.at(-1)?.id ?? null;
}

export function startRib() {
  const sketch = openLineSketch();
  const f = makeRib(get().doc, sketch ?? "");
  if (f.type === "rib") f.target = selectedBodyId();
  beginNewFeature(f, `New ${f.name}`);
  if (!sketch) toast("info", "A rib needs a line: sketch one with the Path tool on a plane through the part, then click Rib.");
}

/** Web: a thin wall from an open line, extruded perpendicular to the sketch. */
export function startWeb() {
  const sketch = openLineSketch();
  if (!sketch) return toast("info", "A web needs a line: sketch one with the Path tool, then click Web.");
  const f = makeExtrude(get().doc, sketch, (get().regen?.bodies.length ?? 0) > 0 ? "join" : "new");
  if (f.type === "extrude") {
    f.thin = "2";
    f.thinSide = "center";
    f.distance = "10";
  }
  f.name = f.name.replace("Extrude", "Web");
  beginNewFeature(f, `New ${f.name}`);
}

/** Emboss (raised) or engrave (sunk) the newest sketch's shapes onto the face it sits on. */
export function startEmboss(engrave: boolean) {
  const sketch = sketchForProfile();
  if (!sketch) return toast("info", "Sketch text or a shape on a flat face first (Text or any shape tool), then click Emboss.");
  const f = makeExtrude(get().doc, sketch, engrave ? "cut" : "join");
  const sk = findFeature(get().doc, sketch, "sketch");
  if (f.type === "extrude") {
    f.distance = engrave ? "0.6" : "0.8";
    if (sk?.plane.kind === "face") f.target = sk.plane.face.bodyId;
    f.flip = false;
    if (engrave) f.flip = true;
  }
  f.name = f.name.replace("Extrude", engrave ? "Engrave" : "Emboss");
  beginNewFeature(f, `New ${f.name}`);
}

export function startThreadFace() {
  const f = makeThread(get().doc);
  const pick = get().selection.find((p) => p.kind === "face");
  if (pick && f.type === "thread") {
    const ref = faceRefFromPick(pick);
    if (ref?.surface === "CYLINDRE") f.face = ref;
  }
  beginNewFeature(f, `New ${f.name}`);
}

export function startReplaceFace() {
  const faces = get()
    .selection.map((p) => faceRefFromPick(p))
    .filter((x): x is FaceRef => !!x && x.surface === "PLANE");
  const f = makeReplaceFace(get().doc);
  if (f.type === "replaceFace") {
    f.faces = faces;
    f.pickTarget = true;
  }
  beginNewFeature(f, `New ${f.name}`);
}

export function startDeleteFace() {
  const faces = get()
    .selection.map((p) => faceRefFromPick(p))
    .filter((x): x is FaceRef => !!x);
  const f = makeDeleteFace(get().doc);
  if (f.type === "deleteFace") f.faces = faces;
  beginNewFeature(f, `New ${f.name}`);
}

export function startAlign() {
  if ((get().regen?.bodies.length ?? 0) < 2) return toast("info", "Align needs two bodies: one to move and one to meet.");
  beginNewFeature(makeAlign(get().doc), "New Align");
}

export function startBoundaryFill() {
  const ids = [...new Set(get().selection.flatMap((p) => (p.kind === "body" || p.kind === "face" || p.kind === "edge" ? [p.bodyId] : [])))];
  if ((get().regen?.bodies.length ?? 0) < 2) return toast("info", "Boundary Fill needs two or more overlapping bodies.");
  beginNewFeature(makeBoundaryFill(get().doc, ids), "New Boundary Fill");
}

/** Split just the faces along a plane (the body stays in one piece). */
export function startSplitFaces() {
  const body = selectedBodyId() ?? lastBodyId();
  if (!body) return toast("info", "Create a body first, then split its faces.");
  const f = makeSplit(get().doc, body);
  if (f.type === "split") f.facesOnly = true;
  f.name = f.name.replace("Split", "Split Faces");
  beginNewFeature(f, `New ${f.name}`);
}

/** Construction plane / axis / point: picks are routed by handlePick. */
export function startConstruct(mode: ConstructMode) {
  const f = makeConstruct(get().doc, mode);
  beginNewFeature(f, `New ${f.name}`);
  toast("info", CONSTRUCT_MODES[mode].hint);
}

/** A clicked point, snapped to the nearest straight-edge corner of its body when close. */
function snapPoint(p: Pick & { at?: Vec3 }): Vec3 | null {
  if (!p.at) return null;
  const at = p.at;
  const body = p.kind === "face" || p.kind === "edge" || p.kind === "body" ? pickableBodies().find((b) => b.id === p.bodyId) : undefined;
  let best: Vec3 = at;
  let bestD = 3;
  for (const e of body?.edges ?? []) {
    for (const end of e.ends ?? []) {
      const dd = d3(end, at);
      if (dd < bestD) {
        bestD = dd;
        best = end;
      }
    }
  }
  return [Math.round(best[0] * 1e4) / 1e4, Math.round(best[1] * 1e4) / 1e4, Math.round(best[2] * 1e4) / 1e4];
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
  if (f && f.type === "construct" && (p?.kind === "face" || p?.kind === "edge")) {
    const need = CONSTRUCT_MODES[f.mode];
    const round = f.mode === "axisCyl" || f.mode === "pointCenter";
    const takesFace = (need.faces > 0 || f.mode === "pointCenter") && p.kind === "face";
    const takesEdge = (need.edges > 0 || f.mode === "axisCyl") && p.kind === "edge";
    const point = need.points > 0 && !round ? snapPoint(p) : null;
    const fr = takesFace ? faceRefFromPick(p) : null;
    const er = takesEdge ? edgeRefFromPick(p) : null;
    if (!fr && !er && !point) return toast("info", CONSTRUCT_MODES[f.mode].hint);
    mutate("Pick", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (!x || x.type !== "construct") return;
      const cap = (list: unknown[], n: number) => {
        while (list.length > n) list.shift();
      };
      if (fr) {
        const i = x.faces.findIndex((e) => sameFace(e, fr));
        if (i >= 0) x.faces.splice(i, 1);
        else x.faces.push(fr);
        cap(x.faces, Math.max(1, need.faces));
      }
      if (er) {
        const i = x.edges.findIndex((e) => d3(e.mid, er.mid) < 1e-6);
        if (i >= 0) x.edges.splice(i, 1);
        else x.edges.push(er);
        cap(x.edges, Math.max(1, need.edges));
      }
      if (point && (!fr || x.mode === "axisPerp")) {
        x.points.push(point);
        cap(x.points, need.points);
      }
    });
    return;
  }
  if (f && f.type === "surface" && p) {
    const sp = p;
    mutate("Pick", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (!x || x.type !== "surface") return;
      const byEdges = x.op === "patch" || x.op === "ruled";
      const byFaces = x.op === "offset" || x.op === "untrim" || x.op === "extend";
      if (byEdges) {
        const er = sp.kind === "edge" ? edgeRefFromPick(sp) : null;
        if (!er) return;
        const i = x.edges.findIndex((e) => d3(e.mid, er.mid) < 1e-6);
        if (i >= 0) x.edges.splice(i, 1);
        else x.edges.push(er);
      } else if (byFaces) {
        const fr = sp.kind === "face" ? faceRefFromPick(sp) : null;
        if (!fr) return;
        const i = x.faces.findIndex((e) => sameFace(e, fr));
        if (i >= 0) x.faces.splice(i, 1);
        else x.faces.push(fr);
      } else if (sp.kind === "body" || sp.kind === "face" || sp.kind === "edge") {
        if (x.op === "stitch") {
          const i = x.bodies.indexOf(sp.bodyId);
          if (i >= 0) x.bodies.splice(i, 1);
          else x.bodies.push(sp.bodyId);
        } else x.bodyId = sp.bodyId;
      }
    });
    return;
  }
  if (f && f.type === "curve" && p) {
    const sp = p;
    mutate("Pick", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (!x || x.type !== "curve") return;
      if (x.source === "points") {
        const pt = (sp.kind === "face" || sp.kind === "edge") ? snapPoint(sp) : null;
        if (pt) x.points.push(pt);
      } else if (x.source === "edges") {
        const er = sp.kind === "edge" ? edgeRefFromPick(sp) : null;
        if (!er) return;
        const i = x.edges.findIndex((e) => d3(e.mid, er.mid) < 1e-6);
        if (i >= 0) x.edges.splice(i, 1);
        else x.edges.push(er);
      } else if (x.source === "faces") {
        const fr = sp.kind === "face" ? faceRefFromPick(sp) : null;
        if (!fr) return;
        const i = x.faces.findIndex((e) => sameFace(e, fr));
        if (i >= 0) x.faces.splice(i, 1);
        else x.faces.push(fr);
        while (x.faces.length > 2) x.faces.shift();
      } else {
        if (sp.kind === "face") {
          const fr = faceRefFromPick(sp);
          if (fr) x.faces = [fr];
        } else if (sp.kind === "sketch") x.sketch = sp.sketchId;
      }
    });
    return;
  }
  if (f && f.type === "extrude" && f.extent === "face" && p?.kind === "face") {
    const ref = faceRefFromPick(p);
    if (!ref) return;
    if (ref.surface !== "PLANE") return toast("warn", "Pick a flat face to extrude up to.");
    mutate("Pick face", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (x && x.type === "extrude") x.toFace = ref;
    });
    return;
  }
  if (f && f.type === "thread" && p?.kind === "face") {
    const ref = faceRefFromPick(p);
    if (!ref) return;
    if (ref.surface !== "CYLINDRE") return toast("warn", "Threads go on round faces: a rod or the inside of a hole.");
    mutate("Pick face", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (x && x.type === "thread") x.face = ref;
    });
    return;
  }
  if (f && (f.type === "replaceFace" || f.type === "deleteFace") && p?.kind === "face") {
    const ref = faceRefFromPick(p);
    if (!ref) return;
    if (f.type === "replaceFace" && ref.surface !== "PLANE") return toast("warn", "Only flat faces can be replaced.");
    mutate("Pick face", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (!x || (x.type !== "replaceFace" && x.type !== "deleteFace")) return;
      if (x.type === "replaceFace" && x.pickTarget && x.faces.length > 0) {
        x.target = ref;
        x.pickTarget = false;
        x.plane = undefined;
        return;
      }
      const i = x.faces.findIndex((e) => d3(e.center, ref.center) < 1e-6);
      if (i >= 0) x.faces.splice(i, 1);
      else x.faces.push(ref);
    });
    return;
  }
  if (f && f.type === "align" && p?.kind === "face") {
    const ref = faceRefFromPick(p);
    if (!ref) return;
    if (ref.surface !== "PLANE") return toast("warn", "Align works with flat faces.");
    mutate("Pick face", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (!x || x.type !== "align") return;
      if (!x.from || x.to) {
        x.from = ref;
        x.to = null;
        x.bodyId = ref.bodyId;
      } else if (ref.bodyId !== x.from.bodyId) x.to = ref;
      else x.from = ref;
    });
    return;
  }
  if (f && f.type === "boundaryFill" && p && (p.kind === "body" || p.kind === "face" || p.kind === "edge")) {
    mutate("Pick body", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (!x || x.type !== "boundaryFill") return;
      const i = x.tools.indexOf(p.bodyId);
      if (i >= 0) x.tools.splice(i, 1);
      else x.tools.push(p.bodyId);
    });
    return;
  }
  if (f && (f.type === "rib" || (f.type === "pattern" && f.pattern === "path")) && p?.kind === "sketch") {
    mutate("Pick sketch", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (x && x.type === "rib") x.sketch = p.sketchId;
      if (x && x.type === "pattern") x.path = p.sketchId;
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
  if (f && f.type === "joint" && bodyOf) {
    mutate("Pick body", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (!x || x.type !== "joint") return;
      // First click: the moving body. Second click: what it is attached to.
      if (!x.bodyId || x.bodyId === bodyOf) x.bodyId = bodyOf;
      else x.fixedId = bodyOf;
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
    // Edges that continue smoothly from this one come along (a rounded outline is one click), unless switched off.
    const body = pickableBodies().find((b) => b.id === p.bodyId);
    const refs: EdgeRef[] =
      body && get().prefs.tangentChain
        ? tangentChain(body.edges, p.index).map((i) => edgeRefFromPick({ kind: "edge", bodyId: p.bodyId, index: i }, [body])).filter((x): x is EdgeRef => !!x)
        : [ref];
    mutate("Pick edge", (d) => {
      const x = d.features.find((y) => y.id === f.id);
      if (!x || (x.type !== "fillet" && x.type !== "chamfer")) return;
      const has = (r: EdgeRef) => x.edges.findIndex((e) => d3(e.mid, r.mid) < 1e-6);
      // Clicking a chain that is already fully chosen takes it back out.
      if (refs.every((r) => has(r) >= 0)) x.edges = x.edges.filter((e) => !refs.some((r) => d3(e.mid, r.mid) < 1e-6));
      else for (const r of refs) if (has(r) < 0) x.edges.push(r);
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