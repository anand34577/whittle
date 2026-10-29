import type {
  BodyOp,
  ConstructMode,
  SurfaceOp,
  CurveFeature,
  CircleEntity,
  EllipseEntity,
  GearEntity,
  PrimitiveShape,
  TextEntity,
  EntityType,
  Feature,
  FeatureType,
  Id,
  PlaneRef,
  PolygonEntity,
  PolylineEntity,
  RectEntity,
  SketchEntity,
  SlotEntity,
  WhittleDocument,
} from "./model";
import { SCHEMA_VERSION } from "./model";
import { type LengthUnit, defaultLength, lengthText } from "./units";

/** Short, sortable, collision-resistant id (time + randomness). */
export function uid(prefix = ""): Id {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}${t}${r}`;
}

/** Materials-inspired body palette: bone, steel, bronze, sage, clay, slate. */
export const BODY_COLORS = ["#b7bfc9", "#8ea4b3", "#b98d5f", "#8aa186", "#b07c72", "#7a87a3", "#c2a96a"];

export function newDocument(name = "Untitled", units: LengthUnit = "mm"): WhittleDocument {
  const now = new Date().toISOString();
  return {
    schema: SCHEMA_VERSION,
    id: uid("d"),
    name,
    units,
    parameters: [],
    features: [],
    bodies: {},
    rollback: null,
    createdAt: now,
    modifiedAt: now,
  };
}

/** A default length for a new step, given in mm: in the design's unit, or with "mm" written out in inch and foot designs (audit W-10). */
const L = (doc: WhittleDocument, mm: number): string => defaultLength(doc.units, mm);

export const FEATURE_LABELS: Record<FeatureType, string> = {
  sketch: "Sketch",
  extrude: "Extrude",
  revolve: "Revolve",
  fillet: "Fillet",
  chamfer: "Chamfer",
  shell: "Shell",
  primitive: "Shape",
  mirror: "Mirror",
  pattern: "Pattern",
  hole: "Hole",
  loft: "Loft",
  move: "Move",
  combine: "Combine",
  import: "Import",
  sweep: "Sweep",
  coil: "Coil",
  split: "Split",
  offset: "Offset",
  boundingSolid: "Bounding Solid",
  scale: "Scale",
  draft: "Draft",
  offsetFace: "Press/Pull",
  cplane: "Plane",
  construct: "Construct",
  curve: "Curve",
  surface: "Surface",
  rib: "Rib",
  thread: "Thread",
  replaceFace: "Replace Face",
  deleteFace: "Delete Face",
  align: "Align",
  boundaryFill: "Boundary Fill",
  joint: "Joint",
};

/** "Extrude 3" — next free numbered name for a feature type. */
export function nextName(doc: WhittleDocument, base: string): string {
  const used = new Set(doc.features.map((f) => f.name));
  for (let i = 1; ; i++) {
    const n = `${base} ${i}`;
    if (!used.has(n)) return n;
  }
}

export function nextBodyName(doc: WhittleDocument): string {
  const used = new Set(Object.values(doc.bodies).map((b) => b.name));
  for (let i = 1; ; i++) {
    const n = `Body ${i}`;
    if (!used.has(n)) return n;
  }
}

export function nextBodyColor(doc: WhittleDocument): string {
  return BODY_COLORS[Object.keys(doc.bodies).length % BODY_COLORS.length]!;
}

export function makeSketch(doc: WhittleDocument, plane: PlaneRef): Feature {
  return { id: uid("sk"), type: "sketch", name: nextName(doc, "Sketch"), plane, entities: [] };
}

export function makeExtrude(doc: WhittleDocument, sketch: Id, op: BodyOp = "new"): Feature {
  return {
    id: uid("ex"),
    type: "extrude",
    name: nextName(doc, "Extrude"),
    sketch,
    distance: L(doc, 10),
    extent: "one",
    flip: false,
    op,
  };
}

export function makeRevolve(doc: WhittleDocument, sketch: Id, op: BodyOp = "new"): Feature {
  return { id: uid("rv"), type: "revolve", name: nextName(doc, "Revolve"), sketch, axis: "y", angle: "360", op };
}

export function makeFillet(doc: WhittleDocument): Feature {
  return { id: uid("fi"), type: "fillet", name: nextName(doc, "Fillet"), edges: [], radius: L(doc, 2) };
}

export function makeChamfer(doc: WhittleDocument): Feature {
  return { id: uid("ch"), type: "chamfer", name: nextName(doc, "Chamfer"), edges: [], distance: L(doc, 1) };
}

export function makeShell(doc: WhittleDocument): Feature {
  return { id: uid("sh"), type: "shell", name: nextName(doc, "Shell"), faces: [], thickness: L(doc, 2) };
}

export const PRIMITIVE_LABELS: Record<PrimitiveShape, string> = {
  box: "Box",
  cylinder: "Cylinder",
  sphere: "Sphere",
  cone: "Cone",
  torus: "Torus",
  tube: "Tube",
};

export function makePrimitive(doc: WhittleDocument, shape: PrimitiveShape, op: BodyOp = "new"): Feature {
  return {
    id: uid("pr"),
    type: "primitive",
    name: nextName(doc, PRIMITIVE_LABELS[shape]),
    shape,
    width: L(doc, 40),
    depth: L(doc, 30),
    height: shape === "cone" ? L(doc, 30) : L(doc, 20),
    radius: shape === "torus" ? L(doc, 20) : L(doc, 15),
    radius2: shape === "cone" ? "0" : shape === "torus" ? L(doc, 5) : shape === "tube" ? L(doc, 11) : undefined,
    position: ["0", "0", "0"],
    op,
  };
}

export function makeHole(doc: WhittleDocument): Feature {
  return {
    id: uid("ho"),
    type: "hole",
    name: nextName(doc, "Hole"),
    face: null,
    points: [],
    style: "simple",
    diameter: L(doc, 5),
    depth: L(doc, 10),
    through: true,
    headDiameter: L(doc, 9),
    headDepth: L(doc, 3),
    tipAngle: "118", // a blind hole ends in a drill point
  };
}

export function makeLoft(doc: WhittleDocument, sketches: Id[]): Feature {
  return { id: uid("lo"), type: "loft", name: nextName(doc, "Loft"), sketches, ruled: false, op: "new" };
}

export function makeMove(doc: WhittleDocument, bodyId?: Id): Feature {
  return { id: uid("mv"), type: "move", name: nextName(doc, "Move"), bodyId, translate: ["0", "0", "0"], axis: "z", angle: "0", copy: false };
}

export function makeCombine(doc: WhittleDocument, target?: Id, tools: Id[] = []): Feature {
  return { id: uid("cb"), type: "combine", name: nextName(doc, "Combine"), target, tools, op: "join", keepTools: false };
}

export function makeImport(doc: WhittleDocument, fileName: string, format: "step" | "stl" | "obj" | "whittle", data: string): Feature {
  return { id: uid("im"), type: "import", name: nextName(doc, "Import"), fileName, format, data, scale: "1" };
}

export function makeSweep(doc: WhittleDocument, profile: Id, path: Id): Feature {
  return { id: uid("sw"), type: "sweep", name: nextName(doc, "Sweep"), profile, path, orientation: "frenet", op: "new" };
}

/** A tube along a path sketch: round or square, solid or hollow (wall 0 = solid). */
export function makePipe(doc: WhittleDocument, path: Id): Feature {
  return { id: uid("pi"), type: "sweep", name: nextName(doc, "Pipe"), profile: "", path, orientation: "fixed", pipe: { shape: "circle", size: L(doc, 10), wall: L(doc, 2) }, op: "new" };
}

/** A coil or thread. `kind` picks sensible starting sizes. */
export function makeCoil(doc: WhittleDocument, kind: "spring" | "thread" = "spring"): Feature {
  return {
    id: uid("co"),
    type: "coil",
    name: nextName(doc, kind === "thread" ? "Thread" : "Spring"),
    section: kind === "thread" ? "triangle" : "circle",
    radius: kind === "thread" ? L(doc, 4) : L(doc, 10),
    pitch: kind === "thread" ? L(doc, 1.25) : L(doc, 6),
    height: kind === "thread" ? L(doc, 20) : L(doc, 40),
    size: kind === "thread" ? L(doc, 0.75) : L(doc, 2),
    lefthand: false,
    position: ["0", "0", "0"],
    op: "new",
  };
}

export function makeSplit(doc: WhittleDocument, bodyId?: Id): Feature {
  return { id: uid("sp"), type: "split", name: nextName(doc, "Split"), bodyId, plane: "XY", offset: "0", keep: "both" };
}

export function makeOffset(doc: WhittleDocument, bodyId?: Id): Feature {
  return { id: uid("of"), type: "offset", name: nextName(doc, "Offset"), bodyId, distance: L(doc, 0.5), copy: false };
}

export function makeBoundingSolid(doc: WhittleDocument, bodies: Id[] = []): Feature {
  return { id: uid("bs"), type: "boundingSolid", name: nextName(doc, "Bounding Solid"), bodies, shape: "box", padding: "0", axis: "z" };
}

export function makeScale(doc: WhittleDocument, bodyId?: Id): Feature {
  return { id: uid("sc"), type: "scale", name: nextName(doc, "Scale"), bodyId, factor: "1.5", center: "body", copy: false };
}

export function makeDraft(doc: WhittleDocument): Feature {
  return { id: uid("dr"), type: "draft", name: nextName(doc, "Draft"), faces: [], angle: "3", pull: "z", neutral: "0", flip: false };
}

export function makeOffsetFace(doc: WhittleDocument): Feature {
  return { id: uid("of"), type: "offsetFace", name: nextName(doc, "Press/Pull"), faces: [], distance: L(doc, 2) };
}

export function makeConstructionPlane(doc: WhittleDocument, plane: PlaneRef): Feature {
  return { id: uid("cp"), type: "cplane", name: nextName(doc, "Plane"), plane };
}

export function makeJoint(doc: WhittleDocument, bodyId?: Id, fixedId?: Id): Feature {
  return { id: uid("jt"), type: "joint", name: nextName(doc, "Joint"), bodyId, fixedId, joint: "revolute", origin: "center", point: ["0", "0", "0"], axis: "z", angle: "0", distance: "0", limited: false, min: "-90", max: "90" };
}

/** What each construct mode asks the user to pick, and how to say it. */
export const CONSTRUCT_MODES: Record<ConstructMode, { label: string; faces: number; edges: number; points: number; value?: "angle" | "percent"; hint: string }> = {
  midplane: { label: "Midplane", faces: 2, edges: 0, points: 0, hint: "Click two flat faces: the plane sits halfway between them" },
  plane3: { label: "Plane through 3 points", faces: 0, edges: 0, points: 3, hint: "Click three points on the model (they snap to nearby corners)" },
  plane2e: { label: "Plane through 2 edges", faces: 0, edges: 2, points: 0, hint: "Click two straight edges that lie in one plane" },
  planeEdge: { label: "Plane at angle to edge", faces: 0, edges: 1, points: 0, value: "angle", hint: "Click a straight edge; optionally a face to measure the angle from" },
  planeTangent: { label: "Tangent plane", faces: 1, edges: 0, points: 0, value: "angle", hint: "Click a round face; the angle moves the plane around it" },
  planePath: { label: "Plane along path", faces: 0, edges: 1, points: 0, value: "percent", hint: "Click an edge; the plane stands across it at the chosen position" },
  axisCyl: { label: "Axis through cylinder", faces: 1, edges: 0, points: 0, hint: "Click a round face or circular edge" },
  axis2p: { label: "Axis through 2 points", faces: 0, edges: 0, points: 2, hint: "Click two points on the model" },
  axis2pl: { label: "Axis through 2 planes", faces: 2, edges: 0, points: 0, hint: "Click two flat faces that meet at an angle" },
  axisEdge: { label: "Axis through edge", faces: 0, edges: 1, points: 0, hint: "Click a straight edge" },
  axisPerp: { label: "Axis perpendicular at point", faces: 1, edges: 0, points: 1, hint: "Click a face where the axis should stand out of it" },
  pointVertex: { label: "Point", faces: 0, edges: 0, points: 1, hint: "Click a corner or any spot on the model" },
  point2e: { label: "Point at 2 edges", faces: 0, edges: 2, points: 0, hint: "Click two straight edges that cross" },
  point3pl: { label: "Point at 3 planes", faces: 3, edges: 0, points: 0, hint: "Click three flat faces that meet" },
  pointCenter: { label: "Point at circle center", faces: 0, edges: 1, points: 0, hint: "Click a circular edge (or a round face)" },
  pointEdgePlane: { label: "Point at edge and plane", faces: 1, edges: 1, points: 0, hint: "Click a straight edge and a flat face it pierces" },
};

export function makeConstruct(doc: WhittleDocument, mode: ConstructMode): Feature {
  const label = mode.startsWith("plane") || mode === "midplane" ? "Plane" : mode.startsWith("axis") ? "Axis" : "Point";
  return { id: uid("cg"), type: "construct", name: nextName(doc, label), mode, faces: [], edges: [], points: [], value: mode === "planePath" ? "50" : "0" };
}

export function makeRib(doc: WhittleDocument, sketch: Id): Feature {
  return { id: uid("rb"), type: "rib", name: nextName(doc, "Rib"), sketch, thickness: L(doc, 2), depth: L(doc, 10), flip: false, op: "join" };
}

export function makeThread(doc: WhittleDocument): Feature {
  return { id: uid("th"), type: "thread", name: nextName(doc, "Thread"), face: null, pitch: L(doc, 1.5), length: "", depth: "", lefthand: false };
}

export function makeReplaceFace(doc: WhittleDocument): Feature {
  return { id: uid("rf"), type: "replaceFace", name: nextName(doc, "Replace Face"), faces: [], target: null };
}

export function makeDeleteFace(doc: WhittleDocument): Feature {
  return { id: uid("df"), type: "deleteFace", name: nextName(doc, "Delete Face"), faces: [] };
}

export function makeAlign(doc: WhittleDocument, bodyId?: Id): Feature {
  return { id: uid("al"), type: "align", name: nextName(doc, "Align"), bodyId, from: null, to: null, flip: false, offset: "0" };
}

export function makeBoundaryFill(doc: WhittleDocument, tools: Id[]): Feature {
  return { id: uid("bf"), type: "boundaryFill", name: nextName(doc, "Boundary Fill"), tools, cells: [], keepTools: true };
}

export const CURVE_SOURCES: Record<CurveFeature["source"], { label: string; name: string; hint: string }> = {
  points: { label: "3D sketch", name: "3D Sketch", hint: "Click points on the model (corners snap); the curve runs through them" },
  edges: { label: "Include 3D geometry", name: "3D Curve", hint: "Click model edges to copy them as a curve" },
  faces: { label: "Intersection curve", name: "Intersection", hint: "Click two faces: the curve is where they meet" },
  project: { label: "Project to surface", name: "Projected", hint: "Click a face, then the sketch to lay onto it" },
};

export function makeCurve(doc: WhittleDocument, source: CurveFeature["source"]): Feature {
  return { id: uid("cv"), type: "curve", name: nextName(doc, CURVE_SOURCES[source].name), source, points: [], edges: [], faces: [], smooth: source === "points" };
}

export const SURFACE_OPS: Record<SurfaceOp, { label: string; name: string; hint: string }> = {
  patch: { label: "Patch", name: "Patch", hint: "Click the edges around an opening: a surface fills it" },
  ruled: { label: "Ruled surface", name: "Ruled", hint: "Click edges, then set how far the surface runs out from them" },
  offset: { label: "Offset surface", name: "Offset Surface", hint: "Click faces: copies of them float at the distance (0 copies them as they are)" },
  trim: { label: "Trim surface", name: "Trim", hint: "Click a surface body, pick the plane, and choose which side to keep" },
  untrim: { label: "Untrim", name: "Untrim", hint: "Click flat faces with holes: the holes are filled in" },
  extend: { label: "Extend surface", name: "Extend", hint: "Click flat faces to grow (or shrink) all around by a distance" },
  stitch: { label: "Stitch", name: "Stitch", hint: "Click surface bodies to join; a closed set becomes a solid" },
  unstitch: { label: "Unstitch", name: "Unstitch", hint: "Click a body to break into separate faces" },
  merge: { label: "Merge faces", name: "Merge", hint: "Click a body: neighbouring faces on the same surface join into one" },
  reverse: { label: "Reverse normal", name: "Reverse", hint: "Click a body to flip which side of its surface counts as outside" },
  thicken: { label: "Thicken", name: "Thicken", hint: "Click a surface body and set a thickness to make it a solid" },
};

export function makeSurface(doc: WhittleDocument, op: SurfaceOp): Feature {
  return {
    id: uid("sf"),
    type: "surface",
    name: nextName(doc, SURFACE_OPS[op].name),
    op,
    bodies: [],
    faces: [],
    edges: [],
    distance: op === "thicken" ? L(doc, 2) : op === "extend" ? L(doc, 5) : op === "offset" ? L(doc, 2) : L(doc, 10),
    direction: "normal",
    axis: "z",
    plane: "XY",
    offset: "0",
    keep: "below",
  };
}

export function makeMirror(doc: WhittleDocument, bodyId?: Id): Feature {
  return { id: uid("mi"), type: "mirror", name: nextName(doc, "Mirror"), bodyId, plane: "YZ", merge: true };
}

export function makePattern(doc: WhittleDocument, bodyId?: Id): Feature {
  return {
    id: uid("pa"),
    type: "pattern",
    name: nextName(doc, "Pattern"),
    bodyId,
    pattern: "linear",
    axis: "x",
    count: "3",
    spacing: L(doc, 20),
    angle: "360",
    merge: true,
  };
}

const round3 = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * A whole shape spanning two points given in mm. Its fields are written in `units` (the document's length unit),
 * because a bare number in an expression means the document unit. Angles stay in degrees.
 */
export function makeEntity(type: EntityType, a: [number, number], b: [number, number], units: LengthUnit = "mm"): SketchEntity {
  const id = uid("e");
  const ang = round3;
  const fmt = (mm: number) => lengthText(mm, units);
  switch (type) {
    case "rect": {
      const e: RectEntity = {
        id,
        type,
        x: fmt(Math.min(a[0], b[0])),
        y: fmt(Math.min(a[1], b[1])),
        w: fmt(Math.abs(b[0] - a[0])),
        h: fmt(Math.abs(b[1] - a[1])),
        anchor: "corner",
      };
      return e;
    }
    case "circle": {
      const e: CircleEntity = { id, type, cx: fmt(a[0]), cy: fmt(a[1]), r: fmt(Math.hypot(b[0] - a[0], b[1] - a[1])) };
      return e;
    }
    case "polygon": {
      const e: PolygonEntity = {
        id,
        type,
        cx: fmt(a[0]),
        cy: fmt(a[1]),
        r: fmt(Math.hypot(b[0] - a[0], b[1] - a[1])),
        sides: "6",
        angle: ang((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI),
      };
      return e;
    }
    case "slot": {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const e: SlotEntity = {
        id,
        type,
        cx: fmt((a[0] + b[0]) / 2),
        cy: fmt((a[1] + b[1]) / 2),
        length: fmt(len),
        width: fmt(Math.max(len / 4, 1)),
        angle: ang((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI),
      };
      return e;
    }
    case "polyline": {
      const e: PolylineEntity = { id, type, points: [[fmt(a[0]), fmt(a[1])], [fmt(b[0]), fmt(b[1])]] };
      return e;
    }
    case "ellipse": {
      const e: EllipseEntity = {
        id,
        type,
        cx: fmt(a[0]),
        cy: fmt(a[1]),
        rx: fmt(Math.max(Math.abs(b[0] - a[0]), 0.5)),
        ry: fmt(Math.max(Math.abs(b[1] - a[1]), 0.5)),
        angle: "0",
      };
      return e;
    }
    case "text": {
      const size = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const e: TextEntity = { id, type, x: fmt(a[0]), y: fmt(a[1]), text: "Whittle", size: fmt(size > 1 ? size : 10), angle: "0" };
      return e;
    }
    case "gear": {
      const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const e: GearEntity = {
        id,
        type,
        cx: fmt(a[0]),
        cy: fmt(a[1]),
        teeth: String(Math.max(8, Math.min(120, Math.round(r)))),
        module: fmt(2),
        bore: fmt(5),
      };
      return e;
    }
  }
}

/** A copy of an entity with a new id (positions unchanged). */
export function cloneEntity(e: SketchEntity): SketchEntity {
  return { ...structuredClone(e), id: uid("e") };
}