import { describe, expect, it } from "vitest";
import { type SketchEntity, createEvaluator, resolveEntity } from "../src";

const ev = createEvaluator([], "mm");
const rect = (corner: string) => ({ id: "r", type: "rect", x: "0", y: "0", w: "40", h: "20", corner, angle: "0", anchor: "corner", mode: "add" }) as unknown as SketchEntity;

describe("corner radius limits", () => {
  it("holds a rectangle's rounding at half its short side instead of failing", () => {
    const r = resolveEntity(rect("500"), ev);
    expect(r.type === "rect" && r.corner).toBeLessThan(10);
    expect(r.type === "rect" && r.corner).toBeGreaterThan(9.9);
  });
  it("leaves a radius that fits alone", () => {
    const r = resolveEntity(rect("3"), ev);
    expect(r.type === "rect" && r.corner).toBe(3);
  });
  it("holds a square outline's rounding to what its sides allow", () => {
    const e = { id: "p", type: "polyline", points: [["0", "0"], ["20", "0"], ["20", "20"], ["0", "20"]], corner: "500", mode: "add" } as unknown as SketchEntity;
    const r = resolveEntity(e, ev);
    expect(r.type === "polyline" && r.corner).toBeLessThanOrEqual(10);
    expect(r.type === "polyline" && r.corner).toBeGreaterThan(9.9);
  });
});
