/**
 * The parts library: ready-made parts that insert as ordinary, editable
 * features driven by their own named parameters (so "gear1_teeth = 30"
 * re-shapes the gear). Nothing here is a frozen mesh.
 */
import type { Draft } from "immer";
import {
  type ExtrudeFeature,
  type Feature,
  type FaceRef,
  type OriginPlane,
  type Parameter,
  type QuantityKind,
  type ShellFeature,
  type SketchEntity,
  type SketchFeature,
  type WhittleDocument,
  makeExtrude,
  makePrimitive,
  makeLoft,
  makeMove,
  makeRevolve,
  makeShell,
  nextBodyColor,
  makeSketch,
  uid,
} from "@whittle/core";
import { commitSession, mutate, toast, useApp } from "./store";

export interface PartDef {
  id: string;
  title: string;
  blurb: string;
  category: "Mechanical" | "Fasteners" | "Enclosures" | "Everyday";
  build: (b: PartBuilder) => void;
}

/** Collects parameters and features for one inserted part. */
export class PartBuilder {
  params: Parameter[] = [];
  features: Feature[] = [];
  bodyNames = new Map<string, string>();
  constructor(
    readonly doc: WhittleDocument,
    readonly prefix: string,
  ) {}

  /** Adds a parameter and returns its (prefixed) name for use in formulas. */
  p(name: string, expr: string, kind: QuantityKind = "length", comment?: string): string {
    const full = `${this.prefix}_${name}`;
    this.params.push({ id: uid("p"), name: full, expr, kind, comment });
    return full;
  }

  private view(): WhittleDocument {
    return { ...this.doc, features: [...this.doc.features, ...this.features] };
  }

  sketch(plane: OriginPlane, entities: NewEntity[], offset = "0"): SketchFeature {
    const s = makeSketch(this.view(), { kind: "origin", plane, offset }) as SketchFeature;
    s.entities = entities.map((e) => ({ ...e, id: uid("e") }) as SketchEntity);
    this.features.push(s);
    return s;
  }

  extrude(sketch: SketchFeature, distance: string, opts: Partial<ExtrudeFeature> = {}, bodyName?: string): ExtrudeFeature {
    const e = { ...(makeExtrude(this.view(), sketch.id) as ExtrudeFeature), distance, ...opts };
    this.features.push(e);
    if (bodyName && e.op === "new") this.bodyNames.set(e.id, bodyName);
    return e;
  }

  add(f: Feature, bodyName?: string) {
    this.features.push(f);
    if (bodyName) this.bodyNames.set(f.id, bodyName);
    return f;
  }
}

/** A sketch shape before it gets an id (distributes over the union). */
type NewEntity = SketchEntity extends infer T ? (T extends SketchEntity ? Omit<T, "id"> : never) : never;

const top = (bodyId: string, z: number, area: number): FaceRef => ({ bodyId, center: [0, 0, z], normal: [0, 0, 1], surface: "PLANE", area });

export const PARTS: PartDef[] = [
  {
    id: "gear",
    title: "Spur gear",
    blurb: "Involute teeth, any count and module",
    category: "Mechanical",
    build: (b) => {
      const teeth = b.p("teeth", "24", "count");
      const module = b.p("module", "2 mm", "length", "Gears mesh when modules match");
      const thick = b.p("thickness", "8 mm");
      const bore = b.p("bore", "5 mm");
      const s = b.sketch("XY", [{ type: "gear", cx: "0", cy: "0", teeth, module, bore }]);
      b.extrude(s, thick, {}, "Gear");
    },
  },
  {
    id: "nut",
    title: "Hex nut",
    blurb: "M3 by default; set across-flats and height",
    category: "Fasteners",
    build: (b) => {
      const af = b.p("across_flats", "5.5 mm", "length", "Wrench size");
      const h = b.p("height", "2.4 mm");
      const hole = b.p("hole", "3.2 mm", "length", "Clearance or tap drill");
      const s = b.sketch("XY", [
        { type: "polygon", cx: "0", cy: "0", r: `${af} / (2 * cos(30°))`, sides: "6", angle: "0" },
        { type: "circle", cx: "0", cy: "0", r: `${hole} / 2` },
      ]);
      b.extrude(s, h, {}, "Nut");
    },
  },
  {
    id: "washer",
    title: "Washer",
    blurb: "Flat ring: outer, inner, thickness",
    category: "Fasteners",
    build: (b) => {
      const od = b.p("outer", "10 mm");
      const id = b.p("inner", "5.3 mm");
      const t = b.p("thickness", "1 mm");
      const s = b.sketch("XY", [
        { type: "circle", cx: "0", cy: "0", r: `${od} / 2` },
        { type: "circle", cx: "0", cy: "0", r: `${id} / 2` },
      ]);
      b.extrude(s, t, {}, "Washer");
    },
  },
  {
    id: "standoff",
    title: "Hex standoff",
    blurb: "PCB spacer with a through hole",
    category: "Fasteners",
    build: (b) => {
      const af = b.p("across_flats", "5 mm");
      const len = b.p("length", "10 mm");
      const hole = b.p("hole", "2.5 mm", "length", "Tap drill for M3");
      const s = b.sketch("XY", [
        { type: "polygon", cx: "0", cy: "0", r: `${af} / (2 * cos(30°))`, sides: "6", angle: "0" },
        { type: "circle", cx: "0", cy: "0", r: `${hole} / 2` },
      ]);
      b.extrude(s, len, {}, "Standoff");
    },
  },
  {
    id: "bracket",
    title: "L bracket",
    blurb: "Angle bracket with screw holes in both legs",
    category: "Mechanical",
    build: (b) => {
      const L = b.p("length", "40 mm");
      const H = b.p("height", "30 mm");
      const W = b.p("width", "20 mm");
      const t = b.p("thickness", "4 mm");
      const hole = b.p("hole", "4.5 mm", "length", "Clearance for M4");
      const profile = b.sketch("XZ", [
        {
          type: "polyline",
          points: [
            ["0", "0"],
            [L, "0"],
            [L, t],
            [t, t],
            [t, H],
            ["0", H],
          ],
        },
      ]);
      const body = b.extrude(profile, W, { extent: "symmetric" }, "Bracket");
      const base = b.sketch("XY", [{ type: "circle", cx: `(${L} + ${t}) / 2`, cy: "0", r: `${hole} / 2` }]);
      b.extrude(base, t, { op: "cut", target: body.id });
      const leg = b.sketch("YZ", [{ type: "circle", cx: "0", cy: `(${H} + ${t}) / 2`, r: `${hole} / 2` }]);
      b.extrude(leg, t, { op: "cut", target: body.id });
    },
  },
  {
    id: "plate",
    title: "Mounting plate",
    blurb: "Rounded plate with four corner holes",
    category: "Mechanical",
    build: (b) => {
      const w = b.p("width", "60 mm");
      const d = b.p("depth", "40 mm");
      const t = b.p("thickness", "3 mm");
      const hole = b.p("hole", "3.4 mm", "length", "Clearance for M3");
      const inset = b.p("inset", "5 mm");
      const holes = ([[1, 1], [-1, 1], [1, -1], [-1, -1]] as const).map(([sx, sy]) => ({
        type: "circle" as const,
        cx: `${sx < 0 ? "-" : ""}(${w} / 2 - ${inset})`,
        cy: `${sy < 0 ? "-" : ""}(${d} / 2 - ${inset})`,
        r: `${hole} / 2`,
      }));
      const s = b.sketch("XY", [{ type: "rect", x: "0", y: "0", w, h: d, anchor: "center", corner: "4" }, ...holes]);
      b.extrude(s, t, {}, "Plate");
    },
  },
  {
    id: "enclosure",
    title: "Open box",
    blurb: "Hollow enclosure with an open top",
    category: "Enclosures",
    build: (b) => {
      const L = b.p("length", "70 mm");
      const W = b.p("width", "50 mm");
      const H = b.p("height", "30 mm");
      const wall = b.p("wall", "2 mm", "length", "1.2 to 2 mm prints well");
      const box = makePrimitive(b.doc, "box");
      if (box.type !== "primitive") return;
      box.name = "Box";
      box.width = L;
      box.depth = W;
      box.height = H;
      b.add(box, "Enclosure");
      const sh = makeShell(b.doc) as ShellFeature;
      sh.bodyId = box.id;
      sh.thickness = wall;
      sh.faces = [top(box.id, 30, 70 * 50)];
      b.add(sh);
    },
  },
  {
    id: "lid",
    title: "Box lid",
    blurb: "Lid with a lip that fits the open box",
    category: "Enclosures",
    build: (b) => {
      const L = b.p("length", "70 mm");
      const W = b.p("width", "50 mm");
      const wall = b.p("wall", "2 mm");
      const gap = b.p("fit_gap", "0.2 mm", "length", "Clearance so the lid slides in");
      const plate = b.sketch("XY", [{ type: "rect", x: "0", y: "0", w: L, h: W, anchor: "center", corner: "1" }]);
      const lid = b.extrude(plate, wall, {}, "Lid");
      const lipOuter = `${L} - 2 * ${wall} - 2 * ${gap}`;
      const lipInnerW = `${W} - 2 * ${wall} - 2 * ${gap}`;
      const lip = b.sketch(
        "XY",
        [
          { type: "rect", x: "0", y: "0", w: lipOuter, h: lipInnerW, anchor: "center" },
          { type: "rect", x: "0", y: "0", w: `${lipOuter} - 2 * ${wall}`, h: `${lipInnerW} - 2 * ${wall}`, anchor: "center" },
        ],
        `-${wall}`,
      );
      b.extrude(lip, wall, { op: "join", target: lid.id });
    },
  },
  {
    id: "knob",
    title: "Round knob",
    blurb: "Grippy knob with a D-shaft hole",
    category: "Everyday",
    build: (b) => {
      const dia = b.p("diameter", "30 mm");
      const h = b.p("height", "16 mm");
      const ridges = b.p("ridges", "18", "count");
      const shaft = b.p("shaft", "6.2 mm", "length", "6 mm shaft plus clearance");
      const s = b.sketch("XY", [{ type: "gear", cx: "0", cy: "0", teeth: ridges, module: `${dia} / ${ridges}`, bore: "0" }]);
      const body = b.extrude(s, h, {}, "Knob");
      const hole = b.sketch("XY", [
        { type: "circle", cx: "0", cy: "0", r: `${shaft} / 2` },
      ]);
      b.extrude(hole, `${h} * 0.7`, { op: "cut", target: body.id });
    },
  },
  {
    id: "nametag",
    title: "Name tag",
    blurb: "Plate with raised text and a key-ring hole",
    category: "Everyday",
    build: (b) => {
      const w = b.p("width", "70 mm");
      const h = b.p("height", "24 mm");
      const t = b.p("thickness", "3 mm");
      const plate = b.sketch("XY", [
        { type: "rect", x: "0", y: "0", w, h, anchor: "center", corner: "5" },
        { type: "circle", cx: `-${w} / 2 + 6 mm`, cy: "0", r: "2.5 mm" },
      ]);
      const body = b.extrude(plate, t, {}, "Name tag");
      const text = b.sketch("XY", [{ type: "text", x: `-${w} / 2 + 12 mm`, y: `-${h} / 4`, text: "Whittle", size: `${h} * 0.5`, bold: true, angle: "0" }], t);
      b.extrude(text, "1.2 mm", { op: "join", target: body.id });
    },
  },
  {
    id: "vase",
    title: "Vase",
    blurb: "Lofted through four circles, then hollowed",
    category: "Everyday",
    build: (b) => {
      const h = b.p("height", "90 mm");
      const r = b.p("radius", "24 mm");
      const wall = b.p("wall", "1.6 mm");
      const rings: [string, string][] = [
        ["0", r],
        [`${h} * 0.35`, `${r} * 1.3`],
        [`${h} * 0.78`, `${r} * 0.62`],
        [h, `${r} * 0.8`],
      ];
      const ids = rings.map(([z, rad]) => b.sketch("XY", [{ type: "circle", cx: "0", cy: "0", r: rad }], z).id);
      const lo = makeLoft(b.doc, ids);
      b.add(lo, "Vase");
      const sh = makeShell(b.doc) as ShellFeature;
      sh.bodyId = lo.id;
      sh.thickness = wall;
      sh.faces = [top(lo.id, 90, 1300)];
      b.add(sh);
    },
  },
  {
    id: "pulley",
    title: "Pulley",
    blurb: "Grooved wheel for belts and cords",
    category: "Mechanical",
    build: (b) => {
      const r = b.p("radius", "20 mm");
      const w = b.p("width", "10 mm");
      const groove = b.p("groove", "3 mm", "length", "Groove depth");
      const bore = b.p("bore", "5 mm");
      const s = b.sketch("XZ", [
        {
          type: "polyline",
          points: [
            [`${bore} / 2`, "0"],
            [r, "0"],
            [`${r} - ${groove}`, `${w} / 2`],
            [r, w],
            [`${bore} / 2`, w],
          ],
        },
      ]);
      const rv = makeRevolve(b.doc, s.id);
      if (rv.type === "revolve") rv.axis = "y";
      b.add(rv, "Pulley");
    },
  },
];

/** X extent of each part at its default sizes (used to place it beside what's there). */
const EXTENT: Record<string, [number, number]> = {
  gear: [-26, 26],
  nut: [-3.2, 3.2],
  washer: [-5, 5],
  standoff: [-2.9, 2.9],
  bracket: [0, 40],
  plate: [-30, 30],
  enclosure: [-35, 35],
  lid: [-35, 35],
  knob: [-16, 16],
  nametag: [-35, 35],
  vase: [-32, 32],
  pulley: [-20, 20],
};

/** Insert a library part into the current design as one undo step. */
export function insertPart(def: PartDef) {
  commitSession();
  const doc = useApp.getState().doc;
  const used = new Set(doc.parameters.map((p) => p.name));
  let n = 1;
  while ([...used].some((u) => u.startsWith(`${def.id}${n}_`))) n++;
  const b = new PartBuilder(doc, `${def.id}${n}`);
  def.build(b);
  // Beside the existing bodies, not inside them: an ordinary Move step you can edit or delete.
  const existing = (useApp.getState().regen?.bodies ?? []).filter((x) => doc.bodies[x.id]?.visible !== false);
  if (existing.length) {
    const maxX = Math.max(...existing.map((x) => x.bbox[1][0]));
    const dx = Math.ceil(maxX + 12 - (EXTENT[def.id]?.[0] ?? -25));
    for (const [id, name] of b.bodyNames) {
      const mv = makeMove({ ...b.doc, features: [...b.doc.features, ...b.features] }, id);
      if (mv.type !== "move") continue;
      mv.name = `Place ${name}`;
      mv.translate = [String(dx), "0", "0"];
      b.add(mv);
    }
  }
  mutate(`Insert ${def.title}`, (d) => {
    d.parameters.push(...(b.params as Draft<Parameter>[]));
    const at = d.rollback === null ? d.features.length : d.rollback;
    d.features.splice(at, 0, ...(b.features as Draft<Feature>[]));
    if (d.rollback !== null) d.rollback += b.features.length;
    for (const [id, name] of b.bodyNames) {
      d.bodies[id] = { name: n > 1 ? `${name} ${n}` : name, color: nextBodyColor(d as WhittleDocument), visible: true };
    }
  });
  useApp.setState({ panel: null, selection: [], fitOnRegen: true });
  toast("ok", `${def.title} added. Its sizes are in Parameters (${b.prefix}_…).`, { label: "Edit sizes", run: () => useApp.setState({ panel: "params" }) });
}
