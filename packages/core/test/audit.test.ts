/** Regression tests from the October 2026 audit. */
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { type Parameter, FileFormatError, createEvaluator, deserializeDocument, migrate } from "../src";

const ev = (params: Parameter[] = [], unit: "mm" | "in" = "mm") => createEvaluator(params, unit);
const p = (name: string, expr: string, kind: Parameter["kind"] = "length"): Parameter => ({ id: name, name, expr, kind });
const value = (r: ReturnType<ReturnType<typeof ev>["eval"]>) => (r.ok ? r.value : NaN);

describe("expressions: angles and rounding", () => {
  it("treats pi-based values as radians in angle contexts", () => {
    expect(value(ev().eval("sin(pi / 2)", "number"))).toBeCloseTo(1);
    expect(value(ev().eval("tan(pi / 4)", "number"))).toBeCloseTo(1);
    expect(value(ev().eval("pi / 2", "angle"))).toBeCloseTo(Math.PI / 2);
    expect(value(ev().eval("45 * pi / 180", "angle"))).toBeCloseTo(Math.PI / 4);
  });

  it("keeps plain numbers as degrees and pi scaling of lengths as lengths", () => {
    expect(value(ev().eval("90", "angle"))).toBeCloseTo(Math.PI / 2);
    expect(value(ev().eval("sin(30)", "number"))).toBeCloseTo(0.5);
    expect(value(ev().eval("10 * pi", "length"))).toBeCloseTo(10 * Math.PI);
  });

  it("rounds in the units people read", () => {
    expect(value(ev([], "in").eval("round(1.4 in)", "length"))).toBeCloseTo(25.4);
    expect(value(ev().eval("round(2.6 mm)", "length"))).toBe(3);
    expect(value(ev([], "in").eval("ceil(1.2 in)", "length"))).toBeCloseTo(50.8);
    expect(value(ev().eval("round(2.6)", "number"))).toBe(3);
  });

  it("is not confused by names that exist on Object.prototype", () => {
    const e = ev([p("constructor", "5 mm"), p("toString", "2 mm")]);
    expect(value(e.eval("constructor + toString", "length"))).toBe(7);
    expect(ev().eval("5 toString", "length").ok).toBe(false);
  });
});

describe("loading files", () => {
  it("reports a damaged document.json as a file-format problem", () => {
    const zip = zipSync({ "document.json": strToU8("{not json") });
    expect(() => deserializeDocument(zip)).toThrow(FileFormatError);
    expect(() => deserializeDocument(strToU8("nope"))).toThrow(FileFormatError);
  });

  it("refuses documents whose lists have the wrong shape", () => {
    expect(() => migrate({ schema: 2, features: "x" })).toThrow(FileFormatError);
    expect(() => migrate({ schema: 2, parameters: 5 })).toThrow(FileFormatError);
    expect(() => migrate({ schema: 2, bodies: [] })).toThrow(FileFormatError);
  });

  it("fills in a missing name", () => {
    expect(migrate({ schema: 2 }).name).toBe("Untitled");
  });
});
