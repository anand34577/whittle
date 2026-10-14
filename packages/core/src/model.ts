/**
 * The Whittle document model.
 *
 * A document is *data, not geometry*: parameters plus an ordered timeline of
 * features. Geometry is always derived from it by the kernel, which means a
 * document can be diffed, merged, migrated and replayed.
 */
import type { LengthUnit, QuantityKind } from "./units";

export type Id = string;
/** A user-editable expression such as `width / 2 + 3 mm`. */
export type Expr = string;
export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export const SCHEMA_VERSION = 1;

export interface Parameter {
  id: Id;
  name: string;
  expr: Expr;
  kind: QuantityKind;
  comment?: string;
}

export type OriginPlane = "XY" | "XZ" | "YZ";

export type PlaneRef =
  | { kind: "origin"; plane: OriginPlane; offset: Expr }
  | { kind: "face"; face: FaceRef; offset: Expr };

/**
 * A persistent reference to a face. Rather than an index (which changes
 * whenever upstream geometry changes) we store a geometric fingerprint and
 * re-resolve it on every rebuild. See packages/kernel/src/refs.ts.
 */
export interface FaceRef {
  bodyId: Id;
  center: Vec3;
  normal: Vec3;
  surface: string;
  area: number;
}

export interface EdgeRef {
  bodyId: Id;
  mid: Vec3;
  tangent: Vec3;
  curve: string;
  length: number;
}

/* ───────────────────────── Sketch entities ───────────────────────── */

interface EntityBase {
  id: Id;
  /** "auto" makes an entity a hole when it sits inside another profile. */
  mode?: "auto" | "add" | "subtract";
  construction?: boolean;
}

export interface RectEntity extends EntityBase {
  type: "rect";
  x: Expr;
  y: Expr;
  w: Expr;
  h: Expr;
  /** Where (x, y) is on the rectangle. */
  anchor: "center" | "corner";
  corner?: Expr;
  /** Rotation about the rectangle's center. */
  angle?: Expr;
}

export interface CircleEntity extends EntityBase {
  type: "circle";
  cx: Expr;
  cy: Expr;
  r: Expr;
}

export interface PolygonEntity extends EntityBase {
  type: "polygon";
  cx: Expr;
  cy: Expr;
  r: Expr;
  sides: Expr;
  angle: Expr;
}

export interface SlotEntity extends EntityBase {
  type: "slot";
  cx: Expr;
  cy: Expr;
  length: Expr;
  width: Expr;
  angle: Expr;
}

export interface PolylineEntity extends EntityBase {
  type: "polyline";
  points: [Expr, Expr][];
  /** Round every corner with this radius. */
  corner?: Expr;
  /** Draw a smooth curve through the points instead of straight lines. */
  smooth?: boolean;
}

export interface EllipseEntity extends EntityBase {
  type: "ellipse";
  cx: Expr;
  cy: Expr;
  rx: Expr;
  ry: Expr;
  angle: Expr;
}

/** Text outlines, for embossed or engraved labels. */
export interface TextEntity extends EntityBase {
  type: "text";
  x: Expr;
  y: Expr;
  /** Plain text, not an expression. */
  text: string;
  size: Expr;
  bold?: boolean;
  angle: Expr;
}

/** An involute spur gear outline (20 degree pressure angle). */
export interface GearEntity extends EntityBase {
  type: "gear";
  cx: Expr;
  cy: Expr;
  teeth: Expr;
  module: Expr;
  /** Center hole diameter; 0 for none. */
  bore: Expr;
}

export type SketchEntity = RectEntity | CircleEntity | PolygonEntity | SlotEntity | PolylineEntity | EllipseEntity | TextEntity | GearEntity;
export type EntityType = SketchEntity["type"];

/* ───────────────────────────── Features ───────────────────────────── */

export type BodyOp = "new" | "join" | "cut" | "intersect";

interface FeatureBase {
  id: Id;
  name: string;
  suppressed?: boolean;
}

export interface SketchFeature extends FeatureBase {
  type: "sketch";
  plane: PlaneRef;
  entities: SketchEntity[];
}

export interface ExtrudeFeature extends FeatureBase {
  type: "extrude";
  sketch: Id;
  distance: Expr;
  extent: "one" | "symmetric";
  flip: boolean;
  op: BodyOp;
  /** Body to join/cut. Unset = most recent body (join) or every body (cut). */
  target?: Id;
}

export interface RevolveFeature extends FeatureBase {
  type: "revolve";
  sketch: Id;
  axis: "x" | "y";
  angle: Expr;
  op: BodyOp;
  target?: Id;
}

export interface FilletFeature extends FeatureBase {
  type: "fillet";
  edges: EdgeRef[];
  radius: Expr;
}

export interface ChamferFeature extends FeatureBase {
  type: "chamfer";
  edges: EdgeRef[];
  distance: Expr;
}

export interface ShellFeature extends FeatureBase {
  type: "shell";
  bodyId?: Id;
  faces: FaceRef[];
  thickness: Expr;
}

export type PrimitiveShape = "box" | "cylinder" | "sphere" | "cone" | "torus" | "tube";

export interface PrimitiveFeature extends FeatureBase {
  type: "primitive";
  shape: PrimitiveShape;
  width: Expr;
  depth: Expr;
  height: Expr;
  radius: Expr;
  /** Cone top radius, torus tube radius, tube inner radius. */
  radius2?: Expr;
  position: [Expr, Expr, Expr];
  op: BodyOp;
  target?: Id;
}

export interface MirrorFeature extends FeatureBase {
  type: "mirror";
  bodyId?: Id;
  plane: OriginPlane;
  merge: boolean;
}

export interface PatternFeature extends FeatureBase {
  type: "pattern";
  bodyId?: Id;
  pattern: "linear" | "circular";
  axis: "x" | "y" | "z";
  count: Expr;
  spacing: Expr;
  angle: Expr;
  merge: boolean;
}

/** Drilled holes on a flat face, positioned in the face's sketch frame. */
export interface HoleFeature extends FeatureBase {
  type: "hole";
  face: FaceRef | null;
  points: [Expr, Expr][];
  style: "simple" | "counterbore" | "countersink";
  diameter: Expr;
  depth: Expr;
  through: boolean;
  headDiameter: Expr;
  headDepth: Expr;
}

/** A smooth solid through two or more sketch profiles. */
export interface LoftFeature extends FeatureBase {
  type: "loft";
  sketches: Id[];
  ruled: boolean;
  op: BodyOp;
  target?: Id;
}

/** Move and/or rotate a body, optionally as a copy. */
export interface MoveFeature extends FeatureBase {
  type: "move";
  bodyId?: Id;
  translate: [Expr, Expr, Expr];
  axis: "x" | "y" | "z";
  angle: Expr;
  copy: boolean;
}

/** Boolean between existing bodies. */
export interface CombineFeature extends FeatureBase {
  type: "combine";
  target?: Id;
  tools: Id[];
  op: "join" | "cut" | "intersect";
  keepTools: boolean;
}

/** A body imported from a STEP or STL file (embedded in the design). */
export interface ImportFeature extends FeatureBase {
  type: "import";
  format: "step" | "stl";
  fileName: string;
  /** Base64 file contents. */
  data: string;
  scale: Expr;
}

export type Feature =
  | SketchFeature
  | HoleFeature
  | LoftFeature
  | MoveFeature
  | CombineFeature
  | ImportFeature
  | ExtrudeFeature
  | RevolveFeature
  | FilletFeature
  | ChamferFeature
  | ShellFeature
  | PrimitiveFeature
  | MirrorFeature
  | PatternFeature;

export type FeatureType = Feature["type"];

/** Features that can create a new body. */
export type BodyFeature = ExtrudeFeature | RevolveFeature | PrimitiveFeature | LoftFeature;

export interface BodyMeta {
  name: string;
  color: string;
  visible: boolean;
  /** Appearance preset (see MATERIAL_LOOKS in the web app). */
  look?: string;
}

export interface WhittleDocument {
  schema: number;
  /** Stable identity across saves (keys local version history). Older files get one on open. */
  id?: Id;
  name: string;
  units: LengthUnit;
  parameters: Parameter[];
  features: Feature[];
  bodies: Record<Id, BodyMeta>;
  /** Timeline rollback marker: only features before this index are built. */
  rollback: number | null;
  createdAt: string;
  modifiedAt: string;
}

export function isBodyFeature(f: Feature): f is BodyFeature {
  return f.type === "extrude" || f.type === "revolve" || f.type === "primitive" || f.type === "loft";
}