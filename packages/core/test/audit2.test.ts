/** Regression tests from the October 2026 audit (second pass). */
import { describe, expect, it } from "vitest";
import { type Feature, SCHEMA_VERSION, FileFormatError, migrate, newDocument, parseDxf, renameParameter, serializeDocument, deserializeDocument } from "../src";

/** One of every feature that stores a word (an enum value) next to formulas. */
function wordyFeatures(): Feature[] {
  const f = (o: object) => o as Feature;
  return [
    f({ id: "sk1", type: "sketch", name: "S", plane: { kind: "origin", plane: "XY", offset: "0", angle: "0", tilt: "x" }, entities: [{ id: "e1", type: "polyline", points: [["0", "0"], ["1", "1", "arc"], ["2", "2"], ["3", "3", "spline"], ["4", "4"]] }, { id: "e2", type: "rect", x: "0", y: "0", w: "1", h: "1", anchor: "center", mode: "subtract" }, { id: "e3", type: "text", x: "0", y: "0", text: "inside", size: "5", angle: "0" }] }),
    f({ id: "sk2", type: "sketch", name: "S2", plane: { kind: "face", face: { bodyId: "b", center: [0, 0, 0], normal: [0, 0, 1], surface: "PLANE", area: 1 }, offset: "0" }, entities: [] }),
    f({ id: "sk3", type: "sketch", name: "S3", plane: { kind: "construction", plane: "cp1", offset: "0" }, entities: [] }),
    f({ id: "ex1", type: "extrude", name: "E", sketch: "sk1", distance: "1", extent: "symmetric", flip: false, thinSide: "inside", op: "cut", target: "b" }),
    f({ id: "rv1", type: "revolve", name: "R", sketch: "sk1", axis: "line", angle: "360", op: "join" }),
    f({ id: "pa1", type: "pattern", name: "P", pattern: "linear", axis: "z", axis2: "y", count: "2", spacing: "1", angle: "360", merge: true }),
    f({ id: "su1", type: "surface", name: "Su", op: "ruled", bodies: [], faces: [], edges: [], distance: "1", direction: "tangent", axis: "x", plane: "YZ", offset: "0", keep: "above" }),
    f({ id: "jt1", type: "joint", name: "J", joint: "revolute", origin: "center", point: ["0", "0", "0"], axis: "y", angle: "0", distance: "0", limited: false, min: "0", max: "1" }),
    f({ id: "cv1", type: "curve", name: "C", source: "project", points: [], edges: [], faces: [], smooth: false }),
    f({ id: "sc1", type: "scale", name: "Sc", factor: "1", center: "origin", copy: false }),
    f({ id: "sp1", type: "split", name: "Sp", plane: "XZ", offset: "0", keep: "both" }),
    f({ id: "dr1", type: "draft", name: "D", faces: [], angle: "1", pull: "x", neutral: "0", flip: false }),
    f({ id: "ho1", type: "hole", name: "H", face: null, points: [], style: "countersink", diameter: "1", depth: "1", through: true, headDiameter: "2", headDepth: "1" }),
    f({ id: "sw1", type: "sweep", name: "Sw", profile: "sk1", path: "sk2", orientation: "fixed", pipe: { shape: "circle", size: "1", wall: "0" }, op: "new" }),
    f({ id: "co1", type: "coil", name: "Co", section: "triangle", radius: "1", pitch: "1", height: "1", size: "1", lefthand: false, position: ["0", "0", "0"], op: "new" }),
    f({ id: "pr1", type: "primitive", name: "Pr", shape: "cone", width: "1", depth: "1", height: "1", radius: "1", position: ["0", "0", "0"], op: "new" }),
    f({ id: "cg1", type: "construct", name: "Cg", mode: "planeTangent", faces: [], edges: [], points: [], value: "0" }),
    f({ id: "im1", type: "import", name: "I", format: "stl", fileName: "x.stl", data: "", scale: "1" }),
  ];
}

describe("renaming a parameter", () => {
  const baseline = JSON.stringify(wordyFeatures());
  // Every word the features hold, plus the usual short parameter names.
  const words = new Set<string>(["x", "y", "z", "w", "h", "r", "d"]);
  const collect = (v: unknown): void => {
    if (typeof v === "string") {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) words.add(v);
    } else if (v && typeof v === "object") Object.values(v).forEach(collect);
  };
  collect(wordyFeatures());
  for (const k of ["kind", "direction", "origin", "source", "axis2", "thinSide", "joint"]) words.add(k);

  it("only changes formulas, never words such as plane, axis or direction", () => {
    const damaged: string[] = [];
    for (const name of words) {
      if (["pi", "PI", "tau", "mm", "cm", "in", "ft", "deg", "rad", "m"].includes(name)) continue;
      const doc = newDocument();
      doc.parameters.push({ id: "p", name, expr: "5", kind: "length" });
      doc.features = wordyFeatures();
      renameParameter(doc, name, "zz_renamed");
      if (JSON.stringify(doc.features) !== baseline) damaged.push(name);
    }
    expect(damaged).toEqual([]);
  });

  it("still renames real references", () => {
    const doc = newDocument();
    doc.parameters.push({ id: "p", name: "axis", expr: "5", kind: "length" }, { id: "q", name: "d2", expr: "axis * 2", kind: "length" });
    doc.features = wordyFeatures();
    (doc.features[3] as unknown as { distance: string }).distance = "axis + 1 mm";
    (doc.features[0] as unknown as { entities: { points: string[][] }[] }).entities[0]!.points[0] = ["axis", "axis / 2"];
    renameParameter(doc, "axis", "shaft");
    expect((doc.features[3] as unknown as { distance: string }).distance).toBe("shaft + 1 mm");
    expect((doc.features[0] as unknown as { entities: { points: string[][] }[] }).entities[0]!.points[0]).toEqual(["shaft", "shaft / 2"]);
    expect(doc.parameters[1]!.expr).toBe("shaft * 2");
    expect((doc.features[5] as unknown as { axis: string }).axis).toBe("z");
  });
});

describe("opening damaged files", () => {
  it("refuses a feature list that holds something other than features", () => {
    expect(() => migrate({ schema: SCHEMA_VERSION, features: [null] })).toThrow(FileFormatError);
    expect(() => migrate({ schema: SCHEMA_VERSION, features: [5] })).toThrow(FileFormatError);
    expect(() => migrate({ schema: SCHEMA_VERSION, features: [{ type: "sketch" }] })).toThrow(FileFormatError);
    expect(() => migrate({ schema: SCHEMA_VERSION, parameters: [null] })).toThrow(FileFormatError);
    expect(migrate({ schema: SCHEMA_VERSION, features: [{ id: "a", type: "extrude" }] }).features).toHaveLength(1);
  });
});
