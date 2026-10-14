/** Starter templates: real, editable parametric models (not static meshes). */
import {
  type ExtrudeFeature,
  type FilletFeature,
  type ShellFeature,
  type SketchFeature,
  type WhittleDocument,
  makeExtrude,
  makeFillet,
  makePrimitive,
  makeRevolve,
  makeShell,
  makeSketch,
  newDocument,
  uid,
} from "@whittle/core";

export interface Template {
  id: string;
  title: string;
  blurb: string;
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
    { id: uid(), name: "wall", expr: "2 mm", kind: "length", comment: "Wall thickness (good for FDM)" },
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

export const TEMPLATES: Template[] = [
  { id: "plate", title: "Mounting plate", blurb: "Parametric plate with M5 holes and a slot. Change one number, everything follows.", build: mountingPlate },
  { id: "box", title: "Project box", blurb: "An enclosure for electronics: box, rounded corners, 2 mm walls.", build: projectBox },
  { id: "knob", title: "Control knob", blurb: "A revolved profile with a shaft hole, built from a sketch.", build: knob },
];