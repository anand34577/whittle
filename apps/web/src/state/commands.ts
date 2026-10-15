/**
 * One registry for every command: the toolbar, the command palette, the
 * radial menu and the keyboard shortcuts all read from here, so they can
 * never disagree.
 */
import type { IconName } from "../ui/icons";
import {
  addPrimitive,
  importModel,
  startCoil,
  startCombine,
  startDraft,
  startEdgeFeature,
  startEdgeFeatureAll,
  startOffset,
  startScale,
  startSplit,
  startPipe,
  startSweep,
  startExtrude,
  startHole,
  startLoft,
  startMirror,
  startMove,
  startPattern,
  startRevolve,
  startShell,
  startSketch,
} from "./actions";
import { downloadCopy, exportDesign, newDesign, openDesign, openFromComputer, saveDesign, saveScreenshot } from "./files";
import { exportSketch, importSvgIntoSketch, sketchForExport } from "./drawings";
import { duplicateEntity, mirrorEntity, offsetEntity, rotateEntity } from "./sketchOps";
import { type ConstraintType, CONSTRAINT_LABELS, DIMENSIONS } from "@whittle/core";
import { breakSelection, gridPatternSelection, moveSelection, scaleSelection, availableConstraints, constrainSelection, deleteSketchSelection, makeConstrainable, mirrorSelection, offsetSelection, toggleGeometryConstruction } from "./constraintOps";
import { importImage, startImagePick, traceImage } from "./refImage";
import { THEMES } from "./prefs";
import {
  type AppState,
  type DisplayMode,
  cancelSession,
  commitSession,
  confirmDeleteFeature,
  deleteEntity,
  findFeature,
  finishSketch,
  mutate,
  redo,
  requestView,
  setSketchTool,
  setTheme,
  setView,
  sketchMutate,
  undo,
  useApp,
} from "./store";

export interface Command {
  id: string;
  label: string;
  group: string;
  icon?: IconName;
  /** Display string, e.g. "Ctrl+Z". */
  keys?: string;
  /** Extra search words (synonyms), so "round edges" finds Fillet. */
  keywords?: string;
  hint?: string;
  /** Shorter label for toolbar buttons. */
  short?: string;
  when?: (s: AppState) => boolean;
  /** Toggle state, for buttons that stay pressed. */
  on?: (s: AppState) => boolean;
  run: () => void;
}

const inModel = (s: AppState) => s.mode.kind === "model" || s.mode.kind === "measure";
const inSketch = (s: AppState) => s.mode.kind === "sketch";
const hasGeometry = (s: AppState) => inSketch(s) && s.sketchSel.length > 0;
const hasEntity = (s: AppState) => inSketch(s) && !!s.selectedEntity;
const hasImage = (s: AppState) => s.mode.kind === "sketch" && !!findFeature(s.doc, s.mode.sketchId, "sketch")?.image;
const hasBodies = (s: AppState) => (s.regen?.bodies.length ?? 0) > 0;
const get = useApp.getState;

/** Leave measure mode before starting another command. */
const model = (fn: () => void) => () => {
  if (get().mode.kind === "measure") useApp.setState({ mode: { kind: "model" }, measure: [] });
  fn();
};

const display = (d: DisplayMode, label: string, keywords: string): Command => ({
  id: `display-${d}`,
  label,
  group: "View",
  icon: d === "wire" ? "wire" : d === "xray" ? "xray" : d === "shaded" ? "shaded" : "cube",
  keywords: "display style render " + keywords,
  on: (s) => s.view.display === d,
  run: () => setView({ display: d }),
});

const CONSTRAINT_HINTS: Record<ConstraintType, string> = {
  coincident: "Join two points, or put a point on a curve",
  horizontal: "Make a line (or two points) level",
  vertical: "Make a line (or two points) upright",
  parallel: "Make two lines run the same way",
  perpendicular: "Make two lines meet at a right angle",
  tangent: "Make a line and arc (or two arcs) touch smoothly",
  equal: "Give two lines the same length, or two arcs the same radius",
  fixed: "Pin geometry where it is",
  symmetric: "Mirror two points about a line (or about a third point, picked last)",
  midpoint: "Put a point at the middle of a line",
  collinear: "Make two lines lie on one line",
  distance: "A length, or the gap between points and lines",
  radius: "The radius of a circle or arc",
  angle: "The angle of a line, or between two lines",
};

/** Constraint commands, for the toolbar menu and the palette. */
export const CONSTRAINT_COMMANDS = Object.keys(CONSTRAINT_HINTS).map((t) => `constrain-${t}`);

export const COMMANDS: Command[] = [
  // Create
  { id: "sketch", label: "Sketch", group: "Create", icon: "sketch", keys: "S", keywords: "draw 2d profile drawing", hint: "Draw a 2D profile on a plane or flat face", when: inModel, run: model(startSketch) },
  { id: "extrude", label: "Extrude", group: "Create", icon: "extrude", keys: "E", keywords: "push pull pad boss height thickness", hint: "Turn a sketch into a solid by pulling it", when: inModel, run: model(startExtrude) },
  { id: "revolve", label: "Revolve", group: "Create", icon: "revolve", keys: "R", keywords: "lathe spin turn rotate around axis vase", hint: "Spin a sketch around an axis", when: inModel, run: model(startRevolve) },
  { id: "loft", label: "Loft", group: "Create", icon: "loft", keywords: "blend transition morph between profiles", hint: "Blend smoothly between two or more sketches", when: inModel, run: model(startLoft) },
  { id: "sweep", label: "Sweep", group: "Create", icon: "sweep", keywords: "pipe tube path rail handle gasket wire follow along curve", hint: "Move a cross-section along a path: pipes, handles, rails", when: inModel, run: model(startSweep) },
  { id: "pipe", label: "Pipe", group: "Create", icon: "sweep", keywords: "tube hose conduit round square hollow path rail", hint: "A round or square tube along a path, solid or hollow", when: inModel, run: model(startPipe) },
  { id: "spring", label: "Coil / spring", short: "Coil", group: "Create", icon: "coil", keywords: "helix helical spring coil spiral auger", hint: "A helical coil: springs, spirals, augers", when: inModel, run: model(() => startCoil("spring")) },
  { id: "thread", label: "Thread", group: "Create", icon: "thread", keywords: "screw bolt nut tap threaded rod helix iso metric", hint: "A screw thread: join it to a rod, or cut it from a hole", when: inModel, run: model(() => startCoil("thread")) },
  { id: "hole", label: "Hole", group: "Create", icon: "hole", keys: "D", keywords: "drill screw bolt counterbore countersink m3 m4 bore", hint: "Drill holes on a face: simple, counterbored or countersunk", when: (s) => inModel(s) && hasBodies(s), run: model(startHole) },
  { id: "box", label: "Box", group: "Shapes", icon: "box", keywords: "cube block primitive quick shape", hint: "Add a box you can size directly", when: inModel, run: model(() => addPrimitive("box")) },
  { id: "cylinder", label: "Cylinder", group: "Shapes", icon: "cylinder", keywords: "rod post peg primitive quick shape", hint: "Add a cylinder", when: inModel, run: model(() => addPrimitive("cylinder")) },
  { id: "sphere", label: "Sphere", group: "Shapes", icon: "sphere", keywords: "ball dome primitive quick shape", hint: "Add a sphere", when: inModel, run: model(() => addPrimitive("sphere")) },
  { id: "cone", label: "Cone", group: "Shapes", icon: "cone", keywords: "taper funnel frustum spike primitive", hint: "Add a cone or tapered cylinder", when: inModel, run: model(() => addPrimitive("cone")) },
  { id: "torus", label: "Torus", group: "Shapes", icon: "torus", keywords: "ring donut o-ring primitive", hint: "Add a ring", when: inModel, run: model(() => addPrimitive("torus")) },
  { id: "tube", label: "Tube", group: "Shapes", icon: "tube", keywords: "pipe sleeve spacer hollow cylinder bushing primitive", hint: "Add a hollow cylinder", when: inModel, run: model(() => addPrimitive("tube")) },
  { id: "parts", label: "Parts library", short: "Parts", group: "Create", icon: "library", keys: "P", keywords: "gear nut bolt washer bracket standoff hinge insert ready made catalog", hint: "Insert ready-made, editable parts", when: inModel, run: model(() => useApp.setState({ panel: "parts" })) },
  { id: "import", label: "Import STEP / STL", short: "Import", group: "Create", icon: "import", keywords: "open insert step stp stl mesh reference", hint: "Bring in a part from another CAD tool or a mesh", when: inModel, run: model(importModel) },
  // Modify
  { id: "fillet", label: "Fillet", group: "Modify", icon: "fillet", keys: "F", keywords: "round edges rounded smooth radius", hint: "Round off sharp edges", when: (s) => inModel(s) && hasBodies(s), run: model(() => startEdgeFeature("fillet")) },
  { id: "chamfer", label: "Chamfer", group: "Modify", icon: "chamfer", keywords: "bevel edges angle cut corner", hint: "Bevel edges with a flat cut", when: (s) => inModel(s) && hasBodies(s), run: model(() => startEdgeFeature("chamfer")) },
  { id: "shell", label: "Shell", group: "Modify", icon: "shell", keywords: "hollow wall thickness enclosure box case cup", hint: "Hollow out a body, leaving walls", when: (s) => inModel(s) && hasBodies(s), run: model(startShell) },
  { id: "move", label: "Move / Copy", group: "Modify", icon: "move", keys: "M", keywords: "translate rotate position place duplicate copy transform", hint: "Move or rotate a body, or make a moved copy", when: (s) => inModel(s) && hasBodies(s), run: model(startMove) },
  { id: "combine", label: "Combine", group: "Modify", icon: "combine", keys: "J", keywords: "boolean join merge union subtract cut intersect", hint: "Join, cut or intersect bodies", when: (s) => inModel(s) && (s.regen?.bodies.length ?? 0) > 1, run: model(startCombine) },
  { id: "mirror", label: "Mirror", group: "Modify", icon: "mirror", keywords: "symmetry flip copy reflect", hint: "Mirror a body across an origin plane", when: (s) => inModel(s) && hasBodies(s), run: model(startMirror) },
  { id: "pattern", label: "Pattern", group: "Modify", icon: "pattern", keywords: "array repeat copies linear circular", hint: "Repeat a body in a row or around an axis", when: (s) => inModel(s) && hasBodies(s), run: model(startPattern) },
  { id: "split", label: "Split body", short: "Split", group: "Modify", icon: "split", keywords: "cut in half slice divide trim separate two parts", hint: "Cut a body in two along a plane, or trim one side away", when: (s) => inModel(s) && hasBodies(s), run: model(startSplit) },
  { id: "draft", label: "Draft", group: "Modify", icon: "draft", keywords: "taper angle mould mold casting release tilt faces", hint: "Tilt faces so a part releases from a mould", when: (s) => inModel(s) && hasBodies(s), run: model(startDraft) },
  { id: "offset", label: "Offset body", short: "Offset", group: "Modify", icon: "offset", keywords: "grow shrink thicken clearance tolerance inflate", hint: "Grow or shrink a whole body (clearances and tolerances)", when: (s) => inModel(s) && hasBodies(s), run: model(startOffset) },
  { id: "scale", label: "Scale body", short: "Scale", group: "Modify", icon: "scale", keywords: "resize bigger smaller enlarge reduce percent", hint: "Make a body bigger or smaller", when: (s) => inModel(s) && hasBodies(s), run: model(startScale) },
  { id: "fillet-all", label: "Round all edges", group: "Modify", icon: "fillet", keywords: "fillet every edge soften smooth whole body", hint: "Fillet every edge of a body at once", when: (s) => inModel(s) && hasBodies(s), run: model(() => startEdgeFeatureAll("fillet")) },
  { id: "chamfer-all", label: "Bevel all edges", group: "Modify", icon: "chamfer", keywords: "chamfer every edge whole body", hint: "Chamfer every edge of a body at once", when: (s) => inModel(s) && hasBodies(s), run: model(() => startEdgeFeatureAll("chamfer")) },
  // Inspect
  {
    id: "measure",
    label: "Measure",
    group: "Inspect",
    icon: "measure",
    keys: "I",
    keywords: "distance dimension ruler caliper size diameter angle inspect",
    hint: "Click one or two things to measure them",
    when: (s) => s.mode.kind === "model" || s.mode.kind === "measure",
    on: (s) => s.mode.kind === "measure",
    run: () => {
      const s = get();
      if (s.session) commitSession();
      useApp.setState({ mode: s.mode.kind === "measure" ? { kind: "model" } : { kind: "measure" }, measure: [], selection: [] });
    },
  },
  {
    id: "section",
    label: "Section view",
    short: "Section",
    group: "Inspect",
    icon: "section",
    keywords: "cut away cross section clip slice inside",
    hint: "Slice the view to see inside (doesn't change the model)",
    on: (s) => !!s.view.section,
    run: () => setView({ section: get().view.section ? null : { axis: "y", offset: 0, flip: false } }),
  },
  {
    id: "overhang",
    label: "Overhang check",
    short: "Overhangs",
    group: "Inspect",
    icon: "overhang",
    keywords: "3d print overhang support analysis printable",
    hint: "3D printing: show faces that will need support",
    on: (s) => s.view.analysis === "overhang",
    run: () => setView({ analysis: get().view.analysis === "overhang" ? null : "overhang" }),
  },
  {
    id: "draft-analysis",
    label: "Draft analysis",
    group: "Inspect",
    icon: "draft",
    keywords: "mould mold casting injection release angle undercut",
    hint: "Moulding and casting: color faces by draft angle toward the pull direction (Z)",
    on: (s) => s.view.analysis === "draft",
    run: () => setView({ analysis: get().view.analysis === "draft" ? null : "draft" }),
  },
  {
    id: "zebra",
    label: "Zebra stripes",
    group: "Inspect",
    icon: "zebra",
    keywords: "surface quality continuity smooth reflection curvature industrial design class a",
    hint: "Surface design: reflection stripes show how smoothly faces flow into each other",
    on: (s) => s.view.analysis === "zebra",
    run: () => setView({ analysis: get().view.analysis === "zebra" ? null : "zebra" }),
  },
  display("edges", "Shaded with edges", "solid default"),
  display("shaded", "Shaded", "smooth no edges"),
  display("wire", "Wireframe", "lines mesh"),
  display("xray", "X-ray", "transparent see through ghost"),
  { id: "grid", label: "Grid", group: "View", icon: "grid", keywords: "floor lines show hide", on: (s) => s.view.grid, run: () => setView({ grid: !get().view.grid }) },
  { id: "ortho", label: "Orthographic", group: "View", icon: "ortho", keywords: "perspective parallel projection camera", on: (s) => s.view.ortho, run: () => setView({ ortho: !get().view.ortho }) },
  { id: "screenshot", label: "Save image", group: "View", icon: "camera", keywords: "screenshot png picture render capture", run: () => void saveScreenshot() },
  { id: "show-all", label: "Show all bodies", group: "View", icon: "eye", keywords: "unhide reveal", run: () => mutate("Show all", (d) => void Object.values(d.bodies).forEach((b) => (b.visible = true))) },
  // Sketch tools
  { id: "tool-line", label: "Line", group: "Sketch", icon: "line", keys: "L", keywords: "polyline polygon outline profile", hint: "Click points; click the first point to close", when: inSketch, run: () => setSketchTool("polyline") },
  { id: "tool-path", label: "Path", group: "Sketch", icon: "path", keys: "A", keywords: "open line wire rail spine curve for sweep guide", hint: "An open line: a path for sweeps (Enter to finish)", when: inSketch, run: () => setSketchTool("path") },
  { id: "tool-rect", label: "Rectangle", group: "Sketch", icon: "rect", keys: "R", keywords: "square box", hint: "Two corners", when: inSketch, run: () => setSketchTool("rect") },
  { id: "tool-crect", label: "Center rectangle", group: "Sketch", icon: "rect", keywords: "square box centre middle", hint: "Center, then a corner", when: inSketch, run: () => setSketchTool("crect") },
  { id: "tool-rect3", label: "3-point rectangle", short: "3-pt rect", group: "Sketch", icon: "rect", keywords: "square box tilted angled rotated three point", hint: "Two corners of one side, then the width", when: inSketch, run: () => setSketchTool("rect3") },
  { id: "tool-circle", label: "Circle", group: "Sketch", icon: "circle", keys: "C", keywords: "round hole diameter", hint: "Center, then radius", when: inSketch, run: () => setSketchTool("circle") },
  { id: "tool-circle2", label: "2-point circle", short: "2-pt circle", group: "Sketch", icon: "circle", keywords: "round hole diameter two point", hint: "Two points across the circle", when: inSketch, run: () => setSketchTool("circle2") },
  { id: "tool-circle3", label: "3-point circle", short: "3-pt circle", group: "Sketch", icon: "circle", keywords: "round hole through three points", hint: "Three points on the circle", when: inSketch, run: () => setSketchTool("circle3") },
  { id: "tool-ellipse", label: "Ellipse", group: "Sketch", icon: "ellipse", keys: "E", keywords: "oval egg", hint: "Center, then a corner of its box", when: inSketch, run: () => setSketchTool("ellipse") },
  { id: "tool-polygon", label: "Polygon", group: "Sketch", icon: "polygon", keys: "P", keywords: "hexagon nut sides triangle", hint: "Center, then a corner", when: inSketch, run: () => setSketchTool("polygon") },
  { id: "tool-slot", label: "Slot", group: "Sketch", icon: "slot", keys: "O", keywords: "oblong obround", hint: "Two centers", when: inSketch, run: () => setSketchTool("slot") },
  { id: "tool-text", label: "Text", group: "Sketch", icon: "text", keys: "T", keywords: "label lettering engrave emboss name tag font", hint: "Click where the text starts", when: inSketch, run: () => setSketchTool("text") },
  { id: "tool-gear", label: "Gear", group: "Sketch", icon: "gear", keys: "G", keywords: "spur cog teeth involute", hint: "Center, then drag the size", when: inSketch, run: () => setSketchTool("gear") },
  { id: "import-image", label: "Picture to trace", short: "Picture", group: "Sketch", icon: "image", keywords: "image photo reference canvas underlay background trace scan blueprint jpg png attach", hint: "Put a photo or drawing on the sketch to draw over. Also: paste or drop one", run: importImage },
  { id: "calibrate-image", label: "Calibrate picture", group: "Sketch", icon: "calibrate", keywords: "scale image photo true size measure reference length", hint: "Click two points on the picture and type their real distance", when: hasImage, run: () => startImagePick("calibrate") },
  { id: "flatten-image", label: "Flatten photo", group: "Sketch", icon: "flatten", keywords: "perspective straighten deskew rectify keystone a4 paper card photo image", hint: "Click the corners of a sheet of paper or a card in the photo to straighten and scale it", when: hasImage, run: () => startImagePick("flatten") },
  { id: "trace-image", label: "Trace whole picture", group: "Sketch", icon: "trace", keywords: "auto trace vectorize outline silhouette image photo convert", hint: "Turn the picture's shapes into editable outlines; round holes become circles", when: hasImage, run: () => void traceImage() },
  { id: "trace-area", label: "Trace one area of the picture", group: "Sketch", icon: "trace", keywords: "magic wand flood fill select region outline image photo", hint: "Click one shape in the picture to outline just that", when: hasImage, run: () => startImagePick("wand") },
  { id: "import-svg", label: "Import SVG into sketch", short: "SVG", group: "Sketch", icon: "vector", keywords: "logo trace vector illustrator inkscape figma outline artwork drawing image", hint: "Bring in a logo or outline as editable shapes", when: inSketch, run: importSvgIntoSketch },
  { id: "export-sketch-svg", label: "Export sketch as SVG", group: "File", icon: "drawing", keywords: "laser cut vinyl cricut plotter 2d drawing vector", hint: "True-size 2D drawing for laser cutters, vinyl cutters and plotters", when: () => !!sketchForExport(), run: () => void exportSketch(sketchForExport()!.id, "svg") },
  { id: "export-sketch-dxf", label: "Export sketch as DXF", group: "File", icon: "drawing", keywords: "cnc router laser cam 2d drawing autocad", hint: "2D drawing for CNC, CAM and other CAD", when: () => !!sketchForExport(), run: () => void exportSketch(sketchForExport()!.id, "dxf") },
  { id: "tool-select", label: "Select", group: "Sketch", icon: "select", keys: "V", keywords: "move pick edit", hint: "Select and drag shapes", when: inSketch, run: () => setSketchTool("select") },
  { id: "tool-segment", label: "Constrained line", short: "Lines", group: "Sketch", icon: "line", keywords: "segment constraint parametric sketcher professional dimension", hint: "Lines the solver keeps to your constraints; click the first point to close", when: inSketch, run: () => setSketchTool("segment") },
  { id: "tool-arc", label: "Constrained arc", short: "Arc", group: "Sketch", icon: "path", keywords: "arc three point curve constraint tangent", hint: "Start, end, then a point on the arc", when: inSketch, run: () => setSketchTool("arc") },
  { id: "tool-carc", label: "Center-point arc", short: "Center arc", group: "Sketch", icon: "path", keywords: "arc centre radius sweep", hint: "Center, start, then end", when: inSketch, run: () => setSketchTool("carc") },
  { id: "tool-polygonc", label: "Circumscribed polygon", short: "Circ. polygon", group: "Sketch", icon: "polygon", keywords: "polygon apothem flat to flat hexagon", hint: "Center, then the middle of an edge", when: inSketch, run: () => setSketchTool("polygonC") },
  { id: "tool-polygone", label: "Edge polygon", short: "Edge polygon", group: "Sketch", icon: "polygon", keywords: "polygon side length hexagon", hint: "Two points define one edge", when: inSketch, run: () => setSketchTool("polygonE") },
  { id: "tool-conic", label: "Conic curve", short: "Conic", group: "Sketch", icon: "path", keywords: "parabola ellipse hyperbola rho apex", hint: "Start, end, then the apex; type rho for the shape", when: inSketch, run: () => setSketchTool("conic") },
  { id: "tool-pcircle", label: "Constrained circle", short: "Circle", group: "Sketch", icon: "circle", keywords: "circle constraint radius dimension", hint: "Center, then radius", when: inSketch, run: () => setSketchTool("pcircle") },
  { id: "tool-project", label: "Project model edges", short: "Project", group: "Sketch", icon: "link", keywords: "include intersect reference edge face outline copy existing body derive", hint: "Click an edge or face of the model to copy it into the sketch as locked geometry", when: (s) => inSketch(s) && hasBodies(s), run: () => setSketchTool("project") },
  { id: "tool-spline", label: "Spline", group: "Sketch", icon: "path", keys: "Shift+S", keywords: "curve smooth fit points freeform bezier flowing", hint: "A smooth curve through points you can move, dimension and constrain", when: inSketch, run: () => setSketchTool("spline") },
  { id: "tool-dimension", label: "Dimension", group: "Sketch", icon: "ruler", keys: "D", keywords: "size length radius distance angle measure constrain smart", hint: "Click a line, circle, arc or two items to set an exact size", when: inSketch, run: () => setSketchTool("dimension") },
  { id: "tool-sfillet", label: "Sketch fillet", short: "Fillet", group: "Sketch", icon: "fillet", keywords: "round corner radius arc blend", hint: "Click a corner where two lines meet, then type the radius", when: inSketch, run: () => setSketchTool("sfillet") },
  { id: "tool-schamfer", label: "Sketch chamfer", short: "Chamfer", group: "Sketch", icon: "chamfer", keywords: "bevel cut corner", hint: "Click a corner where two lines meet, then type the distance", when: inSketch, run: () => setSketchTool("schamfer") },
  { id: "tool-gpoint", label: "Point", group: "Sketch", icon: "point", keywords: "dot marker datum construction", hint: "Click to place a point you can dimension and constrain to", when: inSketch, run: () => setSketchTool("gpoint") },
  { id: "make-constrainable", label: "Make constrainable", short: "Constrain", group: "Sketch", icon: "link", keywords: "convert dimension constraint lines geometry trim fillet parametric", hint: "Turn this shape into lines and arcs you can dimension, constrain, trim and fillet", when: (s) => hasEntity(s) && s.selectedEntity !== null, run: () => makeConstrainable() },
  { id: "geo-move", label: "Move geometry", short: "Move", group: "Sketch", icon: "move", keywords: "translate shift stretch reposition numeric", hint: "Select geometry, then type how far to move it", when: hasGeometry, run: () => void moveSelection(false) },
  { id: "geo-copy", label: "Copy geometry", short: "Copy", group: "Sketch", icon: "duplicate", keywords: "duplicate clone offset translate", hint: "Select geometry, then type how far to place the copy", when: hasGeometry, run: () => void moveSelection(true) },
  { id: "geo-scale", label: "Scale geometry", short: "Scale", group: "Sketch", icon: "scale", keywords: "resize bigger smaller factor enlarge shrink", hint: "Select geometry, then type a scale factor", when: hasGeometry, run: () => void scaleSelection() },
  { id: "geo-grid", label: "Rectangular pattern", short: "Grid pattern", group: "Sketch", icon: "duplicate", keywords: "array rows columns repeat grid", hint: "Select geometry, then give columns, rows and gaps", when: hasGeometry, run: () => void gridPatternSelection() },
  { id: "geo-break", label: "Break line at crossing", short: "Break", group: "Sketch", icon: "split", keywords: "split cut divide intersect segment", hint: "Select the line to split, then the line that crosses it", when: hasGeometry, run: () => breakSelection() },
  { id: "geo-offset", label: "Offset lines and arcs", short: "Offset", group: "Sketch", icon: "offset", keywords: "inset outset parallel concentric grow shrink wall", hint: "Select lines, arcs or circles, then give a distance", when: hasGeometry, run: () => void offsetSelection() },
  { id: "geo-mirror-y", label: "Mirror geometry across the Y axis", short: "Mirror ↔", group: "Sketch", icon: "mirror", keywords: "flip symmetric copy left right", hint: "A mirrored copy held symmetric to the original", when: hasGeometry, run: () => mirrorSelection("y") },
  { id: "geo-mirror-x", label: "Mirror geometry across the X axis", short: "Mirror ↕", group: "Sketch", icon: "mirror", keywords: "flip symmetric copy up down", hint: "A mirrored copy held symmetric to the original", when: hasGeometry, run: () => mirrorSelection("x") },
  { id: "geo-mirror-line", label: "Mirror geometry across a line", short: "Mirror line", group: "Sketch", icon: "mirror", keywords: "flip symmetric copy axis", hint: "Select the geometry, then the mirror line last", when: hasGeometry, run: () => mirrorSelection("line") },
  { id: "tool-trim", label: "Trim", group: "Sketch", icon: "split", keywords: "cut remove piece segment between intersections", hint: "Click the piece of a line, arc or circle to remove", when: inSketch, run: () => setSketchTool("trim") },
  { id: "tool-extend", label: "Extend", group: "Sketch", icon: "arrowRight", keywords: "lengthen stretch to meet", hint: "Click near the end of a line or arc to stretch it to the next curve", when: inSketch, run: () => setSketchTool("extend") },
  ...(Object.keys(CONSTRAINT_LABELS) as ConstraintType[]).map(
    (t): Command => ({
      id: `constrain-${t}`,
      label: CONSTRAINT_LABELS[t],
      group: "Constrain",
      icon: DIMENSIONS.includes(t) ? "ruler" : t === "fixed" ? "key" : "link",
      keywords: `constraint ${DIMENSIONS.includes(t) ? "dimension size" : "relation"} ${t}`,
      hint: CONSTRAINT_HINTS[t],
      when: (s) => inSketch(s) && s.sketchSel.length > 0 && availableConstraints().includes(t),
      run: () => void constrainSelection(t),
    }),
  ),
  { id: "duplicate", label: "Duplicate shape", short: "Duplicate", group: "Sketch", icon: "duplicate", keys: "Ctrl+D", keywords: "copy clone", when: hasEntity, run: () => duplicateEntity() },
  { id: "mirror-shape-y", label: "Mirror shape left/right", short: "Mirror", group: "Sketch", icon: "mirror", keywords: "flip symmetric copy", when: hasEntity, run: () => mirrorEntity("y") },
  { id: "mirror-shape-x", label: "Mirror shape up/down", group: "Sketch", icon: "mirror", keywords: "flip symmetric copy", when: hasEntity, run: () => mirrorEntity("x") },
  { id: "rotate-shape", label: "Rotate shape 90°", short: "Rotate 90°", group: "Sketch", icon: "rotate", keys: "Shift+R", keywords: "turn spin", when: hasEntity, run: () => rotateEntity(90) },
  { id: "offset-shape", label: "Offset shape", short: "Offset", group: "Sketch", icon: "offset", keys: "Shift+O", keywords: "inset outset grow shrink parallel wall lip clearance", hint: "A copy grown outward or shrunk inward", when: hasEntity, run: () => void offsetEntity() },
  {
    id: "construction",
    label: "Toggle construction",
    short: "Construction",
    group: "Sketch",
    icon: "construction",
    keys: "X",
    keywords: "reference helper guide",
    hint: "Construction shapes guide you but don't make solids",
    when: (s) => hasEntity(s) || (inSketch(s) && s.sketchSel.length > 0),
    run: () => {
      if (!get().selectedEntity) return toggleGeometryConstruction();
      const id = get().selectedEntity;
      sketchMutate("Toggle construction", (sk) => {
        const e = sk.entities.find((x) => x.id === id);
        if (e) e.construction = !e.construction;
      });
    },
  },
  { id: "finish-sketch", label: "Finish sketch", group: "Sketch", icon: "finish", keys: "Esc", keywords: "done exit close stop", when: inSketch, run: finishSketch },
  // Document
  { id: "ok", label: "OK (apply)", group: "Edit", icon: "check", keys: "Enter", when: (s) => !!s.session && s.mode.kind === "model", run: commitSession },
  { id: "cancel", label: "Cancel", group: "Edit", icon: "close", keys: "Esc", when: (s) => !!s.session && s.mode.kind === "model", run: cancelSession },
  { id: "undo", label: "Undo", group: "Edit", icon: "undo", keys: "Ctrl+Z", run: undo },
  { id: "redo", label: "Redo", group: "Edit", icon: "redo", keys: "Ctrl+Shift+Z", run: redo },
  {
    id: "delete",
    label: "Delete selection",
    group: "Edit",
    icon: "trash",
    keys: "Del",
    keywords: "remove erase",
    when: (s) => (s.mode.kind === "sketch" ? !!s.selectedEntity || s.sketchSel.length > 0 : s.selection.some((p) => p.kind === "sketch" || p.kind === "body")),
    run: () => {
      const s = get();
      if (s.mode.kind === "sketch" && s.selectedEntity) return deleteEntity(s.selectedEntity);
      if (s.mode.kind === "sketch") return deleteSketchSelection();
      const p = s.selection.find((x) => x.kind === "sketch" || x.kind === "body");
      const id = p?.kind === "sketch" ? p.sketchId : p?.kind === "body" ? p.bodyId : undefined;
      if (id) void confirmDeleteFeature(id);
    },
  },
  {
    id: "hide",
    label: "Hide body",
    group: "View",
    icon: "eyeOff",
    keywords: "hide body",
    when: (s) => s.selection.some((p) => p.kind === "body" || p.kind === "face" || p.kind === "edge"),
    run: () => {
      const ids = get().selection.flatMap((p) => (p.kind === "body" || p.kind === "face" || p.kind === "edge" ? [p.bodyId] : []));
      mutate("Hide body", (d) => ids.forEach((id) => d.bodies[id] && (d.bodies[id]!.visible = false)));
      useApp.setState({ selection: [] });
    },
  },
  {
    id: "isolate",
    label: "Isolate body",
    group: "View",
    icon: "isolate",
    keywords: "show only focus solo",
    when: (s) => s.selection.some((p) => p.kind === "body" || p.kind === "face" || p.kind === "edge"),
    run: () => {
      const keep = new Set(get().selection.flatMap((p) => (p.kind === "body" || p.kind === "face" || p.kind === "edge" ? [p.bodyId] : [])));
      mutate("Isolate", (d) => Object.entries(d.bodies).forEach(([id, b]) => (b.visible = keep.has(id))));
    },
  },
  { id: "params", label: "Parameters", group: "Document", icon: "params", keywords: "variables dimensions named values formula", hint: "Named values that drive your design", run: () => useApp.setState({ panel: "params" }) },
  { id: "new", label: "New design", group: "File", icon: "file", keywords: "blank start", run: () => newDesign() },
  { id: "new-inch", label: "New design (inches)", group: "File", icon: "file", keywords: "imperial blank", run: () => newDesign("in") },
  { id: "open", label: "Open…", group: "File", icon: "open", keys: "Ctrl+O", run: () => void openDesign() },
  { id: "save", label: "Save", group: "File", icon: "save", keys: "Ctrl+S", run: () => void saveDesign() },
  { id: "save-as", label: "Save as…", group: "File", icon: "save", keys: "Ctrl+Shift+S", hint: "Save under a new name (a separate design)", run: () => void saveDesign(true) },
  { id: "open-local", label: "Open from this computer…", group: "File", icon: "folder", keywords: "upload import whittle file disk", when: (s) => s.platform.kind === "server", run: () => void openFromComputer() },
  { id: "download-copy", label: "Save a copy to this computer", group: "File", icon: "export", keywords: "download backup whittle file", when: (s) => s.platform.kind === "server", run: () => void downloadCopy() },
  { id: "history", label: "Version history", group: "File", icon: "history", keywords: "versions restore previous older backup revert undo save", hint: "Every save is kept: look back and restore", run: () => useApp.setState({ panel: "versions" }) },
  { id: "account", label: "Account", group: "File", icon: "users", keywords: "sign out logout password user profile", when: (s) => s.platform.kind === "server" && !!s.platform.user, run: () => useApp.setState({ panel: "account" }) },
  { id: "users", label: "Administration", group: "File", icon: "shield", keywords: "admin accounts people team users manage merge sso smtp email settings audit", when: (s) => s.platform.kind === "server" && !!s.platform.user?.isAdmin && s.platform.config.auth === "required", run: () => useApp.setState({ panel: "users" }) },
  { id: "export", label: "Export…", group: "File", icon: "export", keywords: "step stl 3mf print slicer download cad cnc", hint: "STEP for other CAD and machining, 3MF / STL for 3D printing", run: () => useApp.setState({ panel: "export" }) },
  { id: "export-step", label: "Export STEP", short: "STEP", group: "File", icon: "export", keywords: "cad exchange fusion solidworks onshape freecad cnc machining", hint: "Exact geometry for other CAD tools, CNC and manufacturing", run: () => void exportDesign("step") },
  { id: "export-3mf", label: "Export 3MF", short: "3MF", hint: "Mesh with units and colors, for 3D-printing slicers", group: "File", icon: "print", keywords: "3d print slicer bambu prusa orca cura", run: () => void exportDesign("3mf") },
  { id: "export-stl", label: "Export STL", short: "STL", group: "File", icon: "export", keywords: "3d print slicer mesh", hint: "Universal mesh format", run: () => void exportDesign("stl") },
  // View
  { id: "view-home", label: "Home view", group: "View", icon: "home", keys: "H", keywords: "reset camera iso", run: () => requestView("home") },
  { id: "view-fit", label: "Fit to view", group: "View", icon: "fit", keys: "Shift+H", keywords: "zoom all frame", run: () => requestView("fit") },
  ...THEMES.map((t): Command => ({
    id: `theme-${t.id}`,
    label: `${t.label} theme`,
    group: "View",
    icon: t.dark ? "moon" : "sun",
    keywords: `${t.dark ? "dark" : "light"} mode appearance color scheme`,
    on: (s) => s.prefs.theme === t.id,
    run: () => setTheme(t.id),
  })),
  { id: "theme-system", label: "Match system theme", group: "View", icon: "palette", keywords: "auto os dark light mode appearance", on: (s) => s.prefs.theme === "system", run: () => setTheme("system") },
  { id: "assistant", label: "AI assistant", short: "Assistant", group: "Help", icon: "assistant", keys: "Ctrl+I", keywords: "ai chat claude gpt openai ollama llm generate prompt describe design copilot", hint: "Describe a part or a change and let AI build it with Whittle's tools", when: (s) => s.platform.kind !== "server" || s.platform.config.ai !== false, on: (s) => s.assistant, run: () => useApp.setState({ assistant: !get().assistant }) },
  { id: "settings", label: "Settings", group: "File", icon: "settings", keys: "Ctrl+,", keywords: "preferences options theme appearance navigation mouse units profile accent density", hint: "Themes, navigation, units, workspace and more", run: () => useApp.setState({ panel: "settings" }) },
  { id: "shortcuts", label: "Keyboard shortcuts", group: "Help", icon: "keyboard", keys: "?", keywords: "keys hotkeys help", run: () => useApp.setState({ panel: "shortcuts" }) },
  { id: "coach", label: "Guided first part", group: "Help", icon: "sparkStep", keywords: "tutorial learn tour help getting started", run: () => useApp.setState({ coach: true, panel: null }) },
  { id: "welcome", label: "Start screen & templates", group: "Help", icon: "home", keywords: "examples samples templates", run: () => useApp.setState({ panel: "welcome" }) },
];

export const commandById = (id: string) => COMMANDS.find((c) => c.id === id)!;

export function isAvailable(c: Command, s = get()): boolean {
  return !c.when || c.when(s);
}

/** Map a key event to a command id, given the current mode. */
export function commandForKey(e: KeyboardEvent, s: AppState): string | null {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod) {
    if (k === "z" && e.shiftKey) return "redo";
    if (k === "z") return "undo";
    if (k === "y") return "redo";
    if (k === "s" && e.shiftKey) return "save-as";
    if (k === "s") return "save";
    if (k === "o") return "open";
    if (k === ",") return "settings";
    if (k === "i") return "assistant";
    if (k === "d" && s.mode.kind === "sketch") return "duplicate";
    return null;
  }
  if (e.altKey) return null;
  if (e.key === "Delete" || e.key === "Backspace") return "delete";
  if (e.key === "?") return "shortcuts";
  if (s.mode.kind === "sketch") {
    if (e.shiftKey && k === "r") return "rotate-shape";
    if (e.shiftKey && k === "o") return "offset-shape";
    const map: Record<string, string> = { l: "tool-line", a: "tool-path", r: "tool-rect", c: "tool-circle", e: "tool-ellipse", p: "tool-polygon", o: "tool-slot", t: "tool-text", g: "tool-gear", v: "tool-select", x: "construction" };
    return map[k] ?? null;
  }
  if (e.shiftKey && k === "h") return "view-fit";
  const map: Record<string, string> = { s: "sketch", e: "extrude", r: "revolve", f: "fillet", h: "view-home", d: "hole", m: "move", j: "combine", i: "measure", p: "parts" };
  return map[k] ?? null;
}
