import { describe, expect, it } from "vitest";
import {
  type ConstructFeature, type CsysFeature, type SketchFeature, type Vec3,
  dependents, deserializeDocument, makeConstruct, makeConstructionPlane, makeCsys, makeSketch,
  newDocument, renameParameter, reorderProblem, serializeDocument,
} from "@whittle/core";
import { Builder } from "../src/build";

function fixture() {
  const doc = newDocument();
  doc.parameters.push({ id: "height", name: "height", expr: "4 mm", kind: "length" });
  const add = <T extends (typeof doc.features)[number]>(feature: T) => {
    doc.features.push(feature);
    return feature;
  };
  const plane = add(makeConstructionPlane(doc, { kind: "origin", plane: "XY", offset: "height" }));
  function construct(mode: ConstructFeature["mode"], points: Vec3[] = []) {
    return add({ ...makeConstruct(doc, mode), points } as ConstructFeature);
  }
  const vertical = construct("axis2p", [[0, 0, 0], [0, 0, 10]]);
  const origin = construct("pointEdgePlane");
  origin.refs = { planes: [{ kind: "plane", id: plane.id }], lines: [{ kind: "axis", id: vertical.id }], points: [] };
  const z = construct("axis2p");
  z.refs = { planes: [], lines: [], points: [{ kind: "point", id: origin.id }, { kind: "xyz", at: [0, 6, 10] }] };
  const x = construct("axis2p", [[0, 0, 0], [10, 0, 5]]);
  const csys = add(makeCsys(doc));
  csys.mode = "references";
  csys.refs = { origin: { kind: "point", id: origin.id }, z: { kind: "axis", id: z.id }, x: { kind: "axis", id: x.id } };
  const sketch = add(makeSketch(doc, { kind: "csys", csys: csys.id, plane: "XZ", offset: "0" }) as SketchFeature);
  return { doc, plane, origin, z, x, csys, sketch };
}

function expectVector(actual: Vec3, expected: Vec3) {
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 10));
}

describe("datum coordinate systems", () => {
  it("uses world coordinates and right-hand rotations in fixed X, Y, Z order", () => {
    const doc = newDocument("Manual", "in");
    doc.parameters.push({ id: "rise", name: "rise", expr: "2 in", kind: "length" });
    const csys = makeCsys(doc);
    csys.position = ["1", "10 mm", "rise"];
    csys.rotation = ["90", "90", "90"];
    doc.features.push(csys);
    renameParameter(doc, "rise", "height");
    expect(csys.position[2]).toBe("height");
    const r = new Builder().regen(doc, "final");
    expect(r.status[0]!.state).toBe("ok");
    const frame = r.planes[0]!;
    expect(frame.kind).toBe("csys");
    expectVector(frame.origin, [25.4, 10, 50.8]);
    expectVector(frame.xDir, [0, 0, -1]);
    expectVector(frame.yDir, [0, 1, 0]);
    expectVector(frame.normal, [1, 0, 0]);
  });

  it("rebuilds a point → axis → CSYS → sketch chain, including after save and reopen", () => {
    const { doc, plane, origin, z, csys, sketch } = fixture();
    doc.datumVisibility = { categories: { csys: false }, items: { [csys.id]: false } };
    expect(dependents(doc, plane.id).map((f) => f.id)).toEqual([origin.id, z.id, csys.id, sketch.id]);
    expect(reorderProblem(doc, doc.features.indexOf(csys), doc.features.indexOf(z))).toBeTruthy();
    const builder = new Builder();
    const before = builder.regen(doc, "final");
    expect(before.status.map((s) => s.state)).toEqual(doc.features.map(() => "ok"));
    const beforeFrame = before.planes.find((p) => p.id === csys.id)!;
    expectVector(beforeFrame.origin, [0, 0, 4]);
    expectVector(beforeFrame.normal, [0, Math.SQRT1_2, Math.SQRT1_2]);
    const beforeSketch = before.sketches[0]!;
    expectVector(beforeSketch.xDir, beforeFrame.xDir);
    expectVector(beforeSketch.yDir, beforeFrame.normal);
    expectVector(beforeSketch.normal, beforeFrame.yDir.map((v) => -v) as Vec3);

    const reopened = deserializeDocument(serializeDocument(doc));
    expect(reopened.features).toEqual(doc.features);
    expect(reopened.datumVisibility).toEqual(doc.datumVisibility);
    const rebuilt = new Builder().regen(reopened, "final");
    expect(rebuilt.sketches).toEqual(before.sketches);
    reopened.parameters[0]!.expr = "10 mm";
    for (const engine of [builder, new Builder()]) {
      const after = engine.regen(reopened, "final");
      expect(after.status.map((s) => s.state)).toEqual(doc.features.map(() => "ok"));
      expectVector(after.sketches[0]!.origin, [0, 0, 10]);
      expectVector(after.sketches[0]!.yDir, [0, 1, 0]);
    }
  });

  it("projects X, honors both flips, and uses right-handed principal planes", () => {
    const { doc, plane, csys, sketch } = fixture();
    csys.refs.z = { kind: "plane", id: plane.id };
    csys.flipX = csys.flipZ = true;
    const builder = new Builder();
    for (const [name, x, y, z] of [
      ["XY", [-1, 0, 0], [0, 1, 0], [0, 0, -1]],
      ["XZ", [-1, 0, 0], [0, 0, -1], [0, -1, 0]],
      ["YZ", [0, 1, 0], [0, 0, -1], [-1, 0, 0]],
    ] as const) {
      if (sketch.plane.kind !== "csys") throw new Error("Expected a CSYS sketch");
      sketch.plane.plane = name;
      sketch.plane.offset = "2 mm";
      const result = builder.regen(doc, "final");
      const frame = result.sketches[0]!;
      expectVector(frame.xDir, [...x]);
      expectVector(frame.yDir, [...y]);
      expectVector(frame.normal, [...z]);
      expectVector(frame.origin, [z[0] * 2, z[1] * 2, 4 + z[2] * 2]);
    }
  });

  const invalid: [string, (f: ReturnType<typeof fixture>) => void, string, "error" | "incomplete"][] = [
    ["unassigned", ({ csys }) => { delete csys.refs.origin; }, "Pick a datum point", "incomplete"],
    ["missing", ({ csys }) => { csys.refs.origin!.id = "missing"; }, "must exist", "error"],
    ["wrong declared kind", ({ csys, x }) => { csys.refs.origin = { kind: "axis", id: x.id } as unknown as CsysFeature["refs"]["origin"]; }, "Expected a datum point", "error"],
    ["wrong resolved kind", ({ csys, x }) => { csys.refs.origin!.id = x.id; }, "Expected a datum point", "error"],
    ["forward", ({ doc, x }) => { doc.features.splice(doc.features.indexOf(x), 1); doc.features.push(x); }, "earlier", "error"],
    ["self", ({ csys }) => { csys.refs.origin!.id = csys.id; }, "itself", "error"],
    ["cycle", ({ doc, csys }) => {
      const after = makeConstructionPlane(doc, { kind: "csys", csys: csys.id, plane: "XY", offset: "0" });
      doc.features.push(after);
      csys.refs.z = { kind: "plane", id: after.id };
    }, "earlier", "error"],
    ["suppressed", ({ origin }) => { origin.suppressed = true; }, "unsuppressed", "error"],
    ["zero direction", ({ x }) => { x.points = [[0, 0, 0], [0, 0, 0]]; }, "build successfully", "error"],
    ["parallel", ({ csys, z }) => { csys.refs.x = { kind: "axis", id: z.id }; }, "parallel", "error"],
  ];
  it.each(invalid)("rejects %s references and does not expose a stale frame", (_, alter, message, state) => {
    const f = fixture();
    const builder = new Builder();
    expect(builder.regen(f.doc, "final").sketches).toHaveLength(1);
    alter(f);
    const result = builder.regen(f.doc, "final");
    expect(result.status.find((s) => s.id === f.csys.id)).toMatchObject({ state, message: expect.stringContaining(message) });
    expect(result.planes.some((p) => p.id === f.csys.id)).toBe(false);
    expect(result.sketches).toHaveLength(0);
  });
});
