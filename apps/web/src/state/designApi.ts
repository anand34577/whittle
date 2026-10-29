/**
 * The design API: a small, stable set of operations that read and change the
 * open design. It's what AI assistants call (as tools), and it's exposed as
 * `window.whittle.api` for scripts and automation.
 *
 * Every operation is plain JSON in and out, validated before it touches the
 * document, applied as one undoable step, and answered only after the model
 * has rebuilt, so the caller sees the real outcome (including errors and
 * suggested fixes) and can correct itself.
 */
import { problemsOf } from "./problems";
import type { Draft } from "immer";
import {
  type EdgeRef,
  LENGTH_TO_MM,
  type FaceRef,
  type Feature,
  type FeatureType,
  type Id,
  type OriginPlane,
  type PlaneRef,
  type ConstraintType,
  type SketchEntity,
  type SketchFeature,
  type Vec2,
  type WhittleDocument,
  CONSTRAINT_LABELS,
  FEATURE_LABELS,
  SKETCH_REFS,
  addArc,
  addCircle,
  addEllipse,
  pointAt,
  addConstraint,
  addLine,
  addPoint,
  bakeSolution,
  deleteGeometry,
  extendGeometry,
  geomById,
  trimGeometry,
  activeEnd,
  documentEvaluator,
  featureValueIssues,
  formatQuantity,
  makeChamfer,
  makeCoil,
  makeCombine,
  makeDraft,
  makeExtrude,
  makeFillet,
  makeHole,
  makeLoft,
  makeMirror,
  makeMove,
  makeOffset,
  makeBoundingSolid,
  makePattern,
  makePrimitive,
  makeRevolve,
  makeScale,
  makeShell,
  makeSketch,
  makeSplit,
  makeSweep,
  uid,
  validateParamName,
  maxRectCorner,
  trim,
} from "@whittle/core";
import type { BodyResult } from "@whittle/kernel";
import { commitSession, history, mutate, undo, useApp } from "./store";
import { LOOKS } from "../viewport/looks";

export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

const num = { type: ["number", "string"], description: "A number (in the design's length unit, see `units` in get_design; degrees for angles) or a formula using parameters, e.g. \"width / 2\"" };

const FACE_SELECTOR = {
  type: "string",
  enum: ["top", "bottom", "front", "back", "left", "right"],
  description: "A flat face by direction: top (+Z), bottom (-Z), front (-Y), back (+Y), left (-X), right (+X). The outermost such face is used.",
};

export const DESIGN_TOOLS: ToolDef[] = [
  {
    name: "get_design",
    description:
      "Read the open design: units, parameters, every feature in timeline order (with its settings and build status; sketches with several enclosed areas list a point inside each as `regions`), every body (size, volume, bounding box), `problems` (failed steps, conflicting sketches, unfinished work), and what the person has selected in the view (`selection`: when they say \"this\" or \"these\", they mean it). Call this first, and again after changes when you need ids.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_parameter",
    description: "Create or change a named parameter. Every field in the design can then use it in formulas (e.g. \"wall * 2\").",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Letters, digits and _ (starts with a letter)" },
        value: num,
        kind: { type: "string", enum: ["length", "angle", "number", "count"] },
        comment: { type: "string" },
      },
      required: ["name", "value"],
    },
  },
  {
    name: "add_sketch",
    description:
      "Add a 2D sketch with shapes, on an origin plane (optionally offset and tilted) or on a flat face of a body. Closed shapes inside other closed shapes become holes. Coordinates are in the sketch plane: XY plane uses world X/Y; XZ uses X and Z; YZ uses Y and Z. Returns the sketch id for extrude, revolve, loft and sweep.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        plane: { type: "string", enum: ["XY", "XZ", "YZ"], description: "Origin plane (ignored when `on_body` is given)" },
        offset: num,
        tilt_angle: { ...num, description: "Tilt the plane by this angle about its own X axis" },
        on_body: { type: "string", description: "Body name or id to sketch on" },
        face: FACE_SELECTOR,
        shapes: {
          type: "array",
          description: "Shapes to draw",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["rect", "circle", "polygon", "slot", "ellipse", "polyline", "path", "text", "gear"] },
              x: num,
              y: num,
              width: num,
              height: num,
              radius: num,
              diameter: num,
              sides: num,
              length: num,
              corner_radius: num,
              angle: num,
              rx: num,
              ry: num,
              points: {
                type: "array",
                items: { type: "array", minItems: 2, maxItems: 3 },
                description: 'polyline (closed outline) or path (open line) points: [x, y], or [x, y, "arc"] to make that point the middle of a three-point arc between its neighbours',
              },
              smooth: { type: "boolean" },
              text: { type: "string" },
              size: num,
              teeth: num,
              module: num,
              bore: num,
              hole: { type: "boolean", description: "Force this shape to be a hole" },
              construction: { type: "boolean" },
            },
            required: ["type"],
          },
        },
      },
      required: ["shapes"],
    },
  },
  {
    name: "constrain_sketch",
    description:
      "Professional parametric sketching on an existing sketch: add points, lines, arcs and circles that a constraint solver positions, then constraints (coincident, horizontal, vertical, parallel, perpendicular, tangent, equal, fixed, symmetric, midpoint, collinear) and driving dimensions (distance, radius, diameter of a circle, angle) whose values may be formulas using parameters. Positions and sizes you give are rough guesses in the design's units; constraints and dimensions make them exact. Closed loops of lines/arcs become solid profiles (inner loops become holes). Also trims and extends. Returns the ids of what you named and the solver state: 'full' (fully defined), 'under' (dof = freedoms left), 'over' (conflicting/redundant, with a message naming them) or 'error'.",
    input_schema: {
      type: "object",
      properties: {
        sketch: { type: "string", description: "Sketch name or id" },
        geometry: {
          type: "array",
          description:
            'Geometry to add, in order. Each item: {name, type: "point", at: [x, y]} | {name, type: "line", from, to} | {name, type: "arc", from, to, through: [x, y]} | {name, type: "circle", center, radius} | {name, type: "ellipse", center, major: [x, y] (the end of its longer axis), minor (the shorter radius)}. from / to / center are [x, y] or a reference to an existing point: a point name, or "<line or arc>.start", ".end", ".center", "<ellipse>.major", or "origin". Reusing a point joins the curves there. The major radius of an ellipse is a distance from its .center to its .major point; its minor radius is a radius dimension on it.',
          items: { type: "object", properties: { name: { type: "string" }, type: { type: "string", enum: ["point", "line", "arc", "circle", "ellipse"] } }, required: ["type"] },
        },
        constraints: {
          type: "array",
          description:
            'Constraints to add: {type, refs, value?}. refs are geometry names/ids, point references like "L1.start", or "origin", "xaxis", "yaxis". symmetric: [point, point, line] or [point, point, centre point]; midpoint: [point, line]; collinear: [line, line]; concentric: [circle or arc, circle or arc]; distance: [line] (length), [point, point], [point, line] or [line, line]; radius: [circle or arc]; angle: [line] (from horizontal) or [line, line]. value is in the design units (degrees for angles) or a formula.',
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["coincident", "horizontal", "vertical", "parallel", "perpendicular", "tangent", "equal", "fixed", "symmetric", "midpoint", "collinear", "concentric", "distance", "radius", "diameter", "angle"] },
              refs: { type: "array", items: { type: "string" } },
              value: num,
            },
            required: ["type", "refs"],
          },
        },
        trim: { type: "array", description: "Pieces to cut away: {curve, at: [x, y]} removes the piece of that curve around `at`, between the nearest crossings.", items: { type: "object" } },
        extend: { type: "array", description: "{curve, at: [x, y]} stretches the end of a line or arc nearest `at` to the next curve.", items: { type: "object" } },
        delete: { type: "array", items: { type: "string" }, description: "Geometry or constraint names/ids to delete" },
      },
      required: ["sketch"],
    },
  },
  {
    name: "add_feature",
    description: `Add a 3D feature at the end of the timeline. Types: ${[
      "extrude {sketch, distance, extent: one|symmetric|two|through|face (through = all bodies; face = stop exactly at to_face: {body, face: top|bottom|front|back|left|right}), distance2, flip, taper, twist, thin (wall thickness: walls along outlines, open paths become ribs), thinSide: center|inside|outside, op, regions: [[x, y], ...] (optional: only the sketch areas holding these points, e.g. just the circle inside a rectangle; unset = the whole sketch with inner shapes as holes)}",
      "revolve {sketch, axis: x|y|line (line = the sketch's first path or construction line), angle, extent: one|symmetric|two (symmetric splits the angle either side of the sketch; two turns angle one way and angle2 the other), angle2, op, regions}",
      "loft {sketches: [ids], ruled, op}",
      "sweep {profile, path, orientation: fixed|frenet, op}",
      "primitive {shape: box|cylinder|sphere|cone|torus|tube, width, depth, height, radius, radius2, position: [x,y,z], op}",
      "coil {section: circle|triangle|square, radius, pitch, height, size, lefthand, position, op}",
      "fillet {body, edges: selector, radius}",
      "chamfer {body, edges: selector, distance, mode: equal|two|angle, distance2 (two), angle (angle, degrees), flip}",
      "shell {body, face: selector (\"none\": closed, hollow inside), thickness, direction: inside|outside|both (which way the wall grows from the surface; default inside)}",
      "hole {body, face: selector, points: [[x,y]...] in the face frame, diameter, through, depth, style: simple|counterbore|countersink, headDiameter, headDepth, sinkAngle (deg, default 90), tipAngle (deg drill point of a blind hole, default 118; \"\" for a flat bottom)}",
      "draft {body, faces: 'sides', angle, pull: x|y|z}",
      "mirror {body, plane: XY|XZ|YZ, offset (moves the plane along its normal), merge, features: [earlier feature names to mirror instead of the whole body]}",
      "pattern {body, pattern: linear|circular, axis: x|y|z, count, spacing, angle, axis2, count2, spacing2 (a second linear direction makes a grid), merge, features: [earlier feature names to repeat instead of the whole body, e.g. one boss or cut]}",
      "move {body, translate: [x,y,z], axis, angle, copy}",
      "combine {target, tools: [bodies], op: join|cut|intersect, keepTools}",
      "split {body, plane, offset, keep: both|above|below}",
      "offset {body, distance, copy}",
      "scale {body, factor, center: body|origin, copy}",
      "boundingSolid {bodies: [bodies to enclose, empty = all], shape: box|cylinder, padding, axis: x|y|z} (a new body around others: machining stock, a case blank)",
    ].join("; ")}. op is new|join|cut|intersect (with optional target body). Bodies and sketches can be named or given by id. Edge selectors: all, top, bottom, vertical, circular, or selected (what the person picked in the view); face selectors: top, bottom, front, back, left, right, or selected. Returns the feature id and whether it built.`,
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["extrude", "revolve", "loft", "sweep", "primitive", "coil", "fillet", "chamfer", "shell", "hole", "draft", "mirror", "pattern", "move", "combine", "split", "offset", "scale", "boundingSolid"] },
        name: { type: "string" },
        settings: { type: "object", description: "The settings listed for this type" },
      },
      required: ["type", "settings"],
    },
  },
  {
    name: "update_feature",
    description: "Change settings of an existing feature or sketch (by id or name). Same settings as add_feature. For a sketch, pass {shapes} to replace its shapes.",
    input_schema: {
      type: "object",
      properties: { feature: { type: "string" }, settings: { type: "object" }, suppressed: { type: "boolean" }, name: { type: "string" } },
      required: ["feature"],
    },
  },
  {
    name: "delete_feature",
    description: "Delete a feature or sketch (by id or name). Later features that used it may fail.",
    input_schema: { type: "object", properties: { feature: { type: "string" } }, required: ["feature"] },
  },
  {
    name: "set_body_appearance",
    description: "Rename a body or set its color (#rrggbb) and finish.",
    input_schema: {
      type: "object",
      properties: { body: { type: "string" }, name: { type: "string" }, color: { type: "string" }, finish: { type: "string", enum: LOOKS.map((l) => l.id), description: "glass is clear (see-through)" }, visible: { type: "boolean" }, opacity: { type: "number", description: "0.05 (nearly invisible) to 1 (solid)" } },
      required: ["body"],
    },
  },
  {
    name: "undo",
    description: "Undo the last change.",
    input_schema: { type: "object", properties: {} },
  },
];

/* ───────────────────────────── Helpers ───────────────────────────── */

class ApiInputError extends Error {}

const doc = () => useApp.getState().doc;
const bodies = (): BodyResult[] => useApp.getState().regen?.bodies ?? [];

/** Numbers become expressions; strings pass through (formulas). */
function ex(v: unknown, fallback?: string, name?: string): string {
  if (v === undefined || v === null || v === "") {
    if (fallback !== undefined) return fallback;
    throw new ApiInputError(name ? `${name} is required.` : "A required value is missing.");
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new ApiInputError("Numbers must be finite.");
    return String(Math.round(v * 1e6) / 1e6);
  }
  if (typeof v === "string") return v.trim();
  throw new ApiInputError(`Expected a number or formula, got ${JSON.stringify(v)}.`);
}

function findFeatureRef(ref: unknown): Feature {
  if (typeof ref !== "string") throw new ApiInputError("Name a feature by id or name.");
  const d = doc();
  const f = d.features.find((x) => x.id === ref) ?? d.features.find((x) => x.name.toLowerCase() === ref.toLowerCase());
  if (!f) throw new ApiInputError(`No feature called "${ref}". Call get_design to see the timeline.`);
  return f;
}

function bodyRef(ref: unknown): Id {
  if (typeof ref !== "string") throw new ApiInputError("Name a body by id or name.");
  const d = doc();
  if (d.bodies[ref]) return ref;
  const hit = Object.entries(d.bodies).find(([, b]) => b.name.toLowerCase() === ref.toLowerCase());
  if (!hit) throw new ApiInputError(`No body called "${ref}". Bodies: ${Object.values(d.bodies).map((b) => b.name).join(", ") || "none yet"}.`);
  return hit[0];
}

function sketchRef(ref: unknown): Id {
  const f = findFeatureRef(ref);
  if (f.type !== "sketch") throw new ApiInputError(`"${f.name}" is a ${f.type}, not a sketch.`);
  return f.id;
}

function bodyMesh(id: Id): BodyResult {
  const b = bodies().find((x) => x.id === id);
  if (!b) throw new ApiInputError("That body isn't built yet (or failed). Check its status with get_design.");
  return b;
}

const DIRS: Record<string, [number, number, number]> = { top: [0, 0, 1], bottom: [0, 0, -1], front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0] };

function faceBySelector(id: Id, sel: unknown): FaceRef {
  if (sel === "selected") {
    const p = useApp.getState().selection.find((x) => x.kind === "face" && x.bodyId === id);
    const f = p?.kind === "face" ? bodyMesh(id).faces[p.index] : undefined;
    if (!f) throw new ApiInputError("No face of that body is selected. Ask the person to click one, or use top, bottom, front, back, left or right.");
    return { bodyId: id, ...f };
  }
  const dir = DIRS[String(sel)];
  if (!dir) throw new ApiInputError(`Face selector must be one of ${Object.keys(DIRS).join(", ")}, selected.`);
  const b = bodyMesh(id);
  let best: { i: number; d: number } | null = null;
  b.faces.forEach((f, i) => {
    if (f.surface !== "PLANE") return;
    const n = f.normal[0] * dir[0] + f.normal[1] * dir[1] + f.normal[2] * dir[2];
    if (n < 0.999) return;
    const d = f.center[0] * dir[0] + f.center[1] * dir[1] + f.center[2] * dir[2];
    if (!best || d > best.d + 1e-6 || (Math.abs(d - best.d) < 1e-6 && f.area > b.faces[best.i]!.area)) best = { i, d };
  });
  if (!best) throw new ApiInputError(`The body has no flat ${String(sel)} face.`);
  return { bodyId: id, ...b.faces[(best as { i: number }).i]! };
}

function edgesBySelector(id: Id, sel: unknown): EdgeRef[] {
  const b = bodyMesh(id);
  if (sel === "selected") {
    // The edges the person picked, plus every edge of a picked face.
    const idx = new Set<number>();
    for (const p of useApp.getState().selection) {
      if (p.kind === "edge" && p.bodyId === id) idx.add(p.index);
      if (p.kind === "face" && p.bodyId === id) for (const i of b.faceEdges[p.index] ?? []) idx.add(i);
    }
    if (!idx.size) throw new ApiInputError("No edges of that body are selected. Ask the person to click them, or use a selector such as vertical.");
    return [...idx].map((i) => b.edges[i]!).map((e) => ({ bodyId: id, mid: e.mid, tangent: e.tangent, curve: e.curve, length: e.length }));
  }
  const [lo, hi] = b.bbox;
  const tol = Math.max(1e-3, (hi[2] - lo[2]) * 1e-4);
  const pick = b.edges.filter((e) => {
    switch (String(sel ?? "all")) {
      case "all":
        return true;
      case "top":
      case "outer-top":
        return Math.abs(e.mid[2] - hi[2]) < tol && Math.abs(e.tangent[2]) < 1e-3;
      case "bottom":
        return Math.abs(e.mid[2] - lo[2]) < tol && Math.abs(e.tangent[2]) < 1e-3;
      case "vertical":
        return Math.abs(Math.abs(e.tangent[2]) - 1) < 1e-3;
      case "circular":
        return e.curve === "CIRCLE";
      default:
        throw new ApiInputError(`Edge selector must be one of all, top, bottom, vertical, circular, selected.`);
    }
  });
  if (!pick.length) throw new ApiInputError(`No ${String(sel)} edges on that body.`);
  return pick.map((e) => ({ bodyId: id, mid: e.mid, tangent: e.tangent, curve: e.curve, length: e.length }));
}

function entityFrom(s: Record<string, unknown>): SketchEntity {
  const id = uid("e");
  const base = { id, construction: !!s.construction, ...(s.hole ? { mode: "subtract" as const } : {}) };
  const x = ex(s.x, "0");
  const y = ex(s.y, "0");
  const r = s.diameter !== undefined ? `(${ex(s.diameter)}) / 2` : ex(s.radius, "5");
  switch (s.type) {
    case "rect": {
      // Refuse a corner radius that can't fit, rather than quietly rounding the rectangle into a pill.
      const [w, h, c] = [Number(s.width), Number(s.height), Number(s.corner_radius ?? 0)];
      if (c < 0) throw new ApiInputError("corner_radius can't be negative.");
      if (w > 0 && h > 0 && c > maxRectCorner(w, h) + 1e-9) throw new ApiInputError(`corner_radius ${c} is too big for a ${w} x ${h} rectangle: the largest that fits is ${trim(maxRectCorner(w, h), 2)}.`);
      return { ...base, type: "rect", x, y, w: ex(s.width, undefined, "width"), h: ex(s.height, undefined, "height"), anchor: "center", ...(s.corner_radius ? { corner: ex(s.corner_radius) } : {}), ...(s.angle ? { angle: ex(s.angle) } : {}) };
    }
    case "circle":
      return { ...base, type: "circle", cx: x, cy: y, r };
    case "polygon":
      return { ...base, type: "polygon", cx: x, cy: y, r, sides: ex(s.sides, "6"), angle: ex(s.angle, "0") };
    case "slot":
      return { ...base, type: "slot", cx: x, cy: y, length: ex(s.length, undefined, "length"), width: ex(s.width, undefined, "width"), angle: ex(s.angle, "0") };
    case "ellipse":
      return { ...base, type: "ellipse", cx: x, cy: y, rx: ex(s.rx, undefined, "rx"), ry: ex(s.ry, undefined, "ry"), angle: ex(s.angle, "0") };
    case "polyline":
    case "path": {
      const pts = s.points;
      if (!Array.isArray(pts) || pts.length < (s.type === "path" ? 2 : 3)) throw new ApiInputError(`A ${s.type} needs at least ${s.type === "path" ? 2 : 3} points.`);
      return {
        ...base,
        type: "polyline",
        points: pts.map((p) => {
          if (!Array.isArray(p) || p.length < 2 || p.length > 3 || (p.length === 3 && p[2] !== "arc")) throw new ApiInputError('Each point is [x, y] or [x, y, "arc"].');
          return p[2] === "arc" ? ([ex(p[0]), ex(p[1]), "arc"] as const) : ([ex(p[0]), ex(p[1])] as [string, string]);
        }),
        ...(s.smooth ? { smooth: true } : {}),
        ...(s.corner_radius ? { corner: ex(s.corner_radius) } : {}),
        ...(s.type === "path" ? { open: true } : {}),
      };
    }
    case "text":
      return { ...base, type: "text", x, y, text: String(s.text ?? "Text"), size: ex(s.size, "10"), angle: ex(s.angle, "0") };
    case "gear":
      return { ...base, type: "gear", cx: x, cy: y, teeth: ex(s.teeth, "20"), module: ex(s.module, "2"), bore: ex(s.bore, "5") };
    default:
      throw new ApiInputError(`Unknown shape type "${String(s.type)}".`);
  }
}

const EXPR_KEYS = new Set([
  "distance", "distance2", "taper", "twist", "angle", "width", "depth", "height", "radius", "radius2", "pitch", "size", "thickness",
  "diameter", "headDiameter", "headDepth", "sinkAngle", "count", "spacing", "offset", "factor", "neutral", "scale", "padding", "thin", "count2", "spacing2", "angle2",
]);
/** The words each setting takes (any feature that has it); anything else is refused rather than half-understood. */
const ENUMS: Record<string, string[]> = {
  extent: ["one", "symmetric", "two", "through", "face"],
  mode: ["equal", "two", "angle"],
  op: ["new", "join", "cut", "intersect"],
  axis: ["x", "y", "z", "line"],
  axis2: ["x", "y", "z"],
  thinSide: ["center", "inside", "outside"],
  shape: ["box", "cylinder", "sphere", "cone", "torus", "tube"],
  orientation: ["fixed", "frenet"],
  section: ["circle", "triangle", "square"],
  style: ["simple", "counterbore", "countersink"],
  plane: ["XY", "XZ", "YZ"],
  pattern: ["linear", "circular", "path"],
  keep: ["both", "above", "below"],
  center: ["body", "origin"],
  pull: ["x", "y", "z"],
  direction: ["inside", "outside", "both"],
};
/** Words models often use for an operation. A silent mistake here builds the wrong shape (an unknown op cut like intersect). */
const OP_WORDS: Record<string, string> = { add: "join", union: "join", fuse: "join", merge: "join", subtract: "cut", remove: "cut", difference: "cut", common: "intersect", intersection: "intersect", create: "new", body: "new" };
const BOOL_KEYS = new Set(["flip", "ruled", "lefthand", "through", "merge", "copy", "keepTools"]);
const ENUM_KEYS = new Set([...Object.keys(ENUMS), ...BOOL_KEYS]);

function enumValue(k: string, v: unknown): unknown {
  if (BOOL_KEYS.has(k)) {
    if (typeof v === "boolean") return v;
    if (v === "true" || v === "false") return v === "true";
    throw new ApiInputError(`${k} is true or false.`);
  }
  const allowed = ENUMS[k]!;
  const word = typeof v === "string" ? v.trim() : "";
  const hit = allowed.find((a) => a.toLowerCase() === word.toLowerCase()) ?? (k === "op" ? OP_WORDS[word.toLowerCase()] : undefined);
  if (!hit) throw new ApiInputError(`${k} is one of ${allowed.join(", ")} (got ${JSON.stringify(v)}).`);
  return hit;
}

/** A list setting, or a clear error instead of a crash. */
function list(k: string, v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new ApiInputError(`${k} is a list.`);
  return v;
}

/** Refuse values that cannot make a solid, with every reason at once, before anything is changed. */
function refuseBadValues(f: Feature) {
  const issues = featureValueIssues(f, documentEvaluator(doc()));
  if (issues.length) throw new ApiInputError(`${FEATURE_LABELS[f.type]}: ${issues.join(" ")}`);
}

/** Apply API settings onto a feature draft (resolving names, selectors and formulas). */
function applySettings(f: Draft<Feature>, s: Record<string, unknown>) {
  const rec = f as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined) continue;
    if (k === "tipAngle") rec[k] = v === "" || v === null || v === false ? undefined : ex(v);
    else if (EXPR_KEYS.has(k)) rec[k] = ex(v, undefined, k);
    else if (ENUM_KEYS.has(k)) rec[k] = enumValue(k, v);
    else if (k === "position" || k === "translate") {
      if (!Array.isArray(v) || v.length !== 3) throw new ApiInputError(`${k} is [x, y, z].`);
      rec[k] = v.map((x) => ex(x));
    } else if (k === "sketch" || k === "profile" || k === "path") rec[k] = sketchRef(v);
    else if (k === "sketches") rec[k] = list(k, v).map(sketchRef);
    else if (k === "body") {
      const id = bodyRef(v);
      if (f.type === "fillet" || f.type === "chamfer") rec.edges = edgesBySelector(id, s.edges ?? "all");
      else if (f.type === "shell") {
        rec.bodyId = id;
        rec.faces = s.face === "none" ? [] : [faceBySelector(id, s.face ?? "top")];
      } else if (f.type === "hole") rec.face = faceBySelector(id, s.face ?? "top");
      else if (f.type === "draft") {
        const b = bodyMesh(id);
        const axis = ({ x: 0, y: 1, z: 2 } as const)[String(s.pull ?? "z") as "x" | "y" | "z"] ?? 2;
        rec.faces = b.faces.filter((x) => (x.surface === "PLANE" || x.surface === "CYLINDRE" || x.surface === "CONE") && Math.abs(x.normal[axis]) < 1e-3).map((x) => ({ bodyId: id, ...x }));
      } else if (f.type === "combine") rec.target = id;
      else rec.bodyId = id;
    } else if (k === "target") rec.target = bodyRef(v);
    else if (k === "tools") rec.tools = list(k, v).map(bodyRef);
    else if (k === "bodies") rec.bodies = list(k, v).map(bodyRef);
    else if (k === "to_face") {
      const o = v as { body?: unknown; face?: unknown };
      if (!o || typeof o !== "object" || !o.body) throw new ApiInputError('to_face is {body, face}, e.g. {"body": "Body 1", "face": "bottom"}.');
      rec.toFace = faceBySelector(bodyRef(o.body), String(o.face ?? "top"));
    }
    else if (k === "regions") {
      if (f.type !== "extrude" && f.type !== "revolve") throw new ApiInputError(`"regions" is a setting of extrude and revolve.`);
      if (!Array.isArray(v) || !v.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number"))) {
        throw new ApiInputError("regions is a list of [x, y] points in the sketch, one inside each area to use (see the sketch's regions in get_design).");
      }
      rec.regions = v.length ? v : undefined;
    }
    else if (k === "features") {
      if (f.type !== "pattern" && f.type !== "mirror") throw new ApiInputError(`"features" is a setting of pattern and mirror.`);
      if (!Array.isArray(v) || v.length === 0) throw new ApiInputError("features is a list of feature names or ids to repeat.");
      rec.features = v.map((x) => findFeatureRef(x).id);
    }
    else if (k === "points") {
      if (!Array.isArray(v)) throw new ApiInputError("points is a list of [x, y].");
      rec.points = v.map((p) => [ex((p as unknown[])[0]), ex((p as unknown[])[1])]);
    } else if (k === "edges" || k === "face" || k === "faces") continue; // handled with `body`
    else throw new ApiInputError(`"${k}" isn't a setting of ${f.type}.`);
  }
}

/** Apply a constrain_sketch request to a sketch copy. Returns the ids of the named items. */
function applySketchEdits(sk: SketchFeature, input: Record<string, unknown>): Record<string, Id> {
  const names: Record<string, Id> = {};
  const id = (ref: unknown): Id => {
    const r = String(ref ?? "");
    if (r in SKETCH_REFS) return r;
    const [base, part] = r.split(".") as [string, string | undefined];
    const gid = names[base] ?? base;
    const g = geomById(sk, gid) ?? sk.constraints?.find((c) => c.id === gid);
    if (!g) throw new ApiInputError(`There's no geometry called "${base}" in ${sk.name}.`);
    if (!part) return g.id;
    const key = g.type === "ellipse" ? ({ center: "c", major: "a" } as const)[part as "center" | "major"] : ({ start: "a", end: "b", center: "c" } as const)[part as "start" | "end" | "center"];
    const p = key && (g as unknown as Record<string, unknown>)[key];
    if (typeof p !== "string") throw new ApiInputError(`"${r}": use .start or .end on a line or arc, .center on an arc, circle or ellipse, .major on an ellipse.`);
    return p;
  };
  // Positions and sizes come in the design's units, like every other value (audit W-10); the geometry is kept in mm.
  const k = LENGTH_TO_MM[doc().units];
  const xy = (v: unknown, what: string): Vec2 => {
    if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => Number.isFinite(Number(x)))) throw new ApiInputError(`${what} is [x, y] in ${doc().units}.`);
    return [Number(v[0]) * k, Number(v[1]) * k];
  };
  const at = (v: unknown, what: string): Vec2 | Id => (typeof v === "string" ? id(v) : xy(v, what));
  for (const raw of (input.geometry ?? []) as Record<string, unknown>[]) {
    const label = String(raw.name ?? raw.type);
    let gid: Id | null;
    switch (raw.type) {
      case "point":
        gid = addPoint(sk, xy(raw.at, `${label}.at`));
        break;
      case "line":
        gid = addLine(sk, at(raw.from, `${label}.from`), at(raw.to, `${label}.to`), !!raw.construction);
        break;
      case "arc":
        gid = addArc(sk, at(raw.from, `${label}.from`), at(raw.to, `${label}.to`), xy(raw.through, `${label}.through`), !!raw.construction);
        if (!gid) throw new ApiInputError(`Arc "${label}": its three points are in a straight line.`);
        break;
      case "circle": {
        const r = Number(raw.radius) * k;
        if (!(r > 0)) throw new ApiInputError(`Circle "${label}" needs a radius greater than zero (${doc().units}).`);
        gid = addCircle(sk, at(raw.center, `${label}.center`), r, !!raw.construction);
        break;
      }
      case "ellipse": {
        const minor = Number(raw.minor) * k;
        if (!(minor > 0)) throw new ApiInputError(`Ellipse "${label}" needs a minor radius greater than zero (${doc().units}).`);
        const c = at(raw.center, `${label}.center`);
        const major = xy(raw.major, `${label}.major`);
        const cp = typeof c === "string" ? pointAt(sk, c) : c;
        if (Math.hypot(major[0] - cp[0], major[1] - cp[1]) < 1e-9) throw new ApiInputError(`Ellipse "${label}": its major point is on its center.`);
        gid = addEllipse(sk, c, major, minor, !!raw.construction);
        break;
      }
      default:
        throw new ApiInputError(`Geometry type is point, line, arc, circle or ellipse (got "${String(raw.type)}").`);
    }
    if (raw.name) names[String(raw.name)] = gid;
  }
  for (const c of (input.constraints ?? []) as Record<string, unknown>[]) {
    const type = String(c.type) as ConstraintType;
    if (!(type in CONSTRAINT_LABELS)) throw new ApiInputError(`Unknown constraint "${type}".`);
    if (!Array.isArray(c.refs)) throw new ApiInputError(`${type}: refs is a list of geometry names.`);
    const r = addConstraint(sk, type, c.refs.map(id), c.value === undefined ? undefined : ex(c.value));
    if ("error" in r) throw new ApiInputError(r.error);
    if (c.name) names[String(c.name)] = r.id;
  }
  for (const [list, fn] of [[input.trim, trimGeometry], [input.extend, extendGeometry]] as const) {
    for (const t of (list ?? []) as Record<string, unknown>[]) {
      const msg = fn(sk, id(t.curve), xy(t.at, "at"));
      if (msg) throw new ApiInputError(msg);
    }
  }
  const del = ((input.delete ?? []) as unknown[]).map(id);
  if (del.length) {
    sk.constraints = (sk.constraints ?? []).filter((c) => !del.includes(c.id));
    deleteGeometry(sk, del);
  }
  return names;
}

const SHAPES = ["box", "cylinder", "sphere", "cone", "torus", "tube"] as const;

const MAKERS: Partial<Record<FeatureType, (d: WhittleDocument, s: Record<string, unknown>) => Feature>> = {
  extrude: (d) => makeExtrude(d, ""),
  revolve: (d) => makeRevolve(d, ""),
  loft: (d) => makeLoft(d, []),
  sweep: (d) => makeSweep(d, "", ""),
  primitive: (d, s) => {
    const shape = SHAPES.find((x) => x === s.shape);
    if (!shape) throw new ApiInputError(`shape is one of ${SHAPES.join(", ")}.`);
    return makePrimitive(d, shape);
  },
  coil: (d, s) => makeCoil(d, s.section === "triangle" || s.section === "square" ? "thread" : "spring"),
  fillet: makeFillet,
  chamfer: makeChamfer,
  shell: makeShell,
  hole: makeHole,
  draft: makeDraft,
  mirror: (d) => makeMirror(d),
  pattern: (d) => makePattern(d),
  move: (d) => makeMove(d),
  combine: (d) => makeCombine(d),
  split: (d) => makeSplit(d),
  offset: (d) => makeOffset(d),
  scale: (d) => makeScale(d),
  boundingSolid: (d) => makeBoundingSolid(d),
};

/** Wait for the geometry to catch up with the document, then report a feature's status. */
async function settled(timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  const target = useApp.getState().doc;
  await new Promise<void>((resolve) => {
    const check = () => {
      const s = useApp.getState();
      if (s.builtDoc === target || s.doc !== target || Date.now() - start > timeoutMs || !s.kernelReady) return resolve();
      setTimeout(check, 30);
    };
    check();
  });
}

function statusOf(id: Id) {
  const st = useApp.getState().regen?.status.find((x) => x.id === id);
  return st ? { state: st.state, ...(st.message ? { message: st.message } : {}), ...(st.fix ? { suggested_fix: st.fix } : {}) } : { state: "unknown" };
}

/* ───────────────────────────── Summary ───────────────────────────── */

/** A compact JSON description of the design for an assistant (or a script). */
export function describeDesign() {
  const d = doc();
  const ev = documentEvaluator(d);
  const L = (v: number) => formatQuantity(v, "length", d.units);
  const end = activeEnd(d);
  return {
    name: d.name,
    units: d.units,
    parameters: d.parameters.map((p) => {
      const v = ev.params.get(p.name);
      return { name: p.name, formula: p.expr, kind: p.kind, value: v?.ok ? formatQuantity(v.value, p.kind, d.units) : `error: ${v?.error}`, ...(p.comment ? { comment: p.comment } : {}) };
    }),
    timeline: d.features.map((f, i) => {
      const { id, type, name, ...rest } = f as unknown as Record<string, unknown> & { id: string; type: string; name: string };
      // Keep settings readable: drop bulky geometric fingerprints.
      const settings = Object.fromEntries(
        Object.entries(rest).map(([k, v]) => {
          if (k === "edges" || k === "faces") return [k, `${(v as unknown[]).length} picked`];
          if (k === "face") return [k, v ? "picked" : "none"];
          if (k === "data") return [k, "(embedded file)"];
          return [k, v];
        }),
      );
      const built = f.type === "sketch" ? useApp.getState().regen?.sketches.find((x) => x.id === id) : undefined;
      const sol = built?.solution;
      const solver = sol ? { solver: { state: sol.state, dof: sol.dof, ...(sol.message ? { message: sol.message } : {}) } } : {};
      // Separate enclosed areas, each named by a point inside it: pass some of them as an extrude's `regions`.
      const regions = built?.regions && built.regions.length > 1 ? { regions: built.regions.map((r) => r.at) } : {};
      return { id, type, name, ...(i >= end ? { rolled_back: true } : {}), status: statusOf(id), ...solver, ...regions, settings };
    }),
    bodies: bodies().map((b) => ({
      id: b.id,
      name: d.bodies[b.id]?.name ?? b.id,
      color: d.bodies[b.id]?.color,
      size: [0, 1, 2].map((k) => L(b.bbox[1][k]! - b.bbox[0][k]!)).join(" × "),
      // In the design's units, like everything else the assistant reads and writes (audit W-10).
      bbox_min: b.bbox[0].map((v) => Math.round((v / LENGTH_TO_MM[d.units]) * 10000) / 10000),
      bbox_max: b.bbox[1].map((v) => Math.round((v / LENGTH_TO_MM[d.units]) * 10000) / 10000),
      volume_mm3: Math.round(b.volume * 100) / 100,
      faces: b.faces.length,
      edges: b.edges.length,
    })),
    selection: describeSelection(),
    // The same list the person sees under Problems: fix errors before going on.
    problems: problemsOf(useApp.getState()).map((p) => ({ severity: p.severity, title: p.title, ...(p.detail ? { detail: p.detail } : {}) })),
  };
}

/** What the person has selected in the view, so "round these edges" or "extrude this" can be taken literally. */
function describeSelection(): Record<string, unknown>[] {
  const s = useApp.getState();
  const name = (id: Id) => s.doc.bodies[id]?.name ?? s.doc.features.find((f) => f.id === id)?.name ?? id;
  const r3 = (v: number[]) => v.map((x) => Math.round(x * 1000) / 1000);
  return s.selection.map((p) => {
    const body = "bodyId" in p ? bodies().find((b) => b.id === p.bodyId) : undefined;
    switch (p.kind) {
      case "face": {
        const f = body?.faces[p.index];
        return { kind: "face", body: name(p.bodyId), ...(f ? { surface: f.surface, center: r3(f.center), normal: r3(f.normal) } : {}) };
      }
      case "edge": {
        const e = body?.edges[p.index];
        return { kind: "edge", body: name(p.bodyId), ...(e ? { curve: e.curve, mid: r3(e.mid), length: Math.round(e.length * 1000) / 1000 } : {}) };
      }
      case "body":
        return { kind: "body", body: name(p.bodyId) };
      case "sketch":
        return { kind: "sketch", sketch: name(p.sketchId) };
      case "region":
        return { kind: "sketch area", sketch: name(p.sketchId), point: p.at };
      case "plane":
        return { kind: "origin plane", plane: p.plane };
      case "cplane":
        return { kind: "construction plane", plane: name(p.id) };
    }
  });
}

/* ───────────────────────────── Execution ───────────────────────────── */

/**
 * Run one operation. Always resolves to a JSON-serialisable result; input
 * problems come back as `{ error }` so an assistant can fix and retry.
 */
export async function runDesignTool(name: string, input: Record<string, unknown>, opts: { assistant?: boolean } = {}): Promise<Record<string, unknown>> {
  try {
    const open = useApp.getState().session;
    // For the assistant, the person's open sketch or feature dialog is theirs: reading is fine, but a change would
    // have to close it (and their Cancel would no longer undo it as one step), so changes wait (audit A-1).
    // A script the person runs themselves (`whittle.api.run`) acts on what they have open, as before.
    if (open && opts.assistant && name !== "get_design") {
      return { error: `The person has "${open.label}" open in the editor. Ask them to finish or cancel it, then try again. Don't retry until they say so.` };
    }
    if (open && !opts.assistant) commitSession();
    const label = (s: string) => `Assistant: ${s}`;
    switch (name) {
      case "get_design":
        await settled();
        return describeDesign();

      case "set_parameter": {
        const pname = String(input.name ?? "");
        const existing = doc().parameters.find((p) => p.name === pname);
        if (!existing) {
          const err = validateParamName(pname, doc().parameters);
          if (err) throw new ApiInputError(err);
        }
        const kind = (input.kind as "length" | "angle" | "number" | "count" | undefined) ?? existing?.kind ?? "length";
        if (!["length", "angle", "number", "count"].includes(kind)) throw new ApiInputError("kind is length, angle, number or count.");
        mutate(label(`set ${pname}`), (d) => {
          const p = d.parameters.find((x) => x.name === pname);
          if (p) {
            p.expr = ex(input.value, undefined, "value");
            p.kind = kind;
            if (input.comment !== undefined) p.comment = String(input.comment);
          } else d.parameters.push({ id: uid("p"), name: pname, expr: ex(input.value, undefined, "value"), kind, ...(input.comment ? { comment: String(input.comment) } : {}) });
        });
        await settled();
        const v = documentEvaluator(doc()).params.get(pname);
        return v?.ok ? { ok: true, value: formatQuantity(v.value, kind, doc().units) } : { error: v?.error ?? "The parameter couldn't be evaluated." };
      }

      case "add_sketch": {
        const shapes = input.shapes;
        // An empty list makes a sketch for constrain_sketch to fill.
        if (!Array.isArray(shapes)) throw new ApiInputError("shapes is a list (it may be empty when you'll use constrain_sketch).");
        const entities = shapes.map((s) => entityFrom(s as Record<string, unknown>));
        let plane: PlaneRef;
        if (input.on_body !== undefined) plane = { kind: "face", face: faceBySelector(bodyRef(input.on_body), input.face ?? "top"), offset: ex(input.offset, "0") };
        else {
          const p = String(input.plane ?? "XY") as OriginPlane;
          if (!["XY", "XZ", "YZ"].includes(p)) throw new ApiInputError("plane is XY, XZ or YZ.");
          plane = { kind: "origin", plane: p, offset: ex(input.offset, "0"), ...(input.tilt_angle ? { angle: ex(input.tilt_angle), tilt: "x" as const } : {}) };
        }
        const f = makeSketch(doc(), plane);
        if (f.type === "sketch") f.entities = entities;
        if (input.name) f.name = String(input.name);
        mutate(label(`add ${f.name}`), (d) => void d.features.push(f as Draft<Feature>));
        await settled();
        return { id: f.id, name: f.name, status: statusOf(f.id) };
      }

      case "constrain_sketch": {
        const f = findFeatureRef(input.sketch);
        if (f.type !== "sketch") throw new ApiInputError(`"${f.name}" isn't a sketch.`);
        const sol = useApp.getState().builtDoc === doc() ? useApp.getState().regen?.sketches.find((x) => x.id === f.id)?.solution : undefined;
        // Work on a copy so a bad item changes nothing.
        const sk = structuredClone(f) as SketchFeature;
        bakeSolution(sk, sol);
        const names = applySketchEdits(sk, input);
        mutate(label(`constrain ${f.name}`), (d) => {
          const i = d.features.findIndex((x) => x.id === f.id);
          if (i >= 0) d.features[i] = sk as Draft<Feature>;
        });
        await settled();
        const s = useApp.getState().regen?.sketches.find((x) => x.id === f.id)?.solution;
        return { ids: names, status: statusOf(f.id), ...(s ? { solver: { state: s.state, dof: s.dof, ...(s.message ? { message: s.message } : {}) } } : {}) };
      }

      case "add_feature": {
        const type = String(input.type) as FeatureType;
        const make = MAKERS[type];
        if (!make) throw new ApiInputError(`Unknown feature type "${type}".`);
        const settings = (input.settings ?? {}) as Record<string, unknown>;
        const f = make(doc(), settings);
        applySettings(f as Draft<Feature>, settings);
        refuseBadValues(f as Feature);
        if (input.name) f.name = String(input.name);
        mutate(label(`add ${f.name}`), (d) => {
          const at = d.rollback === null ? d.features.length : d.rollback;
          d.features.splice(at, 0, f as Draft<Feature>);
          if (d.rollback !== null) d.rollback++;
        });
        await settled();
        return { id: f.id, name: f.name, type: FEATURE_LABELS[type], status: statusOf(f.id), ...(doc().bodies[f.id] ? { body: doc().bodies[f.id]!.name } : {}) };
      }

      case "update_feature": {
        const f = findFeatureRef(input.feature);
        const settings = (input.settings ?? {}) as Record<string, unknown>;
        // Validate on a copy first so a bad setting changes nothing.
        const trial = structuredClone(f) as Feature;
        if (trial.type === "sketch") {
          if (settings.shapes) trial.entities = (list("shapes", settings.shapes) as Record<string, unknown>[]).map(entityFrom);
        } else {
          applySettings(trial as Draft<Feature>, settings);
          refuseBadValues(trial);
        }
        mutate(label(`edit ${f.name}`), (d) => {
          const i = d.features.findIndex((x) => x.id === f.id);
          if (i < 0) return;
          const next = trial as Draft<Feature>;
          if (input.suppressed !== undefined) next.suppressed = !!input.suppressed;
          if (input.name) next.name = String(input.name);
          d.features[i] = next;
        });
        await settled();
        return { id: f.id, status: statusOf(f.id) };
      }

      case "delete_feature": {
        const f = findFeatureRef(input.feature);
        mutate(label(`delete ${f.name}`), (d) => {
          const i = d.features.findIndex((x) => x.id === f.id);
          if (i < 0) return;
          d.features.splice(i, 1);
          if (d.rollback !== null && i < d.rollback) d.rollback--;
        });
        await settled();
        return { ok: true };
      }

      case "set_body_appearance": {
        const id = bodyRef(input.body);
        if (input.color !== undefined && !/^#[0-9a-f]{6}$/i.test(String(input.color))) throw new ApiInputError("color is #rrggbb.");
        if (input.finish !== undefined && !LOOKS.some((l) => l.id === input.finish)) throw new ApiInputError(`finish is one of ${LOOKS.map((l) => l.id).join(", ")}.`);
        mutate(label("appearance"), (d) => {
          const b = d.bodies[id]!;
          if (input.name) b.name = String(input.name);
          if (input.color) b.color = String(input.color);
          if (input.finish) b.look = String(input.finish);
          if (input.opacity !== undefined) {
            const o = Number(input.opacity);
            if (!(o >= 0.05 && o <= 1)) throw new ApiInputError("opacity is between 0.05 and 1.");
            b.opacity = o >= 0.995 ? undefined : o;
          }
          if (input.visible !== undefined) b.visible = !!input.visible;
        });
        return { ok: true };
      }

      case "undo": {
        const label0 = history.undoLabel;
        // For the assistant, only its own steps: the top of the history may be something the person did since.
        if (opts.assistant && !label0?.startsWith("Assistant: ")) {
          return { error: label0 ? `The last step is the person's own ("${label0}"), not yours, so it was left alone.` : "There is nothing to undo." };
        }
        undo();
        await settled();
        return { ok: true, undid: label0 ?? null };
      }

      default:
        return { error: `Unknown tool "${name}".` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** For scripts: `await whittle.api.run("add_feature", {...})`. */
export const designApi = { tools: DESIGN_TOOLS, run: runDesignTool, describe: describeDesign };
