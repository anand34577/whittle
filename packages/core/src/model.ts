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

export const SCHEMA_VERSION = 2;

export interface Parameter {
  id: Id;
  name: string;
  expr: Expr;
  kind: QuantityKind;
  comment?: string;
}

export type OriginPlane = "XY" | "XZ" | "YZ";

export type PlaneRef =
  | {
      kind: "origin";
      plane: OriginPlane;
      offset: Expr;
      /** Tilt the plane about one of its own in-plane axes (a construction plane at an angle). */
      angle?: Expr;
      tilt?: "x" | "y";
    }
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

/**
 * An outline or path point. A third element "arc" makes the point the middle of
 * a three-point arc from the previous point to the next one. "spline" makes it a
 * fit point of a smooth curve that runs from the last plain point to the next one.
 */
export type PolyPoint = [Expr, Expr] | [Expr, Expr, "arc" | "spline"];

export interface PolylineEntity extends EntityBase {
  type: "polyline";
  points: PolyPoint[];
  /** Round every corner with this radius. */
  corner?: Expr;
  /** Draw a smooth curve through the points instead of straight lines. */
  smooth?: boolean;
  /** An open path (for sweeps and guides): never becomes a solid region. */
  open?: boolean;
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

/* ─────────────────── Constraint-driven sketch geometry ─────────────────── */

/**
 * Primitive geometry that a constraint solver positions. Coordinates and radii
 * are millimetres: the solver's starting guess, normally the last solved
 * position. Lines and arcs share point ids where they meet.
 */
export type SketchGeom =
  | { id: Id; type: "point"; x: number; y: number; construction?: boolean }
  | { id: Id; type: "line"; a: Id; b: Id; construction?: boolean }
  /** Counter-clockwise from `a` to `b` about the center `c`. */
  | { id: Id; type: "arc"; c: Id; a: Id; b: Id; construction?: boolean }
  | { id: Id; type: "circle"; c: Id; r: number; construction?: boolean }
  /** A smooth curve through the fit points (solver points, so constraints and dragging move it). */
  | { id: Id; type: "spline"; pts: Id[]; closed?: boolean; construction?: boolean };

export type GeomType = SketchGeom["type"];

export type ConstraintType =
  | "coincident"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "tangent"
  | "equal"
  | "fixed"
  | "symmetric"
  | "midpoint"
  | "collinear"
  | "distance"
  | "radius"
  | "angle";

/**
 * A relation between geometry. `refs` are geometry ids, or the sketch's fixed
 * references "origin", "xaxis" and "yaxis". Dimensions (distance, radius,
 * angle) carry a `value` expression, so they can use parameters.
 */
export interface SketchConstraint {
  id: Id;
  type: ConstraintType;
  refs: Id[];
  value?: Expr;
}

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
  /** Constraint-driven geometry, alongside (not instead of) the whole-shape entities. */
  geometry?: SketchGeom[];
  constraints?: SketchConstraint[];
  /** A picture to trace over (not geometry). */
  image?: SketchImage;
}

/** A reference picture on a sketch plane. Centre, width and rotation (degrees) in mm; height = width × aspect. */
export interface SketchImage {
  /** Data URL (JPEG or PNG). */
  src: string;
  name: string;
  x: number;
  y: number;
  width: number;
  aspect: number;
  rotation: number;
  opacity: number;
  /** Hide it outside this sketch's editing. */
  hidden?: boolean;
}

export interface ExtrudeFeature extends FeatureBase {
  type: "extrude";
  sketch: Id;
  distance: Expr;
  /** "two" = `distance` one way and `distance2` the other. */
  /** "through" = cut (or add) through everything in that direction; `distance` is ignored. */
  extent: "one" | "symmetric" | "two" | "through";
  distance2?: Expr;
  flip: boolean;
  /** Draft angle: positive narrows the profile as it rises (mould and cast parts). */
  taper?: Expr;
  /** Twist the profile by this angle over the extrusion (vases, grips, springs). */
  twist?: Expr;
  /**
   * Thin feature: extrude a wall of this thickness along the profile's outlines
   * instead of the filled region. Open paths become ribs and walls.
   */
  thin?: Expr;
  /** Which side of the outline the wall grows to (outlines; "inside" is the material side). */
  thinSide?: "center" | "inside" | "outside";
  op: BodyOp;
  /** Body to join/cut. Unset = most recent body (join) or every body (cut). */
  target?: Id;
}

export interface RevolveFeature extends FeatureBase {
  type: "revolve";
  sketch: Id;
  /** "line" spins around `axisLine`, a straight path or construction line in the sketch. */
  axis: "x" | "y" | "line";
  axisLine?: Id;
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
  /** Move the mirror plane along its normal. */
  offset?: Expr;
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
  /** Linear only: a second direction makes a grid. */
  axis2?: "x" | "y" | "z";
  count2?: Expr;
  spacing2?: Expr;
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

/** Sweep a closed profile along a path (pipes, handles, rails, gaskets). */
export interface SweepFeature extends FeatureBase {
  type: "sweep";
  /** Sketch holding the closed cross-section. */
  profile: Id;
  /** Sketch whose first path (an open line, or any outline) is followed. */
  path: Id;
  /** "frenet" follows the path's curvature; "fixed" keeps the profile upright (better for flat paths). */
  orientation: "frenet" | "fixed";
  /** Pipe mode: no profile sketch; a round or square tube (optionally hollow) built at the path's start. */
  pipe?: { shape: "circle" | "square"; size: Expr; wall: Expr };
  op: BodyOp;
  target?: Id;
}

/** A helical coil: springs, threads, augers. */
export interface CoilFeature extends FeatureBase {
  type: "coil";
  /** Cross-section of the coil: round wire, 60 degree thread, or square thread. */
  section: "circle" | "triangle" | "square";
  /** Radius of the helix (to the center of the section). */
  radius: Expr;
  pitch: Expr;
  height: Expr;
  /** Wire diameter (circle) or thread depth (triangle, square). */
  size: Expr;
  lefthand: boolean;
  position: [Expr, Expr, Expr];
  op: BodyOp;
  target?: Id;
}

/** Split a body in two along a plane (or trim away one side). */
export interface SplitFeature extends FeatureBase {
  type: "split";
  bodyId?: Id;
  plane: OriginPlane;
  offset: Expr;
  /** "both" keeps each side as its own body. */
  keep: "both" | "above" | "below";
}

/** Grow or shrink a whole body by a distance (clearances, tolerances, coatings). */
export interface OffsetFeature extends FeatureBase {
  type: "offset";
  bodyId?: Id;
  distance: Expr;
  copy: boolean;
}

/** Scale a body uniformly. */
export interface ScaleFeature extends FeatureBase {
  type: "scale";
  bodyId?: Id;
  factor: Expr;
  /** Scale about the body's own center, or the origin. */
  center: "body" | "origin";
  copy: boolean;
}

/** Tilt faces by an angle so parts release from moulds (or look tapered). */
export interface DraftFeature extends FeatureBase {
  type: "draft";
  faces: FaceRef[];
  angle: Expr;
  /** Pull direction (the faces tilt relative to it). */
  pull: "x" | "y" | "z";
  /** Position of the neutral plane (perpendicular to the pull) where faces keep their size. */
  neutral: Expr;
  flip: boolean;
}

/** Press/Pull: push or pull flat faces along their normals (grows or cuts material). */
export interface OffsetFaceFeature extends FeatureBase {
  type: "offsetFace";
  faces: FaceRef[];
  /** Positive pulls the faces outward (adds material), negative pushes them in (removes it). */
  distance: Expr;
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
  | SweepFeature
  | CoilFeature
  | SplitFeature
  | OffsetFeature
  | ScaleFeature
  | DraftFeature
  | OffsetFaceFeature
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
export type BodyFeature = ExtrudeFeature | RevolveFeature | PrimitiveFeature | LoftFeature | SweepFeature | CoilFeature;

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
  return f.type === "extrude" || f.type === "revolve" || f.type === "primitive" || f.type === "loft" || f.type === "sweep" || f.type === "coil";
}