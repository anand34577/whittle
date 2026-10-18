/**
 * Application state. The document is immutable data changed only through
 * labelled commands (undoable). A "session" groups the live edits of one
 * feature dialog into a single undo step: OK commits, Cancel restores.
 */
import { create } from "zustand";
import type { Draft } from "immer";
import { produce } from "immer";
import {
  type EdgeRef,
  type ConstraintType,
  type EntityType,
  type Feature,
  type Id,
  type OriginPlane,
  type SketchEntity,
  type SketchFeature,
  type Vec2,
  type Vec3,
  type WhittleDocument,
  History,
  activeEnd,
  createsBody,
  dependents,
  reorderProblem,
  isBodyFeature,
  newDocument,
  nextBodyColor,
  nextBodyName,
} from "@whittle/core";
import type { RegenResult } from "@whittle/kernel";
import { type Platform, ask } from "./platform";
import { type Prefs, type ThemeId, type ThemePref, applyPrefs, loadPrefs, normalizePrefs, resolveTheme, savePrefs } from "./prefs";

/** `at` is the world point that was clicked (used by holes and measuring). */
export type Pick =
  | { kind: "face"; bodyId: Id; index: number; at?: Vec3 }
  | { kind: "edge"; bodyId: Id; index: number; at?: Vec3 }
  | { kind: "body"; bodyId: Id; at?: Vec3 }
  | { kind: "plane"; plane: OriginPlane }
  | { kind: "cplane"; id: Id }
  | { kind: "sketch"; sketchId: Id }
  /** One enclosed area of a sketch: `index` into its regions, `at` the clicked point in sketch coordinates. */
  | { kind: "region"; sketchId: Id; index: number; at: Vec2 };

/**
 * "path" draws an open polyline (for sweeps and guides). "segment", "arc" and
 * "pcircle" draw constraint-driven geometry; "trim" and "extend" edit it.
 */
export type SketchTool = EntityType | "select" | "path" | "crect" | "rect3" | "circle2" | "circle3" | "dimension" | "project" | "spline" | "sfillet" | "schamfer" | "gpoint" | "segment" | "arc" | "tarc" | "carc" | "conic" | "polygonC" | "polygonE" | "pcircle" | "trim" | "extend" | "cspline" | "earc" | "tan2c" | "tan3c";

export type Mode =
  | { kind: "model" }
  | { kind: "pickPlane" }
  | { kind: "measure" }
  | { kind: "sketch"; sketchId: Id; tool: SketchTool; isNew: boolean };

export type DisplayMode = "edges" | "shaded" | "wire" | "xray";

export interface ViewSettings {
  display: DisplayMode;
  section: { axis: "x" | "y" | "z"; offset: number; flip: boolean } | null;
  /** Face coloring: overhangs (3D printing), draft angle (moulding) or zebra stripes (surface quality). */
  analysis: "overhang" | "draft" | "zebra" | "curvature" | "access" | null;
  grid: boolean;
  ortho: boolean;
  /** Exploded view: 0 (together) to 1 (fully apart). A display effect only; the model is untouched. */
  explode?: number;
}

export interface Session {
  featureId: Id;
  isNew: boolean;
  base: WhittleDocument;
  label: string;
  /** Editing an early step rolled the timeline back to it; finishing puts the marker back. */
  isolated?: boolean;
  /** Step-by-step undo inside the session (e.g. each shape drawn in a sketch). */
  stack: { doc: WhittleDocument; key?: string; at: number }[];
}

export interface Toast {
  id: number;
  kind: "info" | "ok" | "warn" | "error";
  text: string;
  action?: { label: string; run: () => void };
  /** Says what to do next; gone as soon as the next step starts, so it never tells you to do what you're doing. */
  nextStep?: boolean;
}

/** The concrete theme on screen (preferences may say "system"). */
export type Theme = ThemeId;

export interface AppState {
  doc: WhittleDocument;
  historyTick: number;
  dirty: boolean;
  fileName: string | null;

  regen: RegenResult | null;
  /** The document `regen` was built from (so callers can wait for a specific change). */
  builtDoc: WhittleDocument | null;
  regenBusy: boolean;
  /** Timeline steps finished in the rebuild under way (null when none is running). */
  regenProgress: { done: number; total: number } | null;
  kernelReady: boolean;
  kernelError: string | null;

  mode: Mode;
  session: Session | null;
  selection: Pick[];
  hover: Pick | null;
  /** Edges the pointer rests on while a fillet or chamfer is open: the model previews them as if picked. */
  hoverEdges: EdgeRef[] | null;
  selectedEntity: Id | null;
  /** Selected constraint-driven geometry and constraints in the open sketch (may hold stale ids; check before use). */
  sketchSel: Id[];
  /** A constraint picked before its geometry: applied as soon as the selection fits it (Esc or another tool stops it). */
  pendingConstraint: ConstraintType | null;
  /** Overlapping bodies found by the interference check (drawn as red boxes). */
  interference: { a: Id; b: Id; volume: number; bbox: [Vec3, Vec3] }[];
  /** Points placed so far by the active sketch tool (drives the hint line). */
  sketchStep: number;

  theme: Theme;
  prefs: Prefs;
  view: ViewSettings;
  /** Picks collected by the measure tool (at most two). */
  measure: Pick[];
  /** Open radial (marking) menu, in viewport pixels. */
  radial: { x: number; y: number } | null;
  panel: "palette" | "quick" | "params" | "export" | "welcome" | "shortcuts" | "parts" | "versions" | "account" | "users" | "settings" | null;
  /** The AI assistant panel (stays open alongside dialogs). */
  assistant: boolean;
  /** Desktop app, self-hosted server or plain browser (see platform.ts). */
  platform: Platform;
  platformReady: boolean;
  coach: string | false;
  toasts: Toast[];
  viewRequest: { kind: "home" | "fit" | "normal"; at: number } | null;
  /** Frame the model once the next rebuild arrives (after inserting things). */
  fitOnRegen: boolean;
  /** What a click selects in the model: anything, or only bodies, faces or edges. */
  pickPriority: "all" | "body" | "face" | "edge";
}

export const history = new History<WhittleDocument>();

const initialPrefs = loadPrefs();

export const useApp = create<AppState>(() => ({
  doc: newDocument(),
  historyTick: 0,
  dirty: false,
  fileName: null,
  regen: null,
  builtDoc: null,
  regenBusy: false,
  regenProgress: null,
  kernelReady: false,
  kernelError: null,
  mode: { kind: "model" },
  session: null,
  selection: [],
  hover: null,
  hoverEdges: null,
  selectedEntity: null,
  sketchSel: [],
  pendingConstraint: null,
  interference: [],
  sketchStep: 0,
  theme: resolveTheme(initialPrefs.theme),
  prefs: initialPrefs,
  view: { display: "edges", section: null, analysis: null, grid: true, ortho: false },
  measure: [],
  radial: null,
  panel: null,
  assistant: false,
  platform: { kind: "browser" },
  platformReady: false,
  coach: false,
  toasts: [],
  viewRequest: null,
  fitOnRegen: false,
  pickPriority: "all",
}));

const set = useApp.setState;
const get = useApp.getState;

/* ───────────────────────────── Document edits ───────────────────────────── */

function touch(d: Draft<WhittleDocument>) {
  syncBodies(d);
}

/** Every feature that creates a body has metadata; nothing else does. */
function syncBodies(d: Draft<WhittleDocument>) {
  const ids = new Set<Id>();
  for (const f of d.features) {
    if (!createsBody(f as Feature)) continue;
    ids.add(f.id);
    if (!d.bodies[f.id]) {
      d.bodies[f.id] = { name: nextBodyName(d as WhittleDocument), color: nextBodyColor(d as WhittleDocument), visible: true };
    }
  }
  for (const id of Object.keys(d.bodies)) if (!ids.has(id)) delete d.bodies[id];
}

/**
 * Change the document. Inside a session the change is live (previewed) but
 * not yet an undo step; outside it becomes an undoable command immediately.
 */
export function mutate(label: string, recipe: (d: Draft<WhittleDocument>) => void, mergeKey?: string) {
  const { doc, session } = get();
  if (session) {
    const next = produce(doc, (d) => {
      recipe(d);
      touch(d);
    });
    if (next === doc) return;
    const top = session.stack[session.stack.length - 1];
    const now = Date.now();
    const merge = mergeKey && top && top.key === mergeKey && now - top.at < 1500;
    const stack = merge ? [...session.stack.slice(0, -1), { ...top!, at: now }] : [...session.stack, { doc, key: mergeKey, at: now }];
    set({ doc: next, dirty: true, session: { ...session, stack } });
    return;
  }
  const next = history.apply(
    doc,
    label,
    (d) => {
      recipe(d);
      touch(d);
    },
    mergeKey,
  );
  if (next !== doc) set({ doc: next, dirty: true, historyTick: get().historyTick + 1 });
}

export function replaceDocument(doc: WhittleDocument, fileName: string | null) {
  history.clear();
  set({
    doc,
    fileName,
    dirty: false,
    session: null,
    mode: { kind: "model" },
    selection: [],
    hover: null,
    selectedEntity: null,
    // Marks and picks from the previous design mean nothing in this one.
    sketchSel: [],
    pendingConstraint: null,
    sketchStep: 0,
    interference: [],
    measure: [],
    historyTick: get().historyTick + 1,
    regen: null,
  });
}

export function undo() {
  const { session } = get();
  if (session) {
    const prev = session.stack[session.stack.length - 1];
    if (!prev) return cancelSession();
    set({ doc: prev.doc, session: { ...session, stack: session.stack.slice(0, -1) }, selectedEntity: null });
    return;
  }
  const r = history.undo(get().doc);
  if (r) {
    set({ doc: r.state, dirty: true, historyTick: get().historyTick + 1, selection: [] });
    toast("info", `Undid ${r.label}`);
  }
}

export function redo() {
  if (get().session) return;
  const r = history.redo(get().doc);
  if (r) {
    set({ doc: r.state, dirty: true, historyTick: get().historyTick + 1, selection: [] });
    toast("info", `Redid ${r.label}`);
  }
}

/* ───────────────────────────── Feature sessions ───────────────────────────── */

export function findFeature<T extends Feature["type"]>(doc: WhittleDocument, id: Id | undefined, type?: T) {
  const f = doc.features.find((x) => x.id === id);
  if (!f || (type && f.type !== type)) return undefined;
  return f as Extract<Feature, { type: T }>;
}

/** Insert a new feature (at the rollback marker, if any) and open its editor. */
export function beginNewFeature(feature: Feature, label: string) {
  const { session, doc } = get();
  if (session) commitSession();
  const base = get().doc;
  set({ session: { featureId: feature.id, isNew: true, base, label, stack: [] }, selection: [], hover: null, toasts: get().toasts.filter((t) => !t.nextStep) });
  insertFeature(feature);
  const s = get().session;
  if (s) set({ session: { ...s, stack: [] } });
  void doc;
}

function insertFeature(feature: Feature) {
  mutate("Insert", (d) => {
    const at = d.rollback === null ? d.features.length : d.rollback;
    d.features.splice(at, 0, feature as Draft<Feature>);
    if (d.rollback !== null) d.rollback++;
  });
}

export function editFeature(id: Id) {
  const { doc, session } = get();
  if (session?.featureId === id) return;
  if (session) commitSession();
  const f = findFeature(get().doc, id);
  if (!f) return;
  if (f.type === "sketch") return enterSketch(id, false);
  const base = get().doc;
  const index = base.features.findIndex((x) => x.id === id);
  // Editing an early step shows the model as it was then, so later steps neither hide it nor slow the edit.
  const isolated = index >= 0 && index < activeEnd(base) - 1;
  set({
    session: { featureId: id, isNew: false, base, label: `Edit ${f.name}`, stack: [], isolated },
    doc: isolated ? produce(base, (d) => void (d.rollback = index + 1)) : base,
    selection: [],
  });
  void doc;
}

/**
 * Apply the open feature. A new one still waiting for its picks (no edges, no face...) is never kept as a broken
 * step: OK (`explicit`) says what's missing and stays open, and anything else that ends the session drops it.
 */
export function commitSession(explicit = false) {
  const { session, doc, regen, builtDoc } = get();
  if (!session) return;
  const st = session.isNew && builtDoc === doc ? regen?.status.find((x) => x.id === session.featureId) : undefined;
  if (st?.state === "incomplete") {
    if (explicit) return toast("info", st.message ?? "Finish the selection first.");
    return set({ doc: session.base, session: null });
  }
  set({ session: null });
  if (session.isolated) {
    // Marker back where it was; nothing edited means nothing to record.
    if (session.stack.length === 0) return set({ doc: session.base });
    return commitFinal(session, produce(doc, (d) => void (d.rollback = session.base.rollback)));
  }
  if (doc === session.base) return;
  commitFinal(session, doc);
}

function commitFinal(session: Session, doc: WhittleDocument) {
  // Record the whole session as one undo step, from the pre-session state.
  set({ doc: session.base });
  const next = history.apply(session.base, session.label, () => doc as Draft<WhittleDocument>);
  set({ doc: next, dirty: true, historyTick: get().historyTick + 1 });
}

export function cancelSession() {
  const { session, mode } = get();
  if (!session) return;
  set({
    doc: session.base,
    session: null,
    selection: [],
    selectedEntity: null,
    mode: mode.kind === "sketch" ? { kind: "model" } : mode,
  });
}

/** Keep body metadata in sync with a feature's operation. */
export function setBodyOp(id: Id, op: "new" | "join" | "cut" | "intersect") {
  mutate("Change operation", (d) => {
    const f = d.features.find((x) => x.id === id);
    if (!f || !isBodyFeature(f as Feature)) return;
    (f as { op: string }).op = op;
    // A sketch on a face points out of the body: cutting should go into it, and joining back out.
    if (f.type === "extrude" && f.extent === "one") {
      const sk = d.features.find((x) => x.id === f.sketch);
      if (sk?.type === "sketch" && sk.plane.kind === "face") f.flip = op === "cut";
    }
  });
}

export function updateFeature(id: Id, label: string, recipe: (f: Draft<Feature>) => void, mergeKey?: string) {
  mutate(
    label,
    (d) => {
      const f = d.features.find((x) => x.id === id);
      if (f) recipe(f);
    },
    mergeKey,
  );
}

export function deleteFeature(id: Id) {
  const { session } = get();
  if (session?.featureId === id) {
    if (session.isNew) return cancelSession();
    commitSession();
  }
  const f = findFeature(get().doc, id);
  if (!f) return;
  mutate(`Delete ${f.name}`, (d) => {
    const i = d.features.findIndex((x) => x.id === id);
    if (i < 0) return;
    d.features.splice(i, 1);
    delete d.bodies[id];
    if (d.rollback !== null && i < d.rollback) d.rollback--;
  });
  set({ selection: [] });
}

/** Move a timeline step to a new position (refused, with the reason, if it would break the design). */
export function moveFeature(from: number, to: number) {
  const { doc, session } = get();
  if (session) commitSession();
  const problem = reorderProblem(doc, from, to);
  if (problem) return toast("warn", problem);
  const f = doc.features[from];
  if (!f || from === to) return;
  mutate(`Move ${f.name}`, (d) => {
    const [x] = d.features.splice(from, 1);
    d.features.splice(to, 0, x!);
  });
}

/** Delete a feature, warning first when later steps depend on it. */
export async function confirmDeleteFeature(id: Id) {
  const { doc } = get();
  const f = findFeature(doc, id);
  if (!f) return;
  const deps = dependents(doc, id);
  if (
    deps.length &&
    !(await ask({
      title: `Delete ${f.name}?`,
      message: `${deps.length} later step${deps.length > 1 ? "s depend" : " depends"} on it and may fail until you fix ${deps.length > 1 ? "them" : "it"}:`,
      details: deps.map((d) => d.name),
      confirmLabel: "Delete anyway",
      danger: true,
    }))
  )
    return;
  deleteFeature(id);
}

/* ───────────────────────────── Sketch mode ───────────────────────────── */

export function enterSketch(sketchId: Id, isNew: boolean) {
  const { session } = get();
  if (session && session.featureId !== sketchId) commitSession();
  const f = findFeature(get().doc, sketchId, "sketch");
  if (!f) return;
  if (!get().session) set({ session: { featureId: sketchId, isNew, base: get().doc, label: `Edit ${f.name}`, stack: [] } });
  set({
    mode: { kind: "sketch", sketchId, tool: isNew ? "rect" : "select", isNew },
    selection: [],
    hover: null,
    selectedEntity: null,
    sketchSel: [],
    pendingConstraint: null,
    viewRequest: { kind: "normal", at: Date.now() },
  });
}

export function setSketchTool(tool: SketchTool) {
  const { mode } = get();
  if (mode.kind === "sketch") set({ mode: { ...mode, tool }, selectedEntity: tool === "select" ? get().selectedEntity : null, pendingConstraint: null });
}

export function finishSketch() {
  const { mode, doc } = get();
  if (mode.kind !== "sketch") return;
  const sk = findFeature(doc, mode.sketchId, "sketch");
  const empty = !sk || (sk.entities.length === 0 && !sk.geometry?.length);
  if (mode.isNew && empty) {
    cancelSession();
    set({ mode: { kind: "model" } });
    toast("info", "Empty sketch discarded");
    return;
  }
  commitSession();
  set({
    mode: { kind: "model" },
    selectedEntity: null,
    sketchSel: [],
    pendingConstraint: null,
    selection: sk ? [{ kind: "sketch", sketchId: sk.id }] : [],
  });
  if (mode.isNew && sk) toast("ok", "Sketch finished. Press E to extrude it.", undefined, true);
}

export function sketchMutate(label: string, recipe: (s: Draft<SketchFeature>) => void, mergeKey?: string) {
  const { mode } = get();
  if (mode.kind !== "sketch") return;
  mutate(
    label,
    (d) => {
      const f = d.features.find((x) => x.id === mode.sketchId);
      if (f && f.type === "sketch") recipe(f);
    },
    mergeKey,
  );
}

export function addEntity(e: SketchEntity) {
  sketchMutate("Add shape", (s) => {
    s.entities.push(e as Draft<SketchEntity>);
  });
  set({ selectedEntity: e.id });
}

export function deleteEntity(id: Id) {
  sketchMutate("Delete shape", (s) => {
    s.entities = s.entities.filter((e) => e.id !== id);
  });
  set({ selectedEntity: null });
}

/* ───────────────────────────── UI helpers ───────────────────────────── */

let toastId = 0;
export function toast(kind: Toast["kind"], text: string, action?: Toast["action"], nextStep?: boolean) {
  const id = ++toastId;
  set({ toasts: [...get().toasts.slice(-3), { id, kind, text, action, nextStep }] });
  setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), action ? 7000 : 3200);
}

/** Use preferences loaded from the person's saved settings (they are not saved again). */
export function applyLoadedPrefs(saved: Partial<Prefs>) {
  const prefs = normalizePrefs(saved);
  const theme = resolveTheme(prefs.theme);
  applyPrefs(prefs, theme);
  set({ prefs, theme });
}

export function setTheme(theme: ThemePref) {
  setPrefs({ theme });
}

/** Change preferences: applied immediately and remembered on this device. */
export function setPrefs(patch: Partial<Prefs>) {
  const prefs = { ...get().prefs, ...patch };
  const theme = resolveTheme(prefs.theme);
  savePrefs(prefs);
  applyPrefs(prefs, theme);
  set({ prefs, theme });
}

export function requestView(kind: "home" | "fit" | "normal") {
  set({ viewRequest: { kind, at: Date.now() } });
}

export function setView(patch: Partial<ViewSettings>) {
  set({ view: { ...get().view, ...patch } });
}

export function selectedBodyId(): Id | undefined {
  const sel = get().selection;
  for (const p of sel) {
    if (p.kind === "body" || p.kind === "face" || p.kind === "edge") return p.bodyId;
  }
  return undefined;
}