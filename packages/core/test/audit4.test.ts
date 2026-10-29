/** Regression tests for the fixes from docs/AUDIT.md (U-1 units of drawn shapes, C-1 control-point splines). */
import { describe, expect, it } from "vitest";
import { addCircle, addConstraint, addLine, breakLine, mergeParameterCsv, parseCsv, renameParameter, sliceMesh, trimGeometry } from "../src";
import { type LengthUnit, addEntityGeometry, documentEvaluator, makeEntity, newDocument, resolveEntity, type SketchFeature } from "../src";

const UNITS: LengthUnit[] = ["mm", "cm", "m", "in", "ft"];

describe("makeEntity writes the document unit", () => {
  for (const units of UNITS) {
    it(`a 20 x 10 mm rectangle stays 20 x 10 mm in a ${units} design`, () => {
      const ev = documentEvaluator(newDocument("t", units));
      const r = resolveEntity(makeEntity("rect", [5, 2], [25, 12], units), ev);
      expect(r.type).toBe("rect");
      if (r.type !== "rect") return;
      expect(r.x).toBeCloseTo(5, 2);
      expect(r.y).toBeCloseTo(2, 2);
      expect(r.w).toBeCloseTo(20, 2);
      expect(r.h).toBeCloseTo(10, 2);
    });
  }

  it("circles, slots and angles in an inch design", () => {
    const ev = documentEvaluator(newDocument("t", "in"));
    const c = resolveEntity(makeEntity("circle", [25.4, 0], [25.4 + 12.7, 0], "in"), ev);
    expect(c.type === "circle" && [c.cx, c.r]).toEqual([expect.closeTo(25.4, 2), expect.closeTo(12.7, 2)]);
    const raw = makeEntity("slot", [0, 0], [0, 50.8], "in");
    // The angle is in degrees whatever the length unit.
    expect(raw.type === "slot" && raw.angle).toBe("90");
    const s = resolveEntity(raw, ev);
    expect(s.type === "slot" && s.length).toBeCloseTo(50.8, 2);
  });

  it("the default is mm, as before", () => {
    const e = makeEntity("rect", [0, 0], [20, 10]);
    expect(e.type === "rect" && [e.w, e.h]).toEqual(["20", "10"]);
  });
});

describe("converting a rounded outline writes its radius in the document unit", () => {
  it("a 2.54 mm corner in an inch design gets the dimension 0.1", () => {
    const doc = newDocument("t", "in");
    const ev = documentEvaluator(doc);
    const e = makeEntity("polyline", [0, 0], [50.8, 0], "in");
    if (e.type !== "polyline") throw new Error("not a polyline");
    e.points = [["0", "0"], ["2", "0"], ["2", "1"], ["0", "1"]];
    e.corner = "0.1";
    const sk = { id: "s", type: "sketch", name: "S", plane: { kind: "origin", plane: "XY", offset: "0" }, entities: [] } as unknown as SketchFeature;
    expect(addEntityGeometry(sk, resolveEntity(e, ev), "in")).toBeUndefined();
    const radii = (sk.constraints ?? []).filter((c) => c.type === "radius").map((c) => c.value);
    expect(radii.length).toBe(4);
    for (const v of radii) expect(v).toBe("0.1");
  });
});

describe("a control-point spline isn't turned into its control polygon (audit C-1)", () => {
  it("addEntityGeometry refuses it and adds nothing", () => {
    const ev = documentEvaluator(newDocument("t"));
    const e = makeEntity("polyline", [0, 0], [10, 0]);
    if (e.type !== "polyline") throw new Error("not a polyline");
    e.points = [["0", "0"], ["10", "10"], ["20", "0"], ["30", "10"]];
    e.open = true;
    e.ctrl = true;
    const sk = { id: "s", type: "sketch", name: "S", plane: { kind: "origin", plane: "XY", offset: "0" }, entities: [] } as unknown as SketchFeature;
    expect(addEntityGeometry(sk, resolveEntity(e, ev))).toMatch(/Control-point splines/);
    expect(sk.geometry ?? []).toEqual([]);
  });
});


type Geo = Pick<SketchFeature, "geometry" | "constraints">;

describe("sketch edits keep only dimensions that still fit (audit C-2, C-3)", () => {
  it("Break Line drops the old length of the split line", () => {
    const sk: Geo = { geometry: [], constraints: [] };
    const l = addLine(sk, [0, 0], [100, 0]);
    const cut = addLine(sk, [30, -10], [30, 10]);
    addConstraint(sk, "distance", [l], "100");
    expect(breakLine(sk, l, cut)).toBeUndefined();
    expect(sk.constraints!.some((k) => k.type === "distance" && k.refs.length === 1 && k.refs[0] === l)).toBe(false);
  });
  it("trimming a circle turns its Diameter into a Radius of half the value", () => {
    const sk: Geo = { geometry: [], constraints: [] };
    const c = addCircle(sk, [0, 0], 10);
    addLine(sk, [-20, 0], [20, 0]);
    addConstraint(sk, "diameter", [c], "20");
    expect(trimGeometry(sk, c, [0, 10])).toBeUndefined();
    const k = sk.constraints!.find((x) => x.refs[0] === c && (x.type === "radius" || x.type === "diameter"))!;
    expect(k.type).toBe("radius");
    expect(k.value).toBe("(20) / 2");
  });
});

describe("parameters (audit C-4, C-5)", () => {
  it("renaming a parameter renames it inside variants too", () => {
    const doc = newDocument();
    doc.parameters.push({ id: "p1", name: "w", expr: "10", kind: "length" }, { id: "p2", name: "h", expr: "w / 2", kind: "length" });
    doc.variants = [{ id: "v", name: "Big", values: { w: "40", h: "w / 4" } }];
    renameParameter(doc, "w", "width");
    expect(doc.variants[0]!.values).toEqual({ width: "40", h: "width / 4" });
  });
  it("reads an inch mark inside an unquoted cell, and a ';' in a comma file stays in its cell", () => {
    expect(parseCsv(`h,5' 6"\nw,20`)).toEqual([["h", `5' 6"`], ["w", "20"]]);
    expect(parseCsv(`name,value,kind,x,note\nw,20,length,,wide; very`)[1]![4]).toBe("wide; very");
    expect(parseCsv(`name;value\nw;20,5`)).toEqual([["name", "value"], ["w", "20,5"]]);
    expect(parseCsv(`"a, b",2`)).toEqual([["a, b", "2"]]);
    const r = mergeParameterCsv([], `h,6"\nw,20`, () => "id");
    expect(r.added).toEqual(["h", "w"]);
  });
});

describe("sketch Intersect through mesh vertices (audit C-6)", () => {
  it("finds the segment where the plane runs along a shared mesh edge", () => {
    // A wall in the XZ plane made of two stacked quads (4 triangles), cut by the plane z = 10 at their shared edge.
    const positions = [0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10, 10, 0, 20, 0, 0, 20];
    const indices = [0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5];
    const segs = sliceMesh({ positions, indices }, [0, 0, 10], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
    expect(segs).toHaveLength(1);
    const xs = segs[0]!.map((p) => p[0]).sort((a, b) => a - b);
    expect(xs).toEqual([0, 10]);
  });
});

describe("changing a design's units (audit U-2)", () => {
  it("keeps the numbers, and scales the drawn geometry with them", async () => {
    const { relabelUnits, makeSketch } = await import("../src");
    const doc = newDocument("t", "mm");
    doc.parameters.push({ id: "p", name: "w", expr: "20", kind: "length" });
    const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
    sk.geometry = [];
    sk.constraints = [];
    const c = addCircle(sk, [10, 0], 5);
    addConstraint(sk, "diameter", [c], "10");
    sk.constraints[0]!.label = [1, 2];
    doc.features.push(sk);
    relabelUnits(doc, "in");
    expect(doc.units).toBe("in");
    expect(doc.parameters[0]!.expr).toBe("20");
    const pt = sk.geometry.find((g) => g.type === "point")!;
    expect(pt.type === "point" && pt.x).toBeCloseTo(254, 6);
    const circle = sk.geometry.find((g) => g.type === "circle")!;
    expect(circle.type === "circle" && circle.r).toBeCloseTo(127, 6);
    expect(sk.constraints[0]!.label).toEqual([1, 2 * 25.4]);
  });
});

describe("DXF reader (audit C-11)", () => {
  const dxf = (...lines: (string | number)[]) => lines.join("\n");
  it("places block references: moved, turned and scaled about the block's base point", async () => {
    const { parseDxf } = await import("../src");
    const text = dxf(
      0, "SECTION", 2, "BLOCKS",
      0, "BLOCK", 2, "PEG", 10, 5, 20, 0,
      0, "CIRCLE", 10, 5, 20, 0, 40, 1,
      0, "LINE", 10, 5, 20, 0, 11, 15, 21, 0,
      0, "ENDBLK",
      0, "ENDSEC",
      0, "SECTION", 2, "ENTITIES",
      0, "INSERT", 2, "PEG", 10, 100, 20, 50, 41, 2, 42, 2, 50, 90,
      0, "ENDSEC", 0, "EOF",
    );
    const r = parseDxf(text);
    expect(r.skipped).toEqual([]);
    expect(r.circles).toHaveLength(1);
    expect(r.circles[0]!.c[0]).toBeCloseTo(100, 9);
    expect(r.circles[0]!.c[1]).toBeCloseTo(50, 9);
    expect(r.circles[0]!.r).toBeCloseTo(2, 9);
    // The 10 long line from the base point, doubled and turned to point up.
    const pts = r.loops[0]!.pts;
    const ys = pts.map((q) => q[1]).sort((a, b) => a - b);
    expect(pts.every((q) => Math.abs(q[0] - 100) < 1e-9)).toBe(true);
    expect([ys[0], ys.at(-1)]).toEqual([50, 70]);
  });
  it("draws a rational spline from its knots and weights (a quarter circle)", async () => {
    const { nurbsSamples } = await import("../src");
    const s = nurbsSamples(2, [0, 0, 0, 1, 1, 1], [[1, 0], [1, 1], [0, 1]], [1, Math.SQRT1_2, 1])!;
    expect(s.length).toBeGreaterThan(8);
    for (const q of s) expect(Math.hypot(q[0], q[1])).toBeCloseTo(1, 9);
    expect(nurbsSamples(3, [0, 1], [[0, 0], [1, 1]])).toBeNull();
  });
});

describe("default lengths of new steps (audit W-10)", () => {
  it("are plain numbers in the design's unit, round sizes in inches", async () => {
    const { defaultLength } = await import("../src");
    expect(defaultLength("mm", 10)).toBe("10");
    expect(defaultLength("cm", 10)).toBe("1");
    expect(defaultLength("in", 10)).toBe("0.375");
    expect(defaultLength("in", 1)).toBe("0.046875");
    expect(defaultLength("ft", 304.8)).toBe("1");
  });
});
