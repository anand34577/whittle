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

export const SCHEMA_VERSION = 3;

/** A named set of values for some parameters, by parameter name. */
export interface Variant {
  id: Id;
  name: string;
  values: Record<string, Expr>;
}

export interface Parameter {
  id: Id;
  name: string;
  expr: Expr;
  kind: QuantityKind;
  comment?: string;
  /** Starred: listed first, and editable straight from the properties panel. */
  favorite?: boolean;
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
  | { kind: "face"; face: FaceRef; offset: Expr }
  /** A named construction plane (see ConstructionPlaneFeature). */
  | { kind: "construction"; plane: Id; offset: Expr };

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
  /** A control-point spline: the points steer a smooth B-spline curve that does not pass through them. */
  ctrl?: boolean;
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
  /** Centered on `c`; `a` is the end of the major (longer) axis and `r` the minor radius. */
  | { id: Id; type: "ellipse"; c: Id; a: Id; r: number; construction?: boolean }
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
  | "concentric"
  | "distance"
  | "radius"
  | "diameter"
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
  /** A reference dimension: it shows the measured value but doesn't drive the sketch (added when a normal one would over-constrain it). */
  driven?: boolean;
  /**
   * Where a dimension's value was dragged to, kept relative to what it measures so it follows the geometry:
   * a length's [offset beside it, shift along it] (mm), a radius or diameter's [angle (radians), distance beyond the curve (mm)],
   * an angle's [arc radius (mm), 0].
   */
  label?: [number, number];
}

/* ───────────────────────────── Features ───────────────────────────── */

export type BodyOp = "new" | "join" | "cut" | "intersect";

interface FeatureBase {
  id: Id;
  name: string;
  suppressed?: boolean;
}

/** A reusable plane (offset, tilted, or on a face) that sketches and other planes can sit on. */
export interface ConstructionPlaneFeature extends FeatureBase {
  type: "cplane";
  plane: PlaneRef;
}

export type ConstructMode =
  | "midplane" | "plane3" | "plane2e" | "planeEdge" | "planeTangent" | "planePath"
  | "axisCyl" | "axis2p" | "axis2pl" | "axisEdge" | "axisPerp"
  | "pointVertex" | "point2e" | "point3pl" | "pointCenter" | "pointEdgePlane";

/**
 * Construction geometry derived from model faces, edges and points: planes (sketchable),
 * axes and points (references). `value` is an angle (planeEdge, planeTangent) or a 0-100 %
 * position along the edge (planePath).
 */
export interface ConstructFeature extends FeatureBase {
  type: "construct";
  mode: ConstructMode;
  faces: FaceRef[];
  edges: EdgeRef[];
  points: Vec3[];
  value: Expr;
}

/** A thin reinforcing wall from an open sketch path: stands in the sketch plane and extends `depth` to one side. */
export interface RibFeature extends FeatureBase {
  type: "rib";
  sketch: Id;
  thickness: Expr;
  depth: Expr;
  flip: boolean;
  op: BodyOp;
  target?: Id;
}

/** A modeled screw thread cut along a cylindrical face (external rod or internal hole). */
export interface ThreadFeature extends FeatureBase {
  type: "thread";
  face: FaceRef | null;
  pitch: Expr;
  /** Threaded length along the face; empty = the whole face. */
  length: Expr;
  /** Groove depth; empty = ISO proportion of the pitch. */
  depth: Expr;
  lefthand: boolean;
}

/** Replace flat faces with a plane (another face, or a construction plane): the body grows or shrinks to meet it. */
export interface ReplaceFaceFeature extends FeatureBase {
  type: "replaceFace";
  faces: FaceRef[];
  target: FaceRef | null;
  plane?: Id;
  /** While true the next face click sets the target face instead of adding a face to replace. */
  pickTarget?: boolean;
}

/** Delete the faces of a hole, pocket or boss and heal the gap (the opening must be flat). */
export interface DeleteFaceFeature extends FeatureBase {
  type: "deleteFace";
  faces: FaceRef[];
}

/** Move a body so one of its flat faces meets a flat face of another body. */
export interface AlignFeature extends FeatureBase {
  type: "align";
  bodyId?: Id;
  from: FaceRef | null;
  to: FaceRef | null;
  /** Face to face by default; flip turns the body around. */
  flip: boolean;
  offset: Expr;
}

/** New bodies from the cells the tool bodies cut each other into (overlaps and leftovers). */
export interface BoundaryFillFeature extends FeatureBase {
  type: "boundaryFill";
  tools: Id[];
  /** Indices of the cells to keep as bodies. */
  cells: number[];
  keepTools: boolean;
}

/**
 * A 3D curve: through clicked points (3D sketch), copied from model edges (include 3D geometry),
 * where two faces meet (intersection curve) or a sketch laid onto a face (project to surface).
 */
export interface CurveFeature extends FeatureBase {
  type: "curve";
  source: "points" | "edges" | "faces" | "project";
  points: Vec3[];
  edges: EdgeRef[];
  faces: FaceRef[];
  sketch?: Id;
  smooth: boolean;
}

export type SurfaceOp = "patch" | "ruled" | "offset" | "trim" | "untrim" | "extend" | "stitch" | "unstitch" | "merge" | "reverse" | "thicken";

/** Surface tools: make surfaces (patch, ruled, offset) or edit and finish them (trim, stitch, thicken...). */
export interface SurfaceFeature extends FeatureBase {
  type: "surface";
  op: SurfaceOp;
  /** The body to work on (trim, unstitch, merge, reverse, thicken). */
  bodyId?: Id;
  /** Bodies to join (stitch). */
  bodies: Id[];
  faces: FaceRef[];
  edges: EdgeRef[];
  /** Offset / extend / ruled distance, or thickness. */
  distance: Expr;
  /** Ruled: out of the face's normal, along its surface, or along an axis. */
  direction: "normal" | "tangent" | "axis";
  axis: "x" | "y" | "z";
  /** Trim: the plane and the side to keep. */
  plane: OriginPlane;
  planeRef?: Id;
  offset: Expr;
  keep: "above" | "below";
  /** Thicken: grow both ways from the surface; keep the surface body afterwards. */
  both?: boolean;
  keep2?: boolean;
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
  /** Make a surface instead of a solid (sides only, no caps; open lines work too). */
  surface?: boolean;
  sketch: Id;
  /**
   * The sketch regions to use, each named by a point inside it (sketch coordinates). Unset: the whole sketch,
   * with shapes inside other shapes as holes.
   */
  regions?: Vec2[];
  distance: Expr;
  /** "two" = `distance` one way and `distance2` the other. */
  /** "through" = cut (or add) through everything in that direction; `distance` is ignored. */
  /** "face" = run exactly up to the flat face `toFace` (wherever it is), the way "to object" does in other CAD. */
  extent: "one" | "symmetric" | "two" | "through" | "face";
  toFace?: FaceRef;
  distance2?: Expr;
  flip: boolean;
  /** Start the extrusion this far above (or below) the sketch plane, along its normal. */
  startOffset?: Expr;
  /** Start from this flat face instead of the sketch plane (the offset then counts from the face). Present but empty while waiting for the click. */
  startFace?: FaceRef | null;
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
  /** Make a surface instead of a solid (sides only, no caps; open lines work too). */
  surface?: boolean;
  sketch: Id;
  /**
   * The sketch regions to use, each named by a point inside it (sketch coordinates). Unset: the whole sketch,
   * with shapes inside other shapes as holes.
   */
  regions?: Vec2[];
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
  /** Variable radius: the radius at the end of each edge (the start uses `radius`). */
  radius2?: Expr;
  /**
   * Full round: each picked straight edge and the parallel edge across its narrow flat face are rounded with half
   * the face's width, so the face becomes a half-round (the radius is ignored).
   */
  fullRound?: boolean;
}

export interface ChamferFeature extends FeatureBase {
  type: "chamfer";
  edges: EdgeRef[];
  distance: Expr;
  /** Equal setbacks (default), two different ones, or a setback and an angle. */
  mode?: "equal" | "two" | "angle";
  /** Second setback ("two"). */
  distance2?: Expr;
  /** Angle from the first face ("angle"), degrees. */
  angle?: Expr;
  /** Measure the first setback on the other face of each edge. */
  flip?: boolean;
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
  /** Mirror across a construction plane instead of an origin plane. */
  planeRef?: Id;
  merge: boolean;
  /** Mirror these earlier features (what they added or cut) instead of whole bodies. */
  features?: Id[];
}

export interface PatternFeature extends FeatureBase {
  type: "pattern";
  bodyId?: Id;
  pattern: "linear" | "circular" | "path";
  axis: "x" | "y" | "z";
  /** A construction axis to repeat along / around instead of an origin axis. */
  axisRef?: Id;
  /**
   * Or a direction / axis picked on the model: a straight edge, a circular edge or a round or flat face.
   * Present but empty while waiting for that click.
   */
  axisGeom?: { edge?: EdgeRef; face?: FaceRef };
  /** Path pattern: the sketch whose first path the copies follow, and whether they turn with it. */
  path?: Id;
  follow?: boolean;
  count: Expr;
  spacing: Expr;
  angle: Expr;
  /** Linear only: a second direction makes a grid. */
  axis2?: "x" | "y" | "z";
  count2?: Expr;
  spacing2?: Expr;
  merge: boolean;
  /** Repeat these earlier features (what they added or cut) instead of whole bodies. */
  features?: Id[];
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
  /** Countersink cone angle (default 90°; 82° for imperial flat heads). */
  sinkAngle?: Expr;
  /** Drill point at the bottom of a blind hole: the cone's angle (118° is a standard drill). Unset: flat bottom. */
  tipAngle?: Expr;
}

/** A smooth solid through two or more sketch profiles. */
export interface LoftFeature extends FeatureBase {
  type: "loft";
  /** Make a surface instead of a solid (sides only, no caps; open lines work too). */
  surface?: boolean;
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
  /** Make a surface instead of a solid (sides only, no caps; open lines work too). */
  surface?: boolean;
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
  /** Only cut the faces along the plane; keep one body. */
  facesOnly?: boolean;
  /** Cut where the body is widest along the plane's normal (a mould parting line); the offset is ignored. */
  silhouette?: boolean;
  /** Split along a construction plane instead of an origin plane. */
  planeRef?: Id;
}

/** Grow or shrink a whole body by a distance (clearances, tolerances, coatings). */
export interface OffsetFeature extends FeatureBase {
  type: "offset";
  bodyId?: Id;
  distance: Expr;
  copy: boolean;
}

/** A new body that just encloses others: a stock block for machining, a case blank, a keep-out volume. */
export interface BoundingSolidFeature extends FeatureBase {
  type: "boundingSolid";
  /** The bodies to enclose; empty means every body. */
  bodies: Id[];
  shape: "box" | "cylinder";
  /** Extra room on every side. */
  padding: Expr;
  /** The cylinder's axis. */
  axis: "x" | "y" | "z";
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

/**
 * A joint between two bodies: the moving body sits where the joint's value puts it.
 * Edit `angle` / `distance` to drive the joint; limits stop it at its ends.
 */
export interface JointFeature extends FeatureBase {
  type: "joint";
  /** The body that moves. */
  bodyId?: Id;
  /** The body it is attached to (stays put; documents what the joint connects). */
  fixedId?: Id;
  joint: "rigid" | "revolute" | "slider" | "cylindrical" | "planar" | "ball" | "pinslot";
  /** Joint origin: a construction axis (direction and pivot line) and/or point to use instead of the X/Y/Z axis and pivot above. */
  axisRef?: Id;
  originRef?: Id;
  /** Planar: slide along the plane's second direction. Ball: turns about the second and third axes. */
  distance2?: Expr;
  angle2?: Expr;
  angle3?: Expr;
  /** Contact set: warn when the moving body (or its component) runs into another body. */
  collide?: boolean;
  /** Motion link: this joint's main value follows another joint's (degrees or length) times a ratio. */
  link?: { joint: Id; ratio: Expr };
  /** Where the joint axis passes through: the moving body's center, or a point. */
  origin: "center" | "point";
  point: [Expr, Expr, Expr];
  /** The joint axis (rotation axis / slide direction). */
  axis: "x" | "y" | "z";
  angle: Expr;
  distance: Expr;
  /** Stop the joint at its ends of travel (degrees for a turn, length for a slide). */
  limited: boolean;
  min: Expr;
  max: Expr;
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
  /** "whittle" brings in every body of another Whittle design (a derived copy). */
  format: "step" | "stl" | "whittle";
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
  | BoundingSolidFeature
  | ScaleFeature
  | DraftFeature
  | JointFeature
  | ConstructionPlaneFeature
  | ConstructFeature
  | CurveFeature
  | SurfaceFeature
  | RibFeature
  | ThreadFeature
  | ReplaceFaceFeature
  | DeleteFaceFeature
  | AlignFeature
  | BoundaryFillFeature
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
  /** Physical material (a MATERIALS id in the web app) for mass; unset uses the design default. */
  material?: string;
  /** 0.05–1; overrides the finish's own transparency. */
  opacity?: number;
  /** Bodies sharing a component name move together under joints. */
  component?: string;
  /** A grounded body never moves under a joint. */
  grounded?: boolean;
}

export interface TimelineFolder {
  id: Id;
  name: string;
  features: Id[];
  open: boolean;
}

export interface NamedView {
  id: Id;
  name: string;
  target: [number, number, number];
  distance: number;
  /** Azimuth around Z and angle from +Z, radians. */
  theta: number;
  phi: number;
}

export interface WhittleDocument {
  schema: number;
  /** Stable identity across saves (keys local version history). Older files get one on open. */
  id?: Id;
  name: string;
  units: LengthUnit;
  parameters: Parameter[];
  /** Named sets of parameter values (sizes, options) to switch between: "Small", "Large", "With lid". */
  variants?: Variant[];
  features: Feature[];
  bodies: Record<Id, BodyMeta>;
  /** Named folders in the timeline, folding a run of steps into one. */
  folders?: TimelineFolder[];
  /** Saved camera views ("Front detail", "Underside"), restored from the browser. */
  views?: NamedView[];
  /** Timeline rollback marker: only features before this index are built. */
  rollback: number | null;
  createdAt: string;
  modifiedAt: string;
}

export function isBodyFeature(f: Feature): f is BodyFeature {
  return f.type === "extrude" || f.type === "revolve" || f.type === "primitive" || f.type === "loft" || f.type === "sweep" || f.type === "coil";
}