/** Move/copy, scale, grid pattern and break of constraint geometry. */
import { beforeAll, describe, expect, it } from "vitest";
import { type SketchFeature, addEntityGeometry, breakLine, createEvaluator, makeEntity, makeSketch, moveGeometry, newDocument, rectPattern, resolveEntity, resolveGeometry, scaleGeometry } from "@whittle/core";
import { initSolver } from "../src/solver";

beforeAll(async () => {
  await initSolver();
});

const ev = createEvaluator([], "mm");
const sketch = () => makeSketch(newDocument(), { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
const rect = (sk: SketchFeature) => addEntityGeometry(sk, resolveEntity(makeEntity("rect", [0, 0], [10, 5]), ev));
const ids = (sk: SketchFeature) => sk.geometry!.filter((g) => g.type !== "point").map((g) => g.id);
const lineCount = (sk: SketchFeature) => resolveGeometry(sk).filter((g) => g.type === "line").length;

describe("sketch edit", () => {
  it("copies a rectangle into a 3 x 2 grid", () => {
    const sk = sketch();
    rect(sk);
    expect(rectPattern(sk, ids(sk), 3, 2, 20, 20)).toBeUndefined();
    expect(lineCount(sk)).toBe(24);
  });

  it("moves in place or adds a copy", () => {
    const sk = sketch();
    rect(sk);
    expect(moveGeometry(sk, ids(sk), 5, 0, true)).toBeUndefined();
    expect(lineCount(sk)).toBe(8);
    expect(moveGeometry(sk, ids(sk), 0, 0, false)).toBeDefined();
  });

  it("scales positions about a base point", () => {
    const sk = sketch();
    rect(sk);
    expect(scaleGeometry(sk, ids(sk), 2, [0, 0])).toBeUndefined();
    const xs = resolveGeometry(sk).flatMap((g) => (g.type === "line" ? [g.a[0], g.b[0]] : []));
    expect(Math.max(...xs)).toBeCloseTo(20);
  });

  it("breaks a line where another crosses it", () => {
    const sk = sketch();
    rect(sk);
    const lines = sk.geometry!.filter((g) => g.type === "line");
    const bottom = lines.find((g) => g.type === "line" && resolveGeometry(sk).some((r) => r.id === g.id && r.type === "line" && r.a[1] === 0 && r.b[1] === 0))!;
    // A vertical cutter through the middle of the bottom edge.
    const cut = makeEntity("polyline", [5, -2], [5, 8]);
    if (cut.type === "polyline") cut.open = true;
    addEntityGeometry(sk, resolveEntity(cut, ev));
    const cutter = sk.geometry!.filter((g) => g.type === "line").pop()!;
    const before = lineCount(sk);
    expect(breakLine(sk, bottom.id, cutter.id)).toBeUndefined();
    expect(lineCount(sk)).toBe(before + 1);
  });
});
