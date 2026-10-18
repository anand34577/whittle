/** 2D drawing export/import helpers (the DOM-free parts). */
import { describe, expect, it } from "vitest";
import { type SketchEntity, createEvaluator, uid } from "@whittle/core";
import { loopsToEntities, shapesToDxf, shapesToSvg, simplify, sketchShapes, splitAtJumps } from "../src/state/drawings";

const ev = createEvaluator([], "mm");

describe("sketch export", () => {
  const entities: SketchEntity[] = [
    { id: uid(), type: "rect", x: "0", y: "0", w: "40", h: "20", anchor: "center" },
    { id: uid(), type: "circle", cx: "10", cy: "0", r: "3" },
    { id: uid(), type: "circle", cx: "-10", cy: "0", r: "3", construction: true },
    { id: uid(), type: "text", x: "0", y: "0", text: "Hi", size: "5", angle: "0" },
  ];

  it("keeps circles exact and skips construction and text (the geometry engine outlines text)", () => {
    const { shapes, skipped } = sketchShapes(entities, ev);
    expect(shapes).toHaveLength(2);
    expect(shapes[1]!.circle).toEqual({ cx: 10, cy: 0, r: 3 });
    expect(skipped).toBe(0);
  });

  it("writes true-size SVG and a well-formed DXF", () => {
    const { shapes } = sketchShapes(entities, ev);
    const svg = shapesToSvg(shapes, "Plate & <co>");
    expect(svg).toContain('width="42mm"');
    expect(svg).toContain('<circle cx="31" cy="11" r="3"/>');
    expect(svg).toContain("Plate &amp; &lt;co&gt;");
    const dxf = shapesToDxf(shapes).split("\n");
    expect(dxf.filter((l) => l === "CIRCLE")).toHaveLength(1);
    expect(dxf.filter((l) => l === "VERTEX")).toHaveLength(4);
    expect(dxf.at(-2)).toBe("EOF");
  });
});

describe("svg import", () => {
  it("splits subpaths where the pen jumps", () => {
    const pts: [number, number][] = [[0, 0], [1, 0], [2, 0], [10, 10], [11, 10]];
    expect(splitAtJumps(pts, 1).map((l) => l.length)).toEqual([3, 2]);
  });

  it("simplifies straight runs and keeps corners", () => {
    const line: [number, number][] = [];
    for (let i = 0; i <= 10; i++) line.push([i, 0]);
    for (let i = 1; i <= 10; i++) line.push([10, i]);
    expect(simplify(line, 0.01)).toEqual([[0, 0], [10, 0], [10, 10]]);
  });

  it("scales loops to the requested width, flips y and drops specks", () => {
    const square: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
    const speck: [number, number][] = [[50, 50], [50.01, 50], [50.01, 50.01]];
    const out = loopsToEntities([square, speck], 20);
    expect(out).toHaveLength(1);
    const e = out[0]!;
    if (e.type !== "polyline") throw new Error("expected an outline");
    expect(e.points).toEqual([["-10", "10"], ["10", "10"], ["10", "-10"], ["-10", "-10"]]);
  });
});
