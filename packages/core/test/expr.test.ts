import { describe, expect, it } from "vitest";
import { type Parameter, type SketchFeature, createEvaluator, makeExtrude, makeFillet, makePrimitive, reorderProblem, deserializeDocument, entitySnapPoints, History, makeSketch, newDocument, renameParameter, serializeDocument } from "../src";

const ev = (params: Parameter[] = [], unit: "mm" | "in" = "mm") => createEvaluator(params, unit);
const p = (name: string, expr: string, kind: Parameter["kind"] = "length"): Parameter => ({ id: name, name, expr, kind });

describe("expressions", () => {
  it("treats bare numbers as the field unit", () => {
    expect(ev().eval("10", "length")).toEqual({ ok: true, value: 10 });
    expect(ev([], "in").eval("2", "length")).toEqual({ ok: true, value: 50.8 });
    const a = ev().eval("90", "angle");
    expect(a.ok && a.value).toBeCloseTo(Math.PI / 2);
  });

  it("converts units and respects precedence", () => {
    expect(ev().eval("1 in + 4.6 mm", "length")).toEqual({ ok: true, value: 30 });
    expect(ev().eval("2 + 3 * 4", "length")).toEqual({ ok: true, value: 14 });
    const r = ev().eval("-2^2", "number");
    expect(r.ok && r.value).toBe(-4);
  });

  it("lets bare numbers adopt the unit of the other operand", () => {
    const e = ev([p("width", "2 cm")]);
    expect(e.eval("width + 5", "length")).toEqual({ ok: true, value: 25 });
    expect(e.eval("width / 2", "length")).toEqual({ ok: true, value: 10 });
  });

  it("rejects dimension mistakes with readable messages", () => {
    const r = ev().eval("10 mm + 5 deg", "length");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Can't add a length and an angle/);
    const area = ev().eval("10 mm * 10 mm", "length");
    expect(area.ok).toBe(false);
  });

  it("supports functions", () => {
    const r = ev([p("rise", "10"), p("run", "10")]).eval("atan(rise / run)", "angle");
    expect(r.ok && r.value).toBeCloseTo(Math.PI / 4);
    expect(ev().eval("sqrt(16 mm * 4 mm)", "length")).toEqual({ ok: true, value: 8 });
    expect(ev().eval("max(1 cm, 12)", "length")).toEqual({ ok: true, value: 12 });
  });

  it("resolves parameter chains and detects cycles", () => {
    const e = ev([p("a", "b * 2"), p("b", "c + 1"), p("c", "4")]);
    expect(e.params.get("a")).toMatchObject({ ok: true, value: 10 });
    const cyc = ev([p("x", "y"), p("y", "x")]);
    expect(cyc.params.get("x")?.ok).toBe(false);
    const r = cyc.eval("x + 1", "length");
    expect(r.ok).toBe(false);
  });

  it("keeps bare numbers bare when scaled by plain ratios", () => {
    const r = ev().eval("10 * pi", "length");
    expect(r.ok && r.value).toBeCloseTo(10 * Math.PI);
    const inch = ev([], "in").eval("2 * pi * 1", "length");
    expect(inch.ok && inch.value).toBeCloseTo(2 * Math.PI * 25.4);
    expect(ev().eval("pi * pi", "length").ok).toBe(false);
  });

  it("reports unknown names", () => {
    const r = ev().eval("wdth * 2", "length");
    expect(!r.ok && r.error).toMatch(/no parameter called "wdth"/);
  });
});

describe("history", () => {
  it("undoes and redoes", () => {
    const h = new History<{ n: number }>();
    let s = { n: 0 };
    s = h.apply(s, "inc", (d) => void (d.n += 1));
    s = h.apply(s, "inc", (d) => void (d.n += 1));
    expect(s.n).toBe(2);
    s = h.undo(s)!.state;
    expect(s.n).toBe(1);
    s = h.redo(s)!.state;
    expect(s.n).toBe(2);
  });

  it("merges rapid edits with the same key", () => {
    const h = new History<{ n: number }>();
    let s = { n: 0 };
    for (let i = 0; i < 5; i++) s = h.apply(s, "drag", (d) => void (d.n = i + 1), "k");
    s = h.undo(s)!.state;
    expect(s.n).toBe(0);
    expect(h.canUndo).toBe(false);
  });
});

describe("file format", () => {
  it("round-trips a document", () => {
    const doc = newDocument("Bracket");
    doc.parameters.push(p("width", "40"));
    const back = deserializeDocument(serializeDocument(doc));
    // Saving stamps the save time; everything else comes back exactly.
    expect(back).toEqual({ ...doc, modifiedAt: back.modifiedAt });
  });

  it("refuses files from the future", () => {
    const doc = { ...newDocument(), schema: 999 };
    expect(() => deserializeDocument(serializeDocument(doc))).toThrow(/newer version/);
  });
});

describe("parameter rename", () => {
  it("updates every reference but leaves text, ids and enums alone", () => {
    const doc = newDocument();
    doc.parameters.push(p("w", "40"), p("half", "w / 2"));
    const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "w * 0" }) as SketchFeature;
    sk.entities.push({ id: "w", type: "rect", x: "0", y: "0", w: "w", h: "w2 + 1", anchor: "center" });
    sk.entities.push({ id: "t", type: "text", x: "w", y: "0", text: "w", size: "5", angle: "0" });
    doc.features.push(sk);
    renameParameter(doc, "w", "width");
    expect(doc.parameters.map((x) => [x.name, x.expr])).toEqual([["width", "40"], ["half", "width / 2"]]);
    expect(sk.plane.offset).toBe("width * 0");
    expect(sk.entities[0]).toMatchObject({ id: "w", w: "width", h: "w2 + 1" });
    expect(sk.entities[1]).toMatchObject({ x: "width", text: "w" });
  });
});

describe("sketch snapping", () => {
  it("rotates rectangle snap points with the rectangle", () => {
    const pts = entitySnapPoints({ id: "r", type: "rect", x: -10, y: -5, w: 20, h: 10, corner: 0, angle: Math.PI / 2, construction: false, mode: "auto" });
    const corners = pts.filter((s) => s.kind === "end").map((s) => s.p.map((v) => Math.round(v)));
    expect(corners).toContainEqual([5, -10]);
    expect(corners).toContainEqual([-5, 10]);
  });
});

describe("timeline reorder", () => {
  it("allows moves that keep inputs first and explains the rest", () => {
    const doc = newDocument();
    const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" });
    doc.features.push(sk);
    const ex = makeExtrude(doc, sk.id);
    doc.features.push(ex);
    const box = makePrimitive(doc, "box");
    doc.features.push(box);
    const fi = makeFillet(doc);
    if (fi.type === "fillet") fi.edges = [{ bodyId: ex.id, mid: [0, 0, 0], tangent: [1, 0, 0], curve: "LINE", length: 1 }];
    doc.features.push(fi);
    expect(reorderProblem(doc, 2, 0)).toBeNull(); // the box doesn't depend on anything
    expect(reorderProblem(doc, 1, 0)).toMatch(/Extrude 1 uses Sketch 1/);
    expect(reorderProblem(doc, 3, 1)).toMatch(/Fillet 1 uses Extrude 1/);
    expect(reorderProblem(doc, 0, 3)).toMatch(/uses Sketch 1/);
  });
});

describe("expressions: more units and functions", () => {
  const val = (src: string, kind: "length" | "number" | "angle" = "number") => {
    const r = ev().eval(src, kind);
    return r.ok ? r.value : `ERR ${r.error}`;
  };

  it("reads inch, yard, micron and mil spellings and the foot and inch marks", () => {
    expect(val("1 inch", "length")).toBe(25.4);
    expect(val("1 yd", "length")).toBe(914.4);
    expect(val("1 um", "length")).toBeCloseTo(0.001, 12);
    expect(val("5 \u00b5m", "length")).toBeCloseTo(0.005, 12);
    expect(val("10 mil", "length")).toBeCloseTo(0.254, 12);
    expect(val("10 thou", "length")).toBeCloseTo(0.254, 12);
    expect(val("2'", "length")).toBe(609.6);
    expect(val('1"', "length")).toBe(25.4);
  });

  it("has the usual math functions", () => {
    expect(val("pow(2, 10)")).toBe(1024);
    expect(val("pow(3 mm, 2)")).toMatch(/needs a plain number/); // an area isn't a plain number
    expect(val("exp(0)")).toBe(1);
    expect(val("ln(1)")).toBe(0);
    expect(val("log(1000)")).toBeCloseTo(3, 12);
    expect(val("sign(-4 mm)")).toBe(-1);
    expect(val("trunc(-2.7)")).toBe(-2);
    expect(val("cbrt(27)")).toBe(3);
    expect(val("hypot(3 mm, 4 mm)", "length")).toBe(5);
    expect(val("mod(7, 3)")).toBe(1);
    expect(val("mod(-1, 3)")).toBe(2);
    expect(val("mod(7 mm, 3 mm)", "length")).toBe(1);
  });

  it("refuses what has no answer, with a plain message", () => {
    expect(val("ln(0)")).toMatch(/above zero/);
    expect(val("log(-1)")).toMatch(/above zero/);
    expect(val("mod(1, 0)")).toMatch(/by zero/);
    expect(val("tan(90)")).toMatch(/isn't defined/);
    expect(val("sin(30)")).toBeCloseTo(0.5, 12);
  });
});
