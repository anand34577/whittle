/** Findings of the deep audit (October 2026): formulas, step relationships and damaged files. */
import { describe, expect, it } from "vitest";
import {
  type Feature,
  type Parameter,
  type WhittleDocument,
  bodyIdsBefore,
  createEvaluator,
  createsBody,
  featureInputs,
  isSketchConsumed,
  migrate,
  newDocument,
  renameParameter,
  reorderProblem,
  validateParamName,
} from "../src";

const ev = (expr: string, unit: "mm" | "in" = "mm") => createEvaluator([], unit).eval(expr, "length");

describe("mixed-unit lengths", () => {
  it("reads feet and inches written together as a sum", () => {
    const mm = (e: string) => {
      const r = ev(e);
      return r.ok ? r.value : NaN;
    };
    expect(mm(`5' 6"`)).toBeCloseTo(66 * 25.4, 9);
    expect(mm("1 m 20 cm")).toBeCloseTo(1200, 9);
    expect(mm(`2 * 1 ft 6 in`)).toBeCloseTo(2 * 18 * 25.4, 9);
  });

  it("still refuses a bare number after a length", () => {
    expect(ev("5 mm 6").ok).toBe(false);
  });
});

describe("parameter names", () => {
  it("can't take a unit word, since it would be read as the unit", () => {
    for (const n of ["mil", "thou", "yd", "um", "inch"]) expect(validateParamName(n, [])).toMatch(/reserved/);
  });

  it("renaming leaves a function of the same name alone", () => {
    const doc = {
      parameters: [
        { id: "a", name: "max", expr: "10", kind: "length" },
        { id: "b", name: "w", expr: "max(max, 4) + max", kind: "length" },
      ] as Parameter[],
      features: [] as Feature[],
    };
    renameParameter(doc, "max", "limit");
    expect(doc.parameters[1]!.expr).toBe("max(limit, 4) + limit");
  });
});

describe("step relationships", () => {
  const box = { id: "b1", type: "primitive", name: "Box 1", shape: "box", op: "new" } as unknown as Feature;
  const hole = { id: "e1", type: "extrude", name: "Extrude 1", sketch: "s1", op: "cut", extent: "one" } as unknown as Feature;

  it("a mirror or pattern of steps depends on those steps", () => {
    const mirror = { id: "m1", type: "mirror", name: "Mirror 1", plane: "XY", merge: true, features: ["e1"] } as unknown as Feature;
    const pattern = { id: "p1", type: "pattern", name: "Pattern 1", pattern: "linear", merge: true, features: ["e1"], axisGeom: { edge: { bodyId: "b1" } } } as unknown as Feature;
    expect(featureInputs(mirror)).toContain("e1");
    expect(featureInputs(pattern)).toEqual(expect.arrayContaining(["e1", "b1"]));
    const doc = { ...newDocument(), features: [box, hole, pattern] } as WhittleDocument;
    expect(reorderProblem(doc, 2, 1)).toMatch(/Pattern 1 uses Extrude 1/);
  });

  it("an extrude up to a face depends on that body", () => {
    const up = { id: "e2", type: "extrude", name: "Extrude 2", sketch: "s2", op: "join", extent: "face", toFace: { bodyId: "b9" } } as unknown as Feature;
    expect(featureInputs(up)).toContain("b9");
  });

  it("every step that makes a body gets one", () => {
    const rib = { id: "r1", type: "rib", sketch: "s1", op: "new" } as unknown as Feature;
    const patch = { id: "sf", type: "surface", op: "patch" } as unknown as Feature;
    const trim = { id: "st", type: "surface", op: "trim" } as unknown as Feature;
    const fill = { id: "bf", type: "boundaryFill" } as unknown as Feature;
    expect([rib, patch, fill].every((f) => createsBody(f))).toBe(true);
    expect(createsBody(trim)).toBe(false);
    // A surface made by extruding or sweeping is a body of its own even when its op is join.
    expect(createsBody({ id: "x", type: "extrude", op: "join", surface: true } as unknown as Feature)).toBe(true);
    expect(createsBody({ id: "w", type: "sweep", op: "join", surface: true } as unknown as Feature)).toBe(true);
    expect(createsBody({ id: "m", type: "mirror", merge: false, features: ["e1"] } as unknown as Feature)).toBe(false);
    // A join with nothing to join makes the first body.
    const join = { id: "j1", type: "primitive", op: "join" } as unknown as Feature;
    expect(bodyIdsBefore({ ...newDocument(), features: [join, { ...join, id: "j2" }] } as WhittleDocument)).toEqual(["j1"]);
  });

  it("a rib uses up its sketch", () => {
    const doc = { ...newDocument(), features: [{ id: "r1", type: "rib", sketch: "s1" } as unknown as Feature] } as WhittleDocument;
    expect(isSketchConsumed(doc, "s1")).toBe(true);
  });
});

describe("damaged files", () => {
  it("repairs units, the rollback marker and parameter fields", () => {
    const d = migrate({ schema: 3, units: "furlong", rollback: "2", parameters: [{ name: "w", expr: 12 }], features: [] });
    expect(d.units).toBe("mm");
    expect(d.rollback).toBeNull();
    expect(d.parameters[0]).toMatchObject({ name: "w", expr: "12", kind: "length" });
    expect(typeof d.parameters[0]!.id).toBe("string");
    expect(createEvaluator(d.parameters, d.units).params.get("w")).toEqual({ ok: true, value: 12 });
  });
});
