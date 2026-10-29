/**
 * KernelHost protocol: the only way the UI talks to geometry.
 * The default implementation runs OpenCascade (WASM) in a Web Worker; a native
 * sidecar or a remote kernel can implement the same messages later.
 */
import type { Id, SketchSolution, Vec3, WhittleDocument } from "@whittle/core";

export interface FaceInfo {
  center: Vec3;
  normal: Vec3;
  surface: string;
  area: number;
}

export interface EdgeInfo {
  mid: Vec3;
  tangent: Vec3;
  curve: string;
  length: number;
  /** Circles and arcs only. */
  radius?: number;
  /** Start and end points (equal for closed edges). */
  ends?: [Vec3, Vec3];
  /** Unit tangents at the start and end, for chaining edges that continue smoothly into each other. */
  endTangents?: [Vec3, Vec3];
}

export interface BodyResult {
  id: Id;
  /** Triangles: xyz per vertex. */
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Pairs of [firstIndex, indexCount] into `indices`, one per face. */
  faceRanges: Int32Array;
  /** Line segment vertices: xyz pairs. */
  edgePositions: Float32Array;
  /** Pairs of [firstVertex, vertexCount] into `edgePositions`, one per edge. */
  edgeRanges: Int32Array;
  faces: FaceInfo[];
  edges: EdgeInfo[];
  /** For each face, the indices (into `edges`) of its boundary edges. */
  faceEdges: number[][];
  volume: number;
  area: number;
  centerOfMass: Vec3;
  /** Inertia tensor about the center of mass for unit density, in mm⁵: [Ixx, Iyy, Izz, Ixy, Iyz, Izx]. Solids only. */
  inertia?: [number, number, number, number, number, number];
  bbox: [Vec3, Vec3];
}

export interface SketchFrame {
  id: Id;
  origin: Vec3;
  xDir: Vec3;
  yDir: Vec3;
  normal: Vec3;
  /** Construction geometry kind (planes by default). */
  kind?: "plane" | "axis" | "point" | "curve";
  /** Curves: line segments as xyz pairs, for display. */
  line?: Float32Array;
  /** Triangles (xyz per vertex, world space) of the closed profile regions. */
  fill?: Float32Array;
  /** Each enclosed area on its own (world-space triangles), with a point inside it in sketch coordinates, for picking profiles. */
  regions?: SketchRegionInfo[];
  /** Solved constraint-driven geometry, when the sketch has any. */
  solution?: SketchSolution;
}

export interface SketchRegionInfo {
  fill: Float32Array;
  at: [number, number];
}

/** "incomplete" = waiting for the user to pick something (not an error). */
export type FeatureState = "ok" | "warning" | "incomplete" | "error" | "suppressed" | "rolledback";

export interface FeatureFix {
  label: string;
  /** Property of the feature to set, and its new expression. */
  field: string;
  value: string;
}

export interface FeatureStatus {
  id: Id;
  state: FeatureState;
  message?: string;
  fix?: FeatureFix;
  ms?: number;
  /** Boundary Fill: the cells the tool bodies were cut into. */
  cells?: { volume: number; center: Vec3 }[];
}

export interface RegenResult {
  seq: number;
  bodies: BodyResult[];
  sketches: SketchFrame[];
  /** Construction planes, for display and picking. */
  planes: SketchFrame[];
  status: FeatureStatus[];
  /** Bodies as they were just before pickBefore (for picking while a feature previews). */
  pickBodies?: BodyResult[];
  /** The tool shape of the feature being edited (what it adds, cuts or keeps), for a tinted preview. */
  ghost?: BodyResult;
  /** What the feature does with the ghost: "new", "join", "cut" or "intersect". */
  ghostOp?: string;
  ms: number;
  /** Number of features recomputed (the rest came from cache). */
  rebuilt: number;
}

export interface InterferenceItem {
  a: Id;
  b: Id;
  volume: number;
  bbox: [Vec3, Vec3];
}

export interface RadiusItem {
  bodyId: Id;
  radius: number;
  /** True when the surface curves inward (a pocket's rounded corner). */
  concave: boolean;
  center: Vec3;
  normal: Vec3;
}

export type InspectKind = "interference" | "radii" | "validity" | "text" | "distance";
/** A face, edge or whole body to measure from (indices are those of the body's faces and edges). */
export type MeasurePick = { bodyId: Id; kind: "face" | "edge" | "body"; index?: number };
export type InspectResult =
  /** The shortest distance between two picks, and its end points; null when it can't be worked out. */
  | { kind: "distance"; result: { d: number; a: Vec3; b: Vec3 } | null }
  | { kind: "interference"; items: InterferenceItem[] }
  | { kind: "radii"; items: RadiusItem[] }
  /** OpenCascade's own validity check of every body. */
  | { kind: "validity"; items: { bodyId: Id; valid: boolean }[] }
  /** Outlines of the text in every sketch (sketch millimetres; holes, such as the inside of an "o", are loops too). */
  | { kind: "text"; items: { sketchId: Id; loops: [number, number][][] }[] };

/** What the 2D drawing sheet shows (all optional: an A3 sheet, third-angle, scale picked to fit). */
export interface DrawingSettings {
  sheet?: "A4" | "A3" | "A2" | "A1";
  /** Model-to-paper divisor: 1 is 1:1, 2 is 1:2, 0.5 is 2:1. Unset: the largest standard scale that fits. */
  scale?: number;
  angle?: "third" | "first";
  /** Add a SECTION A-A view cut through the middle. */
  section?: boolean;
  /** Add a parts list (name, volume, material). */
  parts?: boolean;
  hidden?: boolean;
  /** Material names by id, for the parts list (sent with the export, not stored). */
  materialNames?: Record<string, string>;
}

export type ExportFormat = "step" | "stl" | "3mf" | "obj" | "glb" | "ply" | "drawing";
/** How finely curved faces are cut into triangles for mesh formats: smoother files are bigger. */
export type MeshQuality = "draft" | "standard" | "fine";

export type KernelRequest =
  | { type: "regen"; seq: number; doc: WhittleDocument; quality: "preview" | "final"; pickBefore?: Id; preview?: Id }
  | { type: "export"; seq: number; doc: WhittleDocument; format: ExportFormat; bodyIds?: Id[]; quality?: MeshQuality; drawing?: DrawingSettings }
  | { type: "inspect"; seq: number; doc: WhittleDocument; kind: InspectKind; picks?: MeasurePick[] };

export type KernelResponse =
  | { type: "ready"; ms: number }
  | { type: "regen"; result: RegenResult }
  /** A long rebuild is under way: `done` of `total` timeline steps are finished. */
  | { type: "progress"; seq: number; done: number; total: number }
  | { type: "export"; seq: number; data: Uint8Array; mime: string; ext: string }
  | { type: "inspect"; seq: number; result: InspectResult }
  /** `fatal`: the engine itself broke (out of memory, an abort) and must be replaced before the next request. */
  | { type: "error"; seq: number; message: string; fatal?: boolean };