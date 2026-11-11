/**
 * Guided lessons for the coach card: each step ticks itself off from the design's state,
 * so people learn by doing it in the real app, not by reading.
 */
import { type Feature, type OriginPlane, parameterUses } from "@whittle/core";
import { type AppState, useApp } from "./store";
import { commandById } from "./commands";

export interface LessonStep {
  title: string;
  body: string;
  done: (s: AppState) => boolean;
  /** The origin plane this step asks for: while a plane is being picked it is lit and the others dimmed. */
  plane?: OriginPlane;
}

export interface Lesson {
  id: string;
  title: string;
  blurb: string;
  minutes: number;
  steps: LessonStep[];
}

const drawn = (f: Feature) => f.type === "sketch" && f.entities.length + (f.geometry?.length ?? 0) > 0;
/** A feature of this type that is applied (not the one still being edited). */
const made = <T extends Feature["type"]>(s: AppState, type: T, ok: (f: Extract<Feature, { type: T }>) => boolean = () => true) =>
  s.doc.features.some((f) => f.type === type && s.session?.featureId !== f.id && ok(f as Extract<Feature, { type: T }>));
const sketchOn = (s: AppState, plane: string) => s.doc.features.find((f) => f.type === "sketch" && f.plane.kind === "origin" && f.plane.plane === plane);

/** The value each parameter had when first seen, to notice it being changed. */
const firstExpr = new Map<string, string>();

export const LESSONS: Lesson[] = [
  {
    id: "first",
    title: "Your first part",
    blurb: "Sketch, extrude, round the edges, export.",
    minutes: 2,
    steps: [
      {
        title: "Start a sketch",
        // Ticked only once the sketch exists, not while a plane is still being picked (audit B-1).
        get body() {
          const s = useApp.getState();
          const other = s.doc.features.find((f) => f.type === "sketch" && !(f.plane.kind === "origin" && f.plane.plane === "XY"));
          if (other?.type === "sketch") return `That sketch is on ${other.plane.kind === "origin" ? `the ${other.plane.plane} plane` : "a face"}, not the flat one. Press Ctrl+Z, then press S and click the flat XY · Top plane.`;
          return s.mode.kind === "pickPlane" ? "Now click the flat XY · Top plane, the one lying on the ground (it is lit up)." : "Press S (or the Sketch button), then click the flat XY · Top plane.";
        },
        plane: "XY",
        done: (s) => !!sketchOn(s, "XY"),
      },
      { title: "Draw a rectangle", body: "Click one corner, then the other. Or type 60, Tab, 40, Enter for an exact size.", done: (s) => s.doc.features.some(drawn) },
      { title: "Finish the sketch", body: "Press Esc or click Finish sketch (top right).", done: (s) => s.doc.features.some(drawn) && s.mode.kind !== "sketch" },
      { title: "Extrude it", body: "Press E, type a height (try 12), press Enter.", done: (s) => made(s, "extrude") },
      { title: "Round the edges", body: "Click an edge (Shift-click for more), press F, set a radius, press Enter.", done: (s) => made(s, "fillet", (f) => f.edges.length > 0) },
      { title: "Share or make it", body: "Export: STEP for other CAD and machining, 3MF or STL for 3D printing.", done: (s) => s.panel === "export" },
    ],
  },
  {
    id: "cup",
    title: "Turn a cup",
    blurb: "Revolve a profile, hollow it, round the rim.",
    minutes: 4,
    steps: [
      { title: "Sketch on the front plane", body: "Press S, then click the upright XZ · Front plane (it is lit up while you pick).", plane: "XZ", done: (s) => !!sketchOn(s, "XZ") },
      { title: "Draw half of the cup", body: "Draw a rectangle that starts on the vertical axis and goes right: its width is the cup's radius, its height the cup's height.", done: (s) => { const f = sketchOn(s, "XZ"); return !!f && drawn(f); } },
      { title: "Finish the sketch", body: "Press Esc or click Finish sketch.", done: (s) => { const f = sketchOn(s, "XZ"); return !!f && drawn(f) && s.mode.kind !== "sketch"; } },
      { title: "Revolve it", body: "Press R. Choose the vertical axis and keep 360°, then press Enter.", done: (s) => made(s, "revolve") },
      { title: "Hollow it", body: "Choose Shell, click the top face so it stays open, set a 2 mm wall, press Enter.", done: (s) => made(s, "shell", (f) => f.faces.length > 0) },
      { title: "Round the rim", body: "Press F, click the rim's edges (inside and out), set 1 mm, press Enter.", done: (s) => made(s, "fillet", (f) => f.edges.length > 0) },
    ],
  },
  {
    id: "plate",
    title: "A plate with screw holes",
    blurb: "Box, holes, countersinks, rounded corners, measure.",
    minutes: 4,
    steps: [
      { title: "Add a box", body: "Shape › Box (or Ctrl+K, type box). Make it 80 × 50 × 6 and press Enter.", done: (s) => made(s, "primitive", (f) => f.shape === "box") },
      { title: "Drill holes", get body() { return `Press ${commandById("hole")?.keys ?? "the Hole button"} (Hole), click the top face, then click to place two or more holes. Press Enter.`; }, done: (s) => made(s, "hole", (f) => f.points.length >= 2) },
      { title: "Countersink them", body: "Double-click the Hole step in the timeline, choose Countersink, press Enter.", done: (s) => made(s, "hole", (f) => f.style === "countersink") },
      { title: "Soften the corners", body: "Click the four upright corner edges (Shift adds), press F, set 5 mm, press Enter.", done: (s) => made(s, "fillet", (f) => f.edges.length > 0) },
      { title: "Check a size", body: "Press I (Measure) and click a hole's edge to read its diameter.", done: (s) => s.mode.kind === "measure" && s.measure.length > 0 },
    ],
  },
  {
    id: "params",
    title: "Change one number, update everything",
    blurb: "Named parameters that drive the design.",
    minutes: 3,
    steps: [
      { title: "Create a parameter", body: "Open Parameters (the fx button, top right). Add one named width with the value 60 mm.", done: (s) => s.doc.parameters.length > 0 },
      {
        title: "Use it in a sketch",
        // Constraint-ready shapes (the default) have a width dimension, whole shapes a Width box (audit G-1).
        get body() {
          return useApp.getState().prefs.smartSketch === false
            ? "Sketch on XY, draw a rectangle, then type width in its Width box. Formulas work too: width / 2."
            : "Sketch on XY, draw a rectangle, then double-click its width dimension and type width. Formulas work too: width / 2.";
        },
        done: (s) => s.doc.parameters.some((p) => parameterUses({ parameters: [], features: s.doc.features.filter((f) => f.type === "sketch") }, p.name) > 0),
      },
      { title: "Extrude it", body: "Finish the sketch, press E, press Enter.", done: (s) => made(s, "extrude") },
      {
        title: "Change the parameter",
        body: "In Parameters, set width to 90 and watch the model follow.",
        done: (s) =>
          s.doc.parameters.some((p) => {
            if (!firstExpr.has(p.id)) firstExpr.set(p.id, p.expr);
            return firstExpr.get(p.id) !== p.expr;
          }),
      },
    ],
  },
];

export const lessonById = (id: string) => LESSONS.find((l) => l.id === id);

/** Steps stay ticked once done in order (closing a panel never unticks one). */
const ticked = new Set<string>();

/** A lesson started again starts with nothing ticked (audit G-2). */
export function untickLesson(id: string) {
  for (const k of [...ticked]) if (k.startsWith(`${id}:`)) ticked.delete(k);
}

/** Which steps of the running lesson are done, and the one to do now (-1 when all are done). */
export function lessonProgress(s: AppState): { lesson: Lesson; done: boolean[]; current: number } | null {
  const lesson = s.coach ? LESSONS.find((l) => l.id === s.coach) : undefined;
  if (!lesson) return null;
  let before = true;
  const done = lesson.steps.map((st, i) => {
    const key = `${lesson.id}:${i}`;
    if (!ticked.has(key) && before && st.done(s)) ticked.add(key);
    before = ticked.has(key);
    return before;
  });
  const current = done.indexOf(false);
  if (current === -1) markLessonDone(lesson.id);
  return { lesson, done, current };
}

/** The plane the running lesson asks for right now, if any. */
export function lessonPlane(s: AppState): OriginPlane | null {
  const p = lessonProgress(s);
  return p && p.current >= 0 ? (p.lesson.steps[p.current]!.plane ?? null) : null;
}

const DONE_KEY = "whittle-lessons-done";

/** Lessons finished on this device, so the start screen can stop leading with the first one. */
export function lessonsDone(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DONE_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function markLessonDone(id: string) {
  try {
    const done = lessonsDone();
    if (!done.includes(id)) localStorage.setItem(DONE_KEY, JSON.stringify([...done, id]));
  } catch {
    /* private window: nothing to remember */
  }
}
