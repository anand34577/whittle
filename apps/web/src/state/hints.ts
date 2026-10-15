/** "Always show the next step": the hint line is derived from state, never hand-placed. */
import { CONSTRUCT_MODES, CURVE_SOURCES } from "@whittle/core";
import { type AppState, findFeature } from "./store";

const TOOL_HINTS: Record<string, [string, string]> = {
  rect: ["Click the first corner (or drag a rectangle)", "Click the opposite corner \u00b7 type a width, Tab for height, Enter to place"],
  crect: ["Click the center", "Click a corner · type a width, Tab for height, Enter to place"],
  rect3: ["Click the first corner", "Click the next corner (sets the angle), then move out and click for the width · type a length, Tab for angle"],
  circle2: ["Click one side of the circle", "Click the opposite side · or type a diameter and press Enter"],
  circle3: ["Click the first point on the circle", "Click a second point, then a third"],
  circle: ["Click the center", "Click to set the size \u00b7 or type a diameter and press Enter"],
  polygon: ["Click the center", "Click a corner \u00b7 or type the radius"],
  slot: ["Click the center of the first end", "Click the second end \u00b7 or type a length"],
  ellipse: ["Click the center", "Click a corner of its bounding box · or type the X radius, Tab for Y"],
  gear: ["Click the center of the gear", "Drag out its size · or type the pitch diameter · set teeth and module on the right"],
  text: ["Click where the text should start", "Type the text on the right"],
  polyline: ["Click the first point", "Click the next point \u00b7 click the first point to close \u00b7 A turns arcs on/off (click the end, then a point on the arc) \u00b7 Backspace undoes a point"],
  segment: ["Click the first point (snap to points to join them)", "Click the next point · click the first point to close · click the last point again or Enter to stop · level lines get Horizontal/Vertical"],
  tarc: ["Click the end of a line or arc", "Click where the arc ends: it leaves the line smoothly (tangent)"],
  conic: ["Click where the curve starts", "Click where it ends, then the apex where the tangents meet · type ρ (0.01–0.99; 0.5 = parabola)"],
  carc: ["Click the center", "Click where the arc starts, then where it ends (counter-clockwise)"],
  polygonC: ["Click the center", "Click the middle of an edge · sides are set in the panel"],
  polygonE: ["Click one end of an edge", "Click the other end · the polygon grows to the left"],
  arc: ["Click where the arc starts", "Click where it ends, then a point the arc passes through"],
  pcircle: ["Click the center", "Click to set the radius · or type a diameter and press Enter"],
  project: ["Click an edge or face of the model to copy it into the sketch as locked geometry", ""],
  dimension: ["Click a line (length), a circle or arc (radius) · or a point to start a pair", "Click a second point, a line or a second line for a distance or an angle · Shift+click a line to pair it"],
  spline: ["Click the first point of the spline", "Click the next point \u00b7 click the first point to close \u00b7 click the last point again, Enter or Esc to finish \u00b7 Backspace undoes a point"],
  sfillet: ["Click a corner where two lines meet", ""],
  schamfer: ["Click a corner where two lines meet", ""],
  gpoint: ["Click to place a point", ""],
  trim: ["Click the piece of a line, arc or circle to cut away (between crossings)", ""],
  extend: ["Click near the end of a line or arc to stretch it to the next curve", ""],
  cspline: ["Click the first control point", "Click more control points: they steer the curve but it doesn't pass through them · click the last point again, Enter or Esc to finish"],
  earc: ["Click the center", "Click the end of the major axis, then a point for the minor radius, then where the arc starts and ends (counter-clockwise)"],
  tan2c: ["Click the first line or circle to touch", "Click the second one, then a spot for the circle's center (its size is set by a radius you can edit)"],
  tan3c: ["Click the first line or circle to touch", "Click the next two, then a spot inside where the circle should sit"],
  path: ["Click where the path starts", "Click the next point \u00b7 Enter (or click the last point again) finishes \u00b7 A turns arcs on/off \u00b7 Backspace undoes a point"],
};

export function hintFor(s: AppState): string {
  const { mode, session, doc, selection, regen } = s;
  if (!s.kernelReady) return s.kernelError ? "The geometry engine couldn't start: " + s.kernelError : "Starting the geometry engine\u2026";
  if (mode.kind === "pickPlane") return "Click an origin plane or a flat face to sketch on · Esc to cancel";
  if (mode.kind === "measure") {
    return s.measure.length === 0
      ? "Measure: click a face, edge or body · Shift isn't needed for the second pick · Esc to stop"
      : s.measure.length === 1
        ? "Click a second item to measure the distance and angle between them"
        : "Click again to start a new measurement · Esc to stop";
  }
  if (mode.kind === "sketch") {
    if (mode.tool === "select") {
      if (s.sketchSel.length) return "Pick a constraint on the right · Shift+click adds to the selection · drag to move · Del removes";
      return s.selectedEntity
        ? "Edit sizes on the right \u00b7 drag to move \u00b7 X makes it construction \u00b7 Del removes it"
        : "Click a shape to select it \u00b7 pick a drawing tool above \u00b7 Esc to finish the sketch";
    }
    const pair = TOOL_HINTS[mode.tool];
    const step = s.sketchStep;
    return pair ? pair[step > 0 ? 1 : 0] + " \u00b7 Alt turns off snapping" : "";
  }
  if (session) {
    const f = findFeature(doc, session.featureId);
    const status = regen?.status.find((x) => x.id === session.featureId);
    if (status?.state === "error" && status.message) return status.message;
    switch (f?.type) {
      case "fillet":
      case "chamfer":
        return f.edges.length === 0
          ? "Click the edges to round or bevel \u00b7 click a face to take all of its edges \u00b7 click again to deselect"
          : `${f.edges.length} edge${f.edges.length > 1 ? "s" : ""} selected \u00b7 adjust the size \u00b7 Enter to finish`;
      case "shell":
        return f.faces.length === 0 ? "Click the face(s) to remove: that side stays open" : "Set the wall thickness \u00b7 Enter to finish";
      case "extrude":
        return "Set the distance (drag the label to scrub) \u00b7 choose New body, Join or Cut \u00b7 Enter to finish";
      case "revolve":
        return "Choose the axis and angle · Enter to finish";
      case "hole":
        return !f.face ? "Click a flat face where the holes go" : "Click on the face to add holes · fine-tune positions on the right · Enter to finish";
      case "loft":
        return f.sketches.length < 2 ? "Click the sketches to blend between, in order" : "Click more sketches to add them · Enter to finish";
      case "combine":
        return !f.target ? "Click the body to keep" : "Click the tool bodies · choose Join, Cut or Keep overlap · Enter to finish";
      case "move":
        return "Click a body to move it · type distances or drag the labels to scrub · Enter to finish";
      case "sweep":
        if (f.pipe) return !f.path ? "Click the path sketch (an open line or outline)" : "Set the size and wall · wall 0 makes a solid rod · Enter to finish";
        return !f.profile ? "Click the cross-section sketch (a closed shape)" : !f.path ? "Now click the path sketch (an open line or outline)" : "Adjust the orientation if the profile twists · Enter to finish";
      case "coil":
        return "Set radius, pitch and height · Join a thread to a rod, Cut it from a hole · Enter to finish";
      case "split":
        return "Choose the plane and offset · keep both halves or one side · Enter to finish";
      case "offset":
        return "Positive grows the body, negative shrinks it (clearances for fits and printing) · Enter to finish";
      case "scale":
        return "Type a factor (2 = twice the size) · Enter to finish";
      case "joint":
        return !f.bodyId ? "Click the body that moves" : !f.fixedId ? "Click the body it is attached to · choose the joint type · change Angle or Distance to drive it" : "Change Angle or Distance to drive the joint · Enter to finish";
      case "curve":
        return CURVE_SOURCES[f.source].hint + " · Enter to finish";
      case "rib":
        return !f.sketch ? "Click the sketch with the rib line" : "Set thickness and depth · flip to change the side · Enter to finish";
      case "thread":
        return !f.face ? "Click the round face to thread" : "Set the pitch · leave length and depth on automatic for a standard thread · Enter to finish";
      case "replaceFace":
        return f.faces.length === 0 ? "Click the flat faces to replace" : !f.target && !f.plane ? "Now click the face to meet (or choose a plane)" : "Enter to finish";
      case "deleteFace":
        return f.faces.length === 0 ? "Click every wall of the hole, pocket or boss to delete" : "Enter to heal the gap";
      case "align":
        return !f.from ? "Click a flat face on the body to move" : !f.to ? "Now click the flat face of the other body" : "Flip it or leave a gap · Enter to finish";
      case "boundaryFill":
        return f.tools.length < 2 ? "Click two or more overlapping bodies" : "Tick the cells to keep as a body · Enter to finish";
      case "construct":
        return CONSTRUCT_MODES[f.mode].hint + " · Enter to finish";
      case "cplane":
        return "Set the offset and tilt · then pick this plane when starting a sketch · Enter to finish";
      case "offsetFace":
        return f.faces.length === 0 ? "Click the flat faces to push or pull" : "Type a distance: positive pulls out, negative pushes in · Enter to finish";
      case "draft":
        return f.faces.length === 0 ? "Click the side faces to tilt (walls along the pull direction)" : "Set the angle and pull direction · Enter to finish";
      default:
        return "Adjust the values \u00b7 Enter to finish \u00b7 Esc to cancel";
    }
  }
  const p = selection[0];
  if (p?.kind === "face") return "Face selected \u00b7 S sketches on it \u00b7 Shell (Modify) hollows the body from here";
  if (p?.kind === "edge") return `${selection.length} edge${selection.length > 1 ? "s" : ""} selected \u00b7 F to fillet \u00b7 Shift-click to add more`;
  if (p?.kind === "sketch") return "Sketch selected \u00b7 E to extrude \u00b7 R to revolve \u00b7 double-click to edit";
  if (p?.kind === "body") return "Body selected · M moves it · right-click for more · Del removes the feature that made it";
  if ((regen?.bodies.length ?? 0) === 0) {
    return doc.features.some((f) => f.type === "sketch")
      ? "Press E to extrude your sketch into a solid"
      : "Start with Sketch (S): pick a plane, draw a shape, then Extrude (E). Or add a quick Box.";
  }
  return "Click to select · drag to orbit · right-drag to pan · right-click for quick actions · Ctrl+K finds any command";
}