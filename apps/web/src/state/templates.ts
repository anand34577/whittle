/** Starter templates: real, editable parametric models (not static meshes). */
import {
  type CoilFeature,
  type ExtrudeFeature,
  type FilletFeature,
  type HoleFeature,
  type ShellFeature,
  type SketchFeature,
  type SweepFeature,
  type WhittleDocument,
  makeCoil,
  makeExtrude,
  makeFillet,
  makeHole,
  makePrimitive,
  makeRevolve,
  makeShell,
  makeSketch,
  makeSweep,
  newDocument,
  uid,
} from "@whittle/core";

export interface Template {
  id: string;
  title: string;
  blurb: string;
  /** Who it speaks to (shown as a tag). */
  tag: string;
  build: () => WhittleDocument;
}

function body(doc: WhittleDocument, id: string, name: string, color: string) {
  doc.bodies[id] = { name, color, visible: true };
}

function mountingPlate(): WhittleDocument {
  const doc = newDocument("Mounting plate");
  doc.parameters.push(
    { id: uid(), name: "width", expr: "80 mm", kind: "length", comment: "Plate width" },
    { id: uid(), name: "depth", expr: "50 mm", kind: "length" },
    { id: uid(), name: "thickness", expr: "4 mm", kind: "length" },
    { id: uid(), name: "hole", expr: "5.5 mm", kind: "length", comment: "Clearance for M5" },
    { id: uid(), name: "inset", expr: "8 mm", kind: "length", comment: "Hole distance from the edges" },
  );
  const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
  sk.entities.push({ id: uid(), type: "rect", x: "0", y: "0", w: "width", h: "depth", anchor: "center", corner: "6" });
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
    sk.entities.push({
      id: uid(),
      type: "circle",
      cx: `${sx < 0 ? "-" : ""}(width / 2 - inset)`,
      cy: `${sy < 0 ? "-" : ""}(depth / 2 - inset)`,
      r: "hole / 2",
    });
  }
  sk.entities.push({ id: uid(), type: "slot", cx: "0", cy: "0", length: "width / 3", width: "8", angle: "0" });
  doc.features.push(sk);
  const ex = makeExtrude(doc, sk.id) as ExtrudeFeature;
  ex.distance = "thickness";
  doc.features.push(ex);
  body(doc, ex.id, "Plate", "#8ea4b3");
  return doc;
}

function projectBox(): WhittleDocument {
  const doc = newDocument("Project box");
  doc.parameters.push(
    { id: uid(), name: "length", expr: "90 mm", kind: "length" },
    { id: uid(), name: "width", expr: "60 mm", kind: "length" },
    { id: uid(), name: "height", expr: "32 mm", kind: "length" },
    { id: uid(), name: "wall", expr: "2 mm", kind: "length", comment: "Wall thickness (2 mm suits printing and moulding)" },
  );
  const box = makePrimitive(doc, "box");
  if (box.type === "primitive") {
    box.name = "Enclosure";
    box.width = "length";
    box.depth = "width";
    box.height = "height";
  }
  doc.features.push(box);
  body(doc, box.id, "Enclosure", "#cfc8bb");
  const fillet = makeFillet(doc) as FilletFeature;
  fillet.radius = "6";
  const L = 90;
  const W = 60;
  const H = 32;
  fillet.edges = [
    [L / 2, W / 2],
    [-L / 2, W / 2],
    [L / 2, -W / 2],
    [-L / 2, -W / 2],
  ].map(([x, y]) => ({ bodyId: box.id, mid: [x!, y!, H / 2], tangent: [0, 0, 1], curve: "LINE", length: H }));
  doc.features.push(fillet);
  const shell = makeShell(doc) as ShellFeature;
  shell.thickness = "wall";
  shell.bodyId = box.id;
  shell.faces = [{ bodyId: box.id, center: [0, 0, H], normal: [0, 0, 1], surface: "PLANE", area: L * W }];
  doc.features.push(shell);
  return doc;
}

function knob(): WhittleDocument {
  const doc = newDocument("Control knob");
  doc.parameters.push({ id: uid(), name: "dia", expr: "30 mm", kind: "length" }, { id: uid(), name: "tall", expr: "18 mm", kind: "length" });
  const sk = makeSketch(doc, { kind: "origin", plane: "XZ", offset: "0" }) as SketchFeature;
  sk.entities.push({
    id: uid(),
    type: "polyline",
    points: [
      ["0", "0"],
      ["dia / 2", "0"],
      ["dia / 2", "tall * 0.55"],
      ["dia / 2 - 3", "tall"],
      ["0", "tall"],
    ],
  });
  doc.features.push(sk);
  const rv = makeRevolve(doc, sk.id);
  doc.features.push(rv);
  body(doc, rv.id, "Knob", "#b98d5f");
  const hole = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
  hole.entities.push({ id: uid(), type: "circle", cx: "0", cy: "0", r: "3" });
  doc.features.push(hole);
  const cut = makeExtrude(doc, hole.id, "cut") as ExtrudeFeature;
  cut.distance = "12";
  doc.features.push(cut);
  return doc;
}

/** An M8 hex bolt: hexagon head, shank and a real 60 degree thread. */
function hexBolt(): WhittleDocument {
  const doc = newDocument("Hex bolt M8");
  doc.parameters.push(
    { id: uid(), name: "d", expr: "8 mm", kind: "length", comment: "Nominal diameter" },
    { id: uid(), name: "pitch", expr: "1.25 mm", kind: "length", comment: "Coarse pitch for M8" },
    { id: uid(), name: "len", expr: "30 mm", kind: "length", comment: "Length under the head" },
    { id: uid(), name: "head_af", expr: "13 mm", kind: "length", comment: "Across flats (spanner size)" },
    { id: uid(), name: "head_h", expr: "5.3 mm", kind: "length" },
  );
  const head = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
  head.name = "Head";
  head.entities.push({ id: uid(), type: "polygon", cx: "0", cy: "0", r: "head_af / 2 / cos(30 deg)", sides: "6", angle: "0" });
  doc.features.push(head);
  const hx = makeExtrude(doc, head.id) as ExtrudeFeature;
  hx.name = "Head";
  hx.distance = "head_h";
  doc.features.push(hx);
  body(doc, hx.id, "Bolt", "#8ea4b3");
  const shank = makePrimitive(doc, "cylinder", "join");
  if (shank.type === "primitive") {
    shank.name = "Shank";
    shank.radius = "d / 2 - 0.6134 * pitch";
    shank.height = "len";
    shank.position = ["0", "0", "-len"];
    shank.target = hx.id;
  }
  doc.features.push(shank);
  const thread = makeCoil(doc, "thread") as CoilFeature;
  thread.name = "Thread";
  thread.radius = "d / 2 - 0.6134 * pitch";
  thread.pitch = "pitch";
  thread.size = "0.6134 * pitch";
  thread.height = "len - 2 * pitch";
  thread.position = ["0", "0", "-len + pitch"];
  thread.op = "join";
  thread.target = hx.id;
  doc.features.push(thread);
  return doc;
}

/** A vase whose polygon profile twists as it rises; the inside is hollowed out. */
function twistedVase(): WhittleDocument {
  const doc = newDocument("Twisted vase");
  doc.parameters.push(
    { id: uid(), name: "radius", expr: "35 mm", kind: "length" },
    { id: uid(), name: "height", expr: "120 mm", kind: "length" },
    { id: uid(), name: "sides", expr: "7", kind: "count" },
    { id: uid(), name: "twist", expr: "90 deg", kind: "angle", comment: "Turn from bottom to top" },
    { id: uid(), name: "wall", expr: "2.5 mm", kind: "length" },
  );
  const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
  sk.entities.push({ id: uid(), type: "polygon", cx: "0", cy: "0", r: "radius", sides: "sides", angle: "0" });
  doc.features.push(sk);
  const ex = makeExtrude(doc, sk.id) as ExtrudeFeature;
  ex.name = "Twisted body";
  ex.distance = "height";
  ex.twist = "twist";
  doc.features.push(ex);
  body(doc, ex.id, "Vase", "#7a87a3");
  const shell = makeShell(doc) as ShellFeature;
  shell.thickness = "wall";
  shell.bodyId = ex.id;
  const r = 35;
  const area = (7 / 2) * r * r * Math.sin((2 * Math.PI) / 7);
  shell.faces = [{ bodyId: ex.id, center: [0, 0, 120], normal: [0, 0, 1], surface: "PLANE", area }];
  doc.features.push(shell);
  return doc;
}

/** A revolved bottle with a rounded shoulder and a neck. */
function bottle(): WhittleDocument {
  const doc = newDocument("Bottle");
  doc.parameters.push(
    { id: uid(), name: "r", expr: "32 mm", kind: "length", comment: "Body radius" },
    { id: uid(), name: "h", expr: "150 mm", kind: "length", comment: "Height to the shoulder" },
    { id: uid(), name: "neck", expr: "12 mm", kind: "length", comment: "Neck radius" },
    { id: uid(), name: "wall", expr: "1.8 mm", kind: "length" },
  );
  const sk = makeSketch(doc, { kind: "origin", plane: "XZ", offset: "0" }) as SketchFeature;
  sk.name = "Profile";
  sk.entities.push({
    id: uid(),
    type: "polyline",
    points: [
      ["0", "0"],
      ["r - 4", "0"],
      ["r", "4"],
      ["r", "h"],
      ["neck + 6", "h + 28"],
      ["neck", "h + 34"],
      ["neck", "h + 52"],
      ["0", "h + 52"],
    ],
  });
  doc.features.push(sk);
  const rv = makeRevolve(doc, sk.id);
  rv.name = "Bottle";
  doc.features.push(rv);
  body(doc, rv.id, "Bottle", "#8aa186");
  doc.bodies[rv.id]!.look = "glass";
  const shell = makeShell(doc) as ShellFeature;
  shell.thickness = "wall";
  shell.bodyId = rv.id;
  shell.faces = [{ bodyId: rv.id, center: [0, 0, 202], normal: [0, 0, 1], surface: "PLANE", area: Math.PI * 12 * 12 }];
  doc.features.push(shell);
  return doc;
}

/** A shelf bracket: an L profile with a brace, extruded, with countersunk screw holes. */
function shelfBracket(): WhittleDocument {
  const doc = newDocument("Shelf bracket");
  doc.parameters.push(
    { id: uid(), name: "arm", expr: "150 mm", kind: "length", comment: "Shelf depth" },
    { id: uid(), name: "drop", expr: "120 mm", kind: "length", comment: "Wall leg" },
    { id: uid(), name: "t", expr: "8 mm", kind: "length", comment: "Thickness" },
    { id: uid(), name: "w", expr: "30 mm", kind: "length", comment: "Width" },
  );
  const sk = makeSketch(doc, { kind: "origin", plane: "XZ", offset: "0" }) as SketchFeature;
  sk.name = "Side profile";
  sk.entities.push({
    id: uid(),
    type: "polyline",
    points: [
      ["0", "0"],
      ["t", "0"],
      ["t", "drop - t - 40"],
      ["arm - 40", "drop - t"],
      ["arm", "drop - t"],
      ["arm", "drop"],
      ["0", "drop"],
    ],
  });
  doc.features.push(sk);
  const ex = makeExtrude(doc, sk.id) as ExtrudeFeature;
  ex.name = "Bracket";
  ex.distance = "w";
  ex.extent = "symmetric";
  doc.features.push(ex);
  body(doc, ex.id, "Bracket", "#b98d5f");
  doc.bodies[ex.id]!.look = "satin";
  const holes = makeHole(doc) as HoleFeature;
  holes.name = "Wall screws";
  holes.style = "countersink";
  holes.diameter = "4.5 mm";
  holes.headDiameter = "9.4 mm";
  holes.face = { bodyId: ex.id, center: [0, 0, 60], normal: [-1, 0, 0], surface: "PLANE", area: 30 * 120 };
  holes.points = [
    ["0", "25"],
    ["0", "75"],
  ];
  doc.features.push(holes);
  return doc;
}

/** A handle swept along a smooth path, with flat feet for screws. */
function sweptHandle(): WhittleDocument {
  const doc = newDocument("Drawer handle");
  doc.parameters.push({ id: uid(), name: "span", expr: "96 mm", kind: "length", comment: "Screw spacing" }, { id: uid(), name: "dia", expr: "10 mm", kind: "length" });
  const path = makeSketch(doc, { kind: "origin", plane: "XZ", offset: "0" }) as SketchFeature;
  path.name = "Path";
  path.entities.push({
    id: uid(),
    type: "polyline",
    open: true,
    smooth: true,
    points: [
      ["-span / 2", "0"],
      ["-span / 2", "18"],
      ["-span / 4", "30"],
      ["span / 4", "30"],
      ["span / 2", "18"],
      ["span / 2", "0"],
    ],
  });
  doc.features.push(path);
  const prof = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
  prof.name = "Cross-section";
  prof.entities.push({ id: uid(), type: "circle", cx: "-span / 2", cy: "0", r: "dia / 2" });
  doc.features.push(prof);
  const sw = makeSweep(doc, prof.id, path.id) as SweepFeature;
  sw.name = "Handle";
  doc.features.push(sw);
  body(doc, sw.id, "Handle", "#c2a96a");
  doc.bodies[sw.id]!.look = "metal";
  return doc;
}

export const TEMPLATES: Template[] = [
  { id: "plate", title: "Mounting plate", tag: "Making", blurb: "Parametric plate with M5 holes and a slot. Change one number, everything follows.", build: mountingPlate },
  { id: "box", title: "Project box", tag: "Electronics", blurb: "An enclosure for electronics: box, rounded corners, 2 mm walls.", build: projectBox },
  { id: "bolt", title: "Hex bolt M8", tag: "Engineering", blurb: "Hexagon head and a real 60° thread. Change the size, pitch and length.", build: hexBolt },
  { id: "vase", title: "Twisted vase", tag: "Design", blurb: "A polygon twisted as it rises, then hollowed. Try 5 sides or 180°.", build: twistedVase },
  { id: "bottle", title: "Bottle", tag: "Product", blurb: "A revolved profile with shoulder and neck, shelled to a thin wall.", build: bottle },
  { id: "bracket", title: "Shelf bracket", tag: "Woodworking", blurb: "A braced L-bracket with countersunk screw holes.", build: shelfBracket },
  { id: "handle", title: "Drawer handle", tag: "Furniture", blurb: "A round profile swept along a smooth path.", build: sweptHandle },
  { id: "knob", title: "Control knob", tag: "Making", blurb: "A revolved profile with a shaft hole, built from a sketch.", build: knob },
];