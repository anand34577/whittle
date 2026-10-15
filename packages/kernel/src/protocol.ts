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
  /** Solved constraint-driven geometry, when the sketch has any. */
  solution?: SketchSolution;
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

export type InspectKind = "interference" | "radii";
export type InspectResult = { kind: "interference"; items: InterferenceItem[] } | { kind: "radii"; items: RadiusItem[] };

export type ExportFormat = "step" | "stl" | "3mf" | "obj" | "glb" | "ply";

export type KernelRequest =
  | { type: "regen"; seq: number; doc: WhittleDocument; quality: "preview" | "final"; pickBefore?: Id }
  | { type: "export"; seq: number; doc: WhittleDocument; format: ExportFormat; bodyIds?: Id[] }
  | { type: "inspect"; seq: number; doc: WhittleDocument; kind: InspectKind };

export type KernelResponse =
  | { type: "ready"; ms: number }
  | { type: "regen"; result: RegenResult }
  | { type: "export"; seq: number; data: Uint8Array; mime: string; ext: string }
  | { type: "inspect"; seq: number; result: InspectResult }
  | { type: "error"; seq: number; message: string };